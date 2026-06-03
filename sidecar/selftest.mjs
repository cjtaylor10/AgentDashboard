// selftest.mjs — runs the unit test suite (no network, no Claude required).
// Exit 0 = all pass.  Exit 1 = at least one failure.
// Uses spawnSync (no shell) to avoid path-escaping issues on Windows.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

const TESTS = [
  'test/console-parser.test.mjs',
  'test/shortid.test.mjs',
  'test/truncate.test.mjs',
  'test/documentation.test.mjs',
];

const nodeBin = process.execPath; // exact node binary that launched this script

let anyFailed = false;

for (const t of TESTS) {
  const full = path.join(dir, t);
  const r = spawnSync(nodeBin, ['--no-warnings', full], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`PASS  ${t}  ${(r.stdout ?? '').trim()}`);
  } else {
    console.error(`FAIL  ${t}`);
    if (r.stdout) console.error(r.stdout.trim());
    if (r.stderr) console.error(r.stderr.trim());
    anyFailed = true;
  }
}

process.exit(anyFailed ? 1 : 0);
