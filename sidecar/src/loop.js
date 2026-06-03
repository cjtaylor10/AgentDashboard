// The council loop (BUILD-SPEC §7) — one governed cycle:
//   GOAL_INTAKE -> PLAN -> TICKET -> ASSIGN -> DEV -> TEST -> AUDIT -> CHANGE_APPROVAL -> GOAL_REALIGN -> STOP
// Driven by the sidecar; Claude agents reason inside each state. Budget + kill switch are checked before
// every model call so a runaway or a PAUSE-ALL halts the loop mid-cycle.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { paths, BUDGETS } from './config.js';
import { insertEvent, upsertAgent, setAgentStatus, recordRun, nowIso, isKilled } from './db.js';
import { ensureRepo, createWorktree, commitAll } from './worktree.js';
import { spawnWorker } from './worker.js';
import { writeWorkerSettings } from './worker-settings.js';
import { ROLES } from './roles.js';
import { createChangeRequest, submitApproval, requestMerge } from './governance.js';

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return ''; }
}

function extractJson(text) {
  if (!text) return null;
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const lastBrace = text.lastIndexOf('{');
  if (lastBrace >= 0) candidates.push(text.slice(lastBrace));
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return JSON.parse(candidates[i].trim()); } catch { /* try next */ }
  }
  return null;
}

function jsonSuffix(shape) {
  return "\n\nEnd your message with ONLY a fenced json block (nothing after it):\n```json\n" + shape + "\n```";
}

// --- synchronous brakes, checked before every model call ---
function assertCanSpend(db) {
  if (isKilled(db)) throw new Error('global kill switch is engaged — loop halted');
  const spent = db.prepare('SELECT COALESCE(SUM(usd), 0) AS s FROM run').get().s;
  if (spent > BUDGETS.usdPerCycle) throw new Error(`cycle budget exceeded ($${spent.toFixed(2)} > $${BUDGETS.usdPerCycle})`);
}

async function runRole(db, { roleKey, agentId, cwd, prompt, settingsPath, cycleId }) {
  assertCanSpend(db);
  const role = ROLES[roleKey];
  setAgentStatus(db, agentId, 'working', `${roleKey}: thinking`);
  const startedTs = nowIso();
  const res = await spawnWorker({
    cwd, prompt, charter: role.charter, model: role.model, allowedTools: role.tools,
    maxBudgetUsd: BUDGETS.usdPerRun, settingsPath,
    onEvent: (ev) => insertEvent(db, { type: 'worker.' + ev.type, agentId, sessionId: ev.session_id ?? null, payload: ev }),
  });
  recordRun(db, { id: randomUUID(), cycleId, agentId, sessionId: res.result?.session_id ?? null, usd: res.result?.total_cost_usd ?? 0, startedTs, endedTs: nowIso() });
  setAgentStatus(db, agentId, 'idle', `${roleKey}: done`);
  return { res, json: extractJson(res.result?.result), cost: res.result?.total_cost_usd ?? 0 };
}

