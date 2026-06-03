// Continuous self-development loop: runs a backlog of improvement goals through the council loop,
// each targeting the harness ITSELF. Hard safety gate between iterations: after any self-cycle that
// merges, `node --check` every sidecar JS file; if the build is broken, HARD-REVERT that merge and
// STOP the loop (never let a broken self-merge persist or compound). A merge the council gate withholds
// (tester/auditor/security not satisfied) is safe — the loop just moves on.
//
// Usage: node scripts/self-loop.js [path-to-backlog.json]   (defaults to the built-in backlog)
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { paths, ensureDirs, claudeExists, CLAUDE_BIN } from '../src/config.js';
import { openDb } from '../src/db.js';
import { runCycle } from '../src/loop.js';

const targetRepo = paths.root;
const worktreesDir = path.join(os.tmpdir(), 'agentdash-self-wt');
const git = (args) => execFileSync('git', args, { cwd: targetRepo, encoding: 'utf8' }).trim();

// Safe, unit-testable self-improvements (each touches sidecar/src/server.js + a new test file).
const DEFAULT_BACKLOG = [
  "In sidecar/src/server.js, reduce duplication in workerEventToLine by adding an exported pure helper " +
    "`truncate(text, max)` that returns text unchanged if text.length <= max, otherwise text.slice(0, max - 3) + '...'. " +
    "Refactor the truncation sites inside workerEventToLine to call truncate(txt, 120). Create " +
    "sidecar/test/truncate.test.mjs importing { truncate } from '../src/server.js' asserting truncate('hello', 10) === 'hello' " +
    "and truncate('abcdefgh', 5) === 'ab...'; print PASS if both hold else FAIL and process.exit(1). Only touch " +
    "sidecar/src/server.js and the new test file. DONE WHEN: 'node sidecar/test/truncate.test.mjs' prints PASS and " +
    "'node --check sidecar/src/server.js' exits 0.",
  "In sidecar/src/server.js, add an exported pure helper `shortId(id)` returning the substring after the last '-' " +
    "(shortId('dev-ce7fb13a') === 'ce7fb13a'), the whole string when there is no '-' (shortId('plain') === 'plain'), " +
    "and '' for null/undefined. Create sidecar/test/shortid.test.mjs importing { shortId } asserting those three cases; " +
    "print PASS if all hold else FAIL and process.exit(1). Only touch sidecar/src/server.js and the new test file. " +
    "DONE WHEN: 'node sidecar/test/shortid.test.mjs' prints PASS and 'node --check sidecar/src/server.js' exits 0.",
];

function sidecarJsFiles() {
  const dirs = [path.join(paths.root, 'sidecar', 'src'), path.join(paths.root, 'sidecar', 'scripts'), path.join(paths.root, 'sidecar', 'web')];
  const out = [];
  for (const d of dirs) for (const f of fs.readdirSync(d)) if (f.endsWith('.js') || f.endsWith('.mjs')) out.push(path.join(d, f));
  return out;
}

function verifyBuild() {
  // 1) syntax-check every sidecar JS file
  for (const f of sidecarJsFiles()) {
    try { execFileSync('node', ['--check', f], { stdio: 'ignore' }); }
    catch { return 'syntax:' + path.basename(f); }
  }
  // 2) run every accumulated test (regression gate against prior self-improvements)
  const testDir = path.join(paths.root, 'sidecar', 'test');
  if (fs.existsSync(testDir)) {
    for (const f of fs.readdirSync(testDir)) {
      if (!f.endsWith('.test.mjs')) continue;
      try { execFileSync('node', [path.join(testDir, f)], { stdio: 'ignore' }); }
      catch { return 'test:' + f; }
    }
  }
  return null;
}

async function main() {
  ensureDirs();
  if (!claudeExists()) { console.error('claude not found at', CLAUDE_BIN); process.exit(1); }

  const arg = process.argv[2];
  const backlog = arg && fs.existsSync(arg) ? JSON.parse(fs.readFileSync(arg, 'utf8')) : DEFAULT_BACKLOG;
  const db = openDb();
  console.log(`[self-loop] ${backlog.length} backlog item(s); target = the harness itself\n`);

  const summary = [];
  for (let i = 0; i < backlog.length; i++) {
    if (git(['status', '--porcelain'])) { console.error(`[self-loop] tree dirty before item ${i + 1} — stopping`); break; }
    const before = git(['rev-parse', 'HEAD']);
    console.log(`[self-loop] === item ${i + 1}/${backlog.length} ===`);
    console.log('  ' + backlog[i].slice(0, 90) + '...');

    let r;
    try { r = await runCycle(db, { goalText: backlog[i], targetRepo, worktreesDir }); }
    catch (e) { console.error('  cycle error:', e.message); summary.push({ item: i + 1, result: 'error', note: e.message }); break; }

    if (!r.merged) {
      console.log(`  -> WITHHELD by the gate (testPass=${r.testPass}, aligned=${r.aligned}, clean=${r.clean}) — continuing`);
      summary.push({ item: i + 1, result: 'withheld' });
      continue;
    }
    const broken = verifyBuild();
    if (broken) {
      console.error('  -> MERGED but verification FAILED (' + broken + ') — HARD REVERT + STOP');
      git(['reset', '--hard', before]);
      summary.push({ item: i + 1, result: 'reverted', broken });
      break;
    }
    const after = git(['rev-parse', 'HEAD']).slice(0, 7);
    console.log(`  -> MERGED + verified; HEAD ${before.slice(0, 7)} -> ${after}`);
    summary.push({ item: i + 1, result: 'merged', head: after });
  }

  console.log('\n===== SELF-LOOP SUMMARY =====');
  for (const s of summary) console.log('  ' + JSON.stringify(s));
  const merged = summary.filter((s) => s.result === 'merged').length;
  console.log(`\n${merged}/${backlog.length} self-improvements merged + verified into the harness.`);
  db.close();
}

main().catch((e) => { console.error('[self-loop] error:', e.message); process.exit(1); });
