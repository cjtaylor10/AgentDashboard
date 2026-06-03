// Run one full council cycle end-to-end (BUILD-SPEC §7, §10 — the headless MVP).
// Goal can be passed as CLI args; otherwise a small, deterministically-testable default is used.
import { execFileSync } from 'node:child_process';
import { paths, ensureDirs, claudeExists, CLAUDE_BIN } from '../src/config.js';
import { openDb } from '../src/db.js';
import { runCycle } from '../src/loop.js';

const GOAL = process.argv.slice(2).join(' ') ||
  "Provide a working add(a,b) function as an ES module 'math.mjs' in the workspace, plus a 'selftest.mjs' " +
  "that imports it and prints PASS if add(2,3)===5 and add(-1,1)===0, otherwise prints FAIL. " +
  "Done when running 'node selftest.mjs' prints PASS.";

const pad = (s, n) => String(s).padEnd(n);

async function main() {
  ensureDirs();
  if (!claudeExists()) { console.error('claude not found at', CLAUDE_BIN); process.exit(1); }
  const db = openDb();
  console.log('[cycle] goal:\n  ' + GOAL + '\n');

  const r = await runCycle(db, { goalText: GOAL });

  console.log('\n===== COUNCIL CYCLE RESULT =====');
  console.log('cycle            :', r.cycleId);
  console.log('ticket           :', r.ticketId ?? '(none planned)');
  console.log('tester PASS      :', r.testPass);
  console.log('auditor ALIGNED  :', r.aligned);
  console.log('merged to master :', r.merged);
  console.log('goal advanced    :', r.advanced);

  console.log('\n--- cycle state machine (from SQLite) ---');
  for (const e of db.prepare("SELECT type, ts FROM event WHERE type LIKE 'cycle.%' ORDER BY id").all()) {
    console.log('  ', pad(e.type.replace('cycle.', ''), 16), e.ts);
  }
  console.log('\n--- kanban ---');
  for (const t of db.prepare('SELECT subject, status, kanban_column FROM ticket').all()) {
    console.log('  ', pad(t.kanban_column, 12), '|', pad(t.status, 11), '|', t.subject);
  }
  console.log('\n--- agents this cycle ---');
  for (const a of db.prepare('SELECT id, role, status FROM agent ORDER BY role').all()) {
    console.log('  ', pad(a.role, 15), pad(a.id, 16), a.status);
  }
  console.log('\n--- governance trail ---');
  for (const e of db.prepare("SELECT type, COUNT(*) c FROM event WHERE type LIKE 'change.%' OR type LIKE 'merge.%' OR type LIKE 'approval.%' GROUP BY type ORDER BY type").all()) {
    console.log('  ' + String(e.c).padStart(3), e.type);
  }
  const spend = db.prepare('SELECT COALESCE(SUM(usd),0) s, COUNT(*) n FROM run').get();
  console.log('\n--- org spend --- $' + spend.s.toFixed(4) + ' over ' + spend.n + ' model runs (cycle cap $' + '50' + ')');
  console.log('\n--- workspace master log ---');
  try {
    console.log(execFileSync('git', ['-C', paths.workspace, 'log', '--oneline', '-n', '5'], { encoding: 'utf8' })
      .split('\n').map((l) => '  ' + l).join('\n'));
  } catch { /* none */ }

  console.log('\nRESULT:', r.advanced
    ? 'PASS - goal taken from intake to a tested, audited, approved, merged change'
    : 'INCOMPLETE - cycle ran but goal not advanced (verification withheld the merge)');
  db.close();
  process.exit(r.advanced ? 0 : 1);
}

main().catch((e) => { console.error('[cycle] error:', e.message); process.exit(1); });
