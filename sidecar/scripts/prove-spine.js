// P1 spine smoke test — proves the orchestrator's load-bearing path end-to-end:
//   ensure product repo -> isolate an agent on a git worktree -> spawn a real headless worker
//   -> stream every lifecycle event into SQLite -> commit the agent's work -> read it all back.
// This is NOT the council loop yet (no FSM / roles / approvals) — it proves the spine those will sit on.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths, ensureDirs, claudeExists, CLAUDE_BIN, BUDGETS } from '../src/config.js';
import { openDb, insertEvent, upsertAgent, setAgentStatus, recordRun, nowIso } from '../src/db.js';
import { ensureRepo, createWorktree, commitAll, listWorktrees } from '../src/worktree.js';
import { spawnWorker } from '../src/worker.js';

const log = (...a) => console.log('[spine]', ...a);

async function main() {
  ensureDirs();
  if (!claudeExists()) {
    console.error('claude binary not found at', CLAUDE_BIN, '\nSet $CLAUDE_BIN to override.');
    process.exit(1);
  }

  const db = openDb();
  log('sqlite spine ready at', paths.db);

  // 1) ensure the org's product repo exists (seed commit so worktrees can branch)
  const created = ensureRepo(paths.workspace);
  log(created ? 'initialized workspace repo' : 'workspace repo already present', '->', paths.workspace);

  // 2) isolate an agent on its own git worktree
  const agentId = 'dev-' + randomUUID().slice(0, 8);
  const wt = createWorktree(paths.workspace, paths.worktrees, agentId);
  log('worktree', wt.branch, '->', wt.path);

  // 3) register the agent in the projection table + log the lifecycle event
  upsertAgent(db, {
    id: agentId, role: 'developer', reports_to: 'planner-driver', status: 'working',
    current_action: 'spine smoke task', model: 'sonnet', worktree_path: wt.path, identity_token: randomUUID(),
  });
  insertEvent(db, { type: 'agent.spawned', agentId, payload: { role: 'developer', worktree: wt.path } });

  // 4) spawn the worker; persist EVERY stream event into the append-only log
  const startedTs = nowIso();
  const prompt =
    `Create a file named PROGRESS.md in the current directory containing exactly this one line:\n` +
    `"spine smoke: agent ${agentId} did real work"\nThen stop. Do nothing else.`;
  log(`spawning worker (real model call, capped at $${BUDGETS.usdPerRun})...`);

  let toolUses = 0;
  const res = await spawnWorker({
    cwd: wt.path,
    prompt,
    model: 'sonnet',
    allowedTools: ['Write', 'Read'],
    maxBudgetUsd: BUDGETS.usdPerRun,
    onEvent: (ev) => {
      insertEvent(db, { type: 'worker.' + ev.type, agentId, sessionId: ev.session_id ?? null, payload: ev });
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content ?? []) if (b.type === 'tool_use') toolUses++;
      }
    },
  });

  // 5) record run cost + close out the agent
  const cost = res.result?.total_cost_usd ?? 0;
  recordRun(db, { id: randomUUID(), agentId, sessionId: res.result?.session_id ?? null, usd: cost, startedTs, endedTs: nowIso() });
  setAgentStatus(db, agentId, 'idle', 'spine task complete');
  insertEvent(db, { type: 'agent.idle', agentId, payload: { cost_usd: cost } });

  // 6) commit the agent's deliverable on its own branch (the durable checkpoint)
  const progressPath = path.join(wt.path, 'PROGRESS.md');
  const fileMade = fs.existsSync(progressPath);
  if (fileMade) commitAll(wt.path, `feat(${agentId}): spine smoke deliverable`);

  // 7) read everything back FROM SQLite — this is what proves the spine
  const total = db.prepare('SELECT COUNT(*) AS c FROM event').get().c;
  const byType = db.prepare('SELECT type, COUNT(*) AS c FROM event GROUP BY type ORDER BY c DESC').all();

  console.log('\n===== SPINE SMOKE TEST RESULT =====');
  console.log('worker exit code      :', res.exitCode);
  console.log('result subtype        :', res.result?.subtype, '| is_error:', res.result?.is_error);
  console.log('cost (usd)            :', cost);
  console.log('tool_use blocks seen  :', toolUses);
  console.log('PROGRESS.md created   :', fileMade, fileMade ? `("${fs.readFileSync(progressPath, 'utf8').trim()}")` : '');
  console.log('events persisted      :', total);
  console.log('--- events by type (read back from SQLite) ---');
  for (const r of byType) console.log('  ' + String(r.c).padStart(4) + '  ' + r.type);
  console.log('--- agent projection ---');
  for (const r of db.prepare('SELECT id, role, status, current_action FROM agent').all()) {
    console.log('  ', r.id, '|', r.role, '|', r.status, '|', r.current_action);
  }
  console.log('--- git worktrees ---');
  console.log(listWorktrees(paths.workspace).split('\n').map((l) => '  ' + l).join('\n'));

  const pass = res.exitCode === 0 && fileMade && total > 0 && !res.result?.is_error;
  console.log('\nRESULT:', pass
    ? 'PASS - spawn -> isolate -> persist -> query works end-to-end'
    : 'FAIL');
  db.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
