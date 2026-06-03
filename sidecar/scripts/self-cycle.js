// Self-development: run a council cycle that targets the HARNESS's OWN repo (this codebase),
// so the system improves ITSELF — gated by the same Tester -> Auditor -> Security -> approval pipeline,
// merged into the harness master only on demonstrated, audited, security-clean success.
//
// Safety: refuses to run on a dirty working tree (the gated merge needs a clean base, and we never
// want to entangle the agent's change with uncommitted human work). Agents work on a worktree created
// OUTSIDE the repo (system temp), so the running orchestrator's files are untouched until the final merge.
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths, ensureDirs, claudeExists, CLAUDE_BIN } from '../src/config.js';
import { openDb } from '../src/db.js';
import { runCycle } from '../src/loop.js';

const GOAL = process.argv.slice(2).join(' ');
if (!GOAL) { console.error('usage: self-cycle "<goal>"'); process.exit(1); }

const targetRepo = paths.root;                                    // the harness itself
const worktreesDir = path.join(os.tmpdir(), 'agentdash-self-wt'); // outside the repo (avoid nesting)
const git = (args) => execFileSync('git', args, { cwd: targetRepo, encoding: 'utf8' }).trim();

async function main() {
  ensureDirs();
  if (!claudeExists()) { console.error('claude not found at', CLAUDE_BIN); process.exit(1); }

  // SAFETY GATE: never self-modify a dirty tree.
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    console.error('[self-cycle] REFUSING: the harness working tree is dirty — commit or stash first:\n' + dirty);
    process.exit(2);
  }
  const headBefore = git(['rev-parse', 'HEAD']);

  const db = openDb();
  console.log('[self-cycle] TARGET = the harness itself:', targetRepo);
  console.log('[self-cycle] HEAD before:', headBefore.slice(0, 7));
  console.log('[self-cycle] goal:\n  ' + GOAL + '\n');

  const r = await runCycle(db, { goalText: GOAL, targetRepo, worktreesDir });

  console.log('\n===== SELF-CYCLE RESULT =====');
  console.log('tester PASS    :', r.testPass);
  console.log('auditor ALIGNED:', r.aligned);
  console.log('security CLEAN :', r.clean);
  console.log('merged to self :', r.merged);
  const headAfter = git(['rev-parse', 'HEAD']);
  console.log('HEAD', headBefore.slice(0, 7), '->', headAfter.slice(0, 7), r.merged ? '(the system modified its own code)' : '(unchanged — verification withheld)');
  if (r.merged) {
    console.log('\n--- harness master log (top 3) ---');
    console.log(git(['log', '--oneline', '-n', '3']).split('\n').map((l) => '  ' + l).join('\n'));
    console.log('\nNOTE: review the change, then `node --check` the touched files before relying on it.');
  }
  db.close();
  process.exit(r.merged ? 0 : 1);
}

main().catch((e) => { console.error('[self-cycle] error:', e.message); process.exit(1); });