export async function runCycle(db, { goalText }) {
  const cycleId = 'cyc-' + randomUUID().slice(0, 8);
  const at = (state, payload = {}) => insertEvent(db, { type: 'cycle.' + state, payload: { cycleId, ...payload } });
  const base = { cycleId, goalId: null, ticketId: null, changeId: null, testPass: false, aligned: false, merged: false, advanced: false };

  ensureRepo(paths.workspace);
  const settingsPath = writeWorkerSettings(paths.data, cycleId + '.settings.json');

  // GOAL_INTAKE — the Chair sets the goal
  const goalId = 'goal-' + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO goal (id, text, owner_role, status, created_ts) VALUES (?,?, 'chair', 'active', ?)").run(goalId, goalText, nowIso());
  at('goal_intake', { goalId });
  base.goalId = goalId;

  // register the standing oversight agents (independent of the dev chain)
  const planner = 'planner-' + randomUUID().slice(0, 6);
  const auditor = 'auditor-' + randomUUID().slice(0, 6);
  upsertAgent(db, { id: planner, role: 'planner-driver', reports_to: 'chair', status: 'idle', model: ROLES['planner-driver'].model });
  upsertAgent(db, { id: auditor, role: 'auditor', reports_to: 'chair', status: 'idle', model: ROLES.auditor.model });

  // PLAN
  at('plan');
  const plan = await runRole(db, {
    roleKey: 'planner-driver', agentId: planner, cwd: paths.workspace, settingsPath, cycleId,
    prompt: "The Chair's goal:\n" + goalText +
      "\n\nDecompose this into the SMALLEST set of tickets that fully satisfies it — ideally ONE ticket for a goal this size. Do not invent extra work. Each ticket needs concrete, machine-checkable done_criteria." +
      jsonSuffix('{"rationale":"...","tickets":[{"subject":"...","description":"...","done_criteria":"..."}]}'),
  });
  const tickets = (plan.json?.tickets ?? []).slice(0, 1); // MVP: take the first ticket through the full cycle
  if (!tickets.length) { at('aborted', { reason: 'planner produced no tickets' }); return base; }
  const t = tickets[0];

  // TICKET
  const ticketId = 'tkt-' + randomUUID().slice(0, 8);
  db.prepare("INSERT INTO ticket (id, subject, description, status, kanban_column, goal_id, created_ts) VALUES (?,?,?, 'pending', 'Todo', ?, ?)")
    .run(ticketId, t.subject ?? 'untitled', JSON.stringify({ description: t.description ?? '', done_criteria: t.done_criteria ?? '' }), goalId, nowIso());
  at('ticket', { ticketId, subject: t.subject });
  base.ticketId = ticketId;

  // ASSIGN — spawn a developer on a fresh, isolated worktree
  const devId = 'dev-' + randomUUID().slice(0, 8);
  const wt = createWorktree(paths.workspace, paths.worktrees, devId);
  upsertAgent(db, { id: devId, role: 'developer', reports_to: 'planner-driver', parent_agent_id: planner, status: 'working', model: ROLES.developer.model, worktree_path: wt.path });
  db.prepare("UPDATE ticket SET status='in_progress', owner=?, kanban_column='In Progress' WHERE id=?").run(devId, ticketId);
  at('assign', { ticketId, devId, branch: wt.branch });

  // DEV — build + commit on the worktree branch
  const dev = await runRole(db, {
    roleKey: 'developer', agentId: devId, cwd: wt.path, settingsPath, cycleId,
    prompt: "Implement this ticket in the current directory (your isolated git worktree):\n\nSUBJECT: " + (t.subject ?? '') +
      "\nDETAILS: " + (t.description ?? '') + "\nDONE WHEN: " + (t.done_criteria ?? '') +
      "\n\nWrite the necessary files, then stage and commit: git add -A  then  git commit -m \"feat: <subject>\". Do NOT merge or push." +
      jsonSuffix('{"summary":"...","files_changed":["..."],"committed":true}'),
  });
  commitAll(wt.path, `chore(${devId}): capture work for ${ticketId}`); // safety net: ensure the branch holds the work
  at('dev_done', { devId, summary: dev.json?.summary ?? null });

  // TEST — outcome-based, runs in the dev's worktree
  const tester = 'tester-' + randomUUID().slice(0, 6);
  upsertAgent(db, { id: tester, role: 'tester', reports_to: 'planner-driver', status: 'working', model: ROLES.tester.model, worktree_path: wt.path });
  db.prepare("UPDATE ticket SET kanban_column='In Review' WHERE id=?").run(ticketId);
  const test = await runRole(db, {
    roleKey: 'tester', agentId: tester, cwd: wt.path, settingsPath, cycleId,
    prompt: "The deliverable is in the current directory. Verify the ticket by DEMONSTRATED behavior — actually RUN it, do not trust descriptions.\n\nDONE WHEN: " +
      (t.done_criteria ?? '') + "\n\nRun the relevant command(s) and observe the real output." +
      jsonSuffix('{"pass":true,"evidence":"<the actual command output you observed>","checks":["..."]}'),
  });
  const testPass = test.json?.pass === true;
  at('test', { tester, pass: testPass, evidence: test.json?.evidence ?? null });
  base.testPass = testPass;

  // AUDIT — independent; expectation-first, checks planned-vs-built against the diff + tester evidence
  const diff = git(wt.path, ['diff', 'master', '--', '.']).slice(0, 4000);
  const audit = await runRole(db, {
    roleKey: 'auditor', agentId: auditor, cwd: wt.path, settingsPath, cycleId,
    prompt: "First state, in one sentence, the outcome you EXPECT if this ticket was done correctly. THEN verify — do not rubber-stamp.\n\nGOAL: " + goalText +
      "\nDONE WHEN: " + (t.done_criteria ?? '') + "\nTESTER REPORTED: " + JSON.stringify(test.json ?? {}) +
      "\n\nGIT DIFF (what was actually built):\n" + (diff || '(empty diff)') +
      "\n\nDoes the diff actually satisfy the done_criteria, and does the tester's evidence support PASS?" +
      jsonSuffix('{"expected":"...","planned_vs_built":"match|deviation","aligned":true,"findings":["..."],"verdict":"approve_recommended|reopen"}'),
  });
  const aligned = audit.json?.aligned === true && audit.json?.planned_vs_built !== 'deviation';
  at('audit', { auditor, aligned, verdict: audit.json?.verdict ?? null });
  base.aligned = aligned;

  // CHANGE_APPROVAL — only on demonstrated success; the Planner exercises routine approval authority,
  // and the merge still passes through the sidecar gate (authority + separation of duties + budget).
  const changeId = createChangeRequest(db, { category: 'routine', summary: `merge ${wt.branch} for ${ticketId}`, authorAgentId: devId });
  base.changeId = changeId;
  if (testPass && aligned) {
    submitApproval(db, { changeId, approverAgentId: planner, reason: 'tester PASS + auditor ALIGNED' });
    const m = requestMerge(db, { changeId, agentId: devId, branch: wt.branch });
    base.merged = m.merged;
    if (m.merged) db.prepare("UPDATE ticket SET status='completed', kanban_column='Done' WHERE id=?").run(ticketId);
    at('change_approval', { changeId, merged: m.merged });
  } else {
    db.prepare("UPDATE ticket SET status='pending', kanban_column='Blocked' WHERE id=?").run(ticketId);
    insertEvent(db, { type: 'ticket.reopened', agentId: planner, payload: { ticketId, reason: `testPass=${testPass}, aligned=${aligned}` } });
    at('change_approval', { changeId, merged: false, reason: 'withheld — verification not satisfied' });
  }

  // GOAL_REALIGN — did the cycle advance the goal? (independent check already done by the auditor)
  base.advanced = base.merged && aligned;
  if (base.advanced) db.prepare("UPDATE goal SET status='advanced' WHERE id=?").run(goalId);
  at('goal_realign', { advanced: base.advanced });
  at('stop', { advanced: base.advanced });

  base.agents = { planner, devId, tester, auditor };
  base.branch = wt.branch;
  return base;
}
