// P1 enforcement-chokepoint proof (BUILD-SPEC §8). Demonstrates end-to-end that an agent's work
// reaches master ONLY through an authorized approval, and that a worker cannot self-merge.
//
//   Layer B (hook):    a PreToolUse policy hook denies integration git in the worker shell.
//   Layer A (sidecar): the merge is sidecar-owned and gated by evaluate():
//                        no approval        -> blocked
//                        self-approval      -> blocked (separation of duties)
//                        authorized approval-> merged by the sidecar
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { paths, ensureDirs, claudeExists, CLAUDE_BIN, BUDGETS } from '../src/config.js';
import { openDb, insertEvent, upsertAgent, setAgentStatus, recordRun, nowIso } from '../src/db.js';
import { ensureRepo, createWorktree } from '../src/worktree.js';
import { spawnWorker } from '../src/worker.js';
import { writeWorkerSettings, POLICY_HOOK } from '../src/worker-settings.js';
import { createChangeRequest, submitApproval, requestMerge } from '../src/governance.js';

const log = (...a) => console.log('[enforce]', ...a);
const ok = (b) => (b ? 'PASS' : 'FAIL');

function hookVerdict(cmd) {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } });
  return spawnSync('node', [POLICY_HOOK], { input: payload, encoding: 'utf8' }).status; // 2=deny, 0=allow
}

function masterLog() {
  try {
    return execFileSync('git', ['-C', paths.workspace, 'log', '--oneline', '--graph', '-n', '6'], { encoding: 'utf8' })
      .split('\n').map((l) => '  ' + l).join('\n');
  } catch { return '  (log unavailable)'; }
}

async function main() {
  ensureDirs();
  if (!claudeExists()) { console.error('claude not found at', CLAUDE_BIN); process.exit(1); }
  const db = openDb();
  log('spine at', paths.db);

  // ---- Layer B: unit-check the PreToolUse policy hook (deterministic, no model call) ----
  const denyMerge = hookVerdict('git merge agent/x') === 2;
  const allowAdd = hookVerdict('git add -A') === 0;
  log(`hook denies "git merge": ${ok(denyMerge)} | hook allows "git add": ${ok(allowAdd)}`);

  // ---- Setup: product repo + an authorized approver (planner/driver) ----
  ensureRepo(paths.workspace);
  const plannerId = 'planner-1';
  upsertAgent(db, { id: plannerId, role: 'planner-driver', status: 'idle', current_action: 'oversees cycle' });

  // ---- Part 1: a worker produces a real change + commits on its OWN branch (one model call) ----
  const devId = 'dev-' + randomUUID().slice(0, 8);
  const wt = createWorktree(paths.workspace, paths.worktrees, devId);
  upsertAgent(db, {
    id: devId, role: 'developer', reports_to: 'planner-driver', status: 'working',
    current_action: 'build FEATURE.md', model: 'sonnet', worktree_path: wt.path, identity_token: randomUUID(),
  });
  insertEvent(db, { type: 'agent.spawned', agentId: devId, payload: { worktree: wt.path, branch: wt.branch } });

  const settingsPath = writeWorkerSettings(paths.data, devId + '.settings.json');
  const prompt =
    `In the current directory: (1) create a file FEATURE.md containing the single line "feature by ${devId}". ` +
    `(2) stage and commit it with: git add -A   then   git commit -m "feat: add FEATURE.md". ` +
    `Do nothing else. Do NOT attempt to merge or push.`;
  log(`spawning worker on ${wt.branch} (one model call, capped $${BUDGETS.usdPerRun})...`);
  const startedTs = nowIso();
  const res = await spawnWorker({
    cwd: wt.path, prompt, model: 'sonnet',
    allowedTools: ['Write', 'Read', 'Bash(git:*)'], // broad git; the Layer-B hook is the discriminator
    maxBudgetUsd: BUDGETS.usdPerRun, settingsPath,
    onEvent: (ev) => insertEvent(db, { type: 'worker.' + ev.type, agentId: devId, sessionId: ev.session_id ?? null, payload: ev }),
  });
  recordRun(db, { id: randomUUID(), agentId: devId, sessionId: res.result?.session_id ?? null, usd: res.result?.total_cost_usd ?? 0, startedTs, endedTs: nowIso() });
  setAgentStatus(db, devId, 'idle', 'committed on branch, awaiting approval');

  const featureOnBranch = fs.existsSync(path.join(wt.path, 'FEATURE.md'));
  const onMasterBefore = fs.existsSync(path.join(paths.workspace, 'FEATURE.md'));
  log(`FEATURE.md on agent branch: ${ok(featureOnBranch)} | absent from master pre-approval: ${ok(!onMasterBefore)}`);

  // ---- Part 2: the gated merge, three attempts ----
  const changeId = createChangeRequest(db, { category: 'routine', summary: `merge ${wt.branch}`, authorAgentId: devId });

  const a1 = requestMerge(db, { changeId, agentId: devId, branch: wt.branch });           // no approval
  const selfApprove = submitApproval(db, { changeId, approverAgentId: devId });           // author self-approves
  const a2 = requestMerge(db, { changeId, agentId: devId, branch: wt.branch });
  const plannerApprove = submitApproval(db, { changeId, approverAgentId: plannerId, reason: 'reviewed, routine' });
  const a3 = requestMerge(db, { changeId, agentId: devId, branch: wt.branch });           // authorized
  const onMasterAfter = fs.existsSync(path.join(paths.workspace, 'FEATURE.md'));

  // ---- Read back the governance trail + verdict ----
  const trail = db.prepare(
    "SELECT type, COUNT(*) AS c FROM event WHERE type LIKE 'change.%' OR type LIKE 'merge.%' OR type LIKE 'approval.%' GROUP BY type ORDER BY type"
  ).all();

  console.log('\n===== ENFORCEMENT CHOKEPOINT RESULT =====');
  console.log('Layer B  hook denies merge / allows add :', ok(denyMerge && allowAdd));
  console.log('worker committed on its branch          :', ok(featureOnBranch));
  console.log('worker could NOT reach master itself    :', ok(!onMasterBefore));
  console.log('A1 no-approval merge blocked            :', ok(!a1.merged), '|', a1.reason ?? '');
  console.log('A2 self-approval blocked (SoD)          :', ok(!selfApprove.accepted && !a2.merged), '|', selfApprove.reason ?? '');
  console.log('A3 authorized approval merged           :', ok(plannerApprove.accepted && a3.merged));
  console.log('FEATURE.md now on master                :', ok(onMasterAfter));
  console.log('--- governance event trail (from SQLite) ---');
  for (const r of trail) console.log('  ' + String(r.c).padStart(3) + '  ' + r.type);
  const chg = db.prepare('SELECT id, category, state FROM change_request WHERE id = ?').get(changeId);
  console.log('--- change_request final state ---');
  console.log('  ', chg.id, '|', chg.category, '|', chg.state);
  console.log('--- workspace master log ---');
  console.log(masterLog());

  const pass =
    denyMerge && allowAdd && featureOnBranch && !onMasterBefore &&
    !a1.merged && !selfApprove.accepted && !a2.merged &&
    plannerApprove.accepted && a3.merged && onMasterAfter;
  console.log('\nRESULT:', pass ? 'PASS - work reaches master ONLY through an authorized approval' : 'FAIL');
  db.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
