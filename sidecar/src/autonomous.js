// Autonomous direction: the CEO/management chooses the next improvement themselves.
// When the Chair sets no explicit goal, a CEO agent reviews the Chair's Ideas inbox + recent state and
// proposes the single most valuable next goal — adopting, refining, or rejecting a Chair idea, or
// proposing its own (it knows the system better than the Chair). The normal gated cycle then builds it.
import { randomUUID } from 'node:crypto';
import { paths, BUDGETS } from './config.js';
import { insertEvent, upsertAgent, setAgentStatus, recordRun, nowIso, listIdeas } from './db.js';
import { spawnWorker } from './worker.js';
import { writeWorkerSettings } from './worker-settings.js';
import { ROLES } from './roles.js';

function extractJson(text) {
  if (!text) return null;
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const lastBrace = text.lastIndexOf('{');
  if (lastBrace >= 0) candidates.push(text.slice(lastBrace));
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return JSON.parse(candidates[i].trim()); } catch { /* next */ }
  }
  return null;
}

// Spawn the CEO/management to choose the next goal from the Ideas inbox + recent state.
export async function proposeGoal(db, { targetRepo = paths.root } = {}) {
  const ideas = listIdeas(db).filter((i) => i.status === 'new' || i.status === 'considering').slice(0, 12);
  const recentDone = db.prepare("SELECT subject FROM ticket WHERE kanban_column='Done' ORDER BY created_ts DESC LIMIT 10").all().map((t) => t.subject);

  const ceoId = 'ceo-' + randomUUID().slice(0, 6);
  upsertAgent(db, { id: ceoId, role: 'planner-driver', reports_to: 'chair', status: 'working', current_action: 'choosing the next move', model: ROLES['planner-driver'].model });
  const settingsPath = writeWorkerSettings(paths.data, 'autonomous-' + randomUUID().slice(0, 6) + '.settings.json');
  insertEvent(db, { type: 'cycle.autonomous_plan', payload: { ceoId, pendingIdeas: ideas.length } });

  const ideasBlock = ideas.length ? ideas.map((i) => `- [${i.id}] ${i.text}`).join('\n') : '(no pending Chair ideas)';
  const doneBlock = recentDone.length ? recentDone.map((s) => `- ${s}`).join('\n') : '(none yet)';

  const prompt =
    "You are the CEO/management of an autonomous engineering org that improves its OWN system — a multi-agent dev harness " +
    "(Node sidecar in sidecar/) with a web cockpit (sidecar/web/). Decide the SINGLE most valuable next improvement to make " +
    "right now; we will then plan and build it through the gated cycle (tester + auditor + security).\n\n" +
    "THE CHAIR'S PENDING IDEAS — you may adopt one as-is, REFINE it into something better, or REJECT it with a reason. Not every idea must be used:\n" +
    ideasBlock + "\n\n" +
    "RECENTLY COMPLETED (do NOT repeat these):\n" + doneBlock + "\n\n" +
    "You know this system better than the Chair. If a Chair idea is strong, adopt or refine it; if none fit or you have a clearly " +
    "better improvement, propose your OWN. Prefer SMALL, concrete, testable, high-value improvements (UI, process, governance, " +
    "docs, hygiene) — something one engineer can finish in a single cycle. CRITICAL: scope the goal to a SINGLE domain " +
    "(frontend OR backend, not both) that one specialist can complete end-to-end; do NOT propose a fullstack goal that needs " +
    "BOTH a server change AND a UI change in the same cycle — if a feature needs both, pick the most valuable half to do first. " +
    "You may briefly Read the codebase to ground your choice. " +
    "Produce a precise goal statement (with concrete, machine-checkable done_criteria) an engineer could implement, and a `domain` " +
    "(frontend|backend|general). If you base it on a Chair idea set sourceIdeaId to that id and ideaDecision to 'adopt' or 'refine'; " +
    "if you invent your own set sourceIdeaId null and ideaDecision 'own'; if you specifically reject an idea, set ideaDecision 'reject' " +
    "with that id and note why.\n\n" +
    "End with ONLY a fenced json block:\n```json\n" +
    '{"goal":"...","rationale":"...","domain":"frontend|backend|general","sourceIdeaId":null,"ideaDecision":"adopt|refine|own|reject","ideaNote":"..."}' +
    "\n```";

  setAgentStatus(db, ceoId, 'working', 'reviewing ideas + state');
  const startedTs = nowIso();
  const res = await spawnWorker({
    cwd: targetRepo, prompt, charter: ROLES['planner-driver'].charter, model: ROLES['planner-driver'].model,
    allowedTools: ['Read', 'Grep', 'Glob'], maxBudgetUsd: BUDGETS.usdPerRun, settingsPath,
    onEvent: (ev) => insertEvent(db, { type: 'worker.' + ev.type, agentId: ceoId, sessionId: ev.session_id ?? null, payload: ev }),
  });
  recordRun(db, { id: randomUUID(), agentId: ceoId, sessionId: res.result?.session_id ?? null, usd: res.result?.total_cost_usd ?? 0, startedTs, endedTs: nowIso() });
  setAgentStatus(db, ceoId, 'idle', 'proposed the next goal');

  const json = extractJson(res.result?.result);
  insertEvent(db, { type: 'cycle.autonomous_goal', payload: { ceoId, goal: json?.goal, sourceIdeaId: json?.sourceIdeaId, ideaDecision: json?.ideaDecision } });
  return json; // { goal, rationale, domain, sourceIdeaId, ideaDecision, ideaNote }
}
