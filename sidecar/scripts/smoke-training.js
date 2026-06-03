// Smoke test for runTrainingReview: seeds the DB with one failed cycle's verdict events,
// runs training review, and asserts sidecar/data/policy-refinements.json is a non-empty array.
// Requires Claude CLI (CLAUDE_BIN) to be available.
// Usage: node sidecar/scripts/smoke-training.js
import fs from 'node:fs';
import path from 'node:path';
import { openDb, insertEvent } from '../src/db.js';
import { runTrainingReview } from '../src/training.js';
import { paths } from '../src/config.js';

const db = openDb();

// Seed: one cycle with a failed test and misaligned audit (should produce at least one proposal).
const cycleId = 'cyc-smoke001';
insertEvent(db, { type: 'cycle.stop',     payload: { cycleId, advanced: false } });
insertEvent(db, { type: 'cycle.test',     payload: { cycleId, tester: 'tester-aaa', pass: false, evidence: 'Error: file not found' } });
insertEvent(db, { type: 'cycle.audit',    payload: { cycleId, auditor: 'auditor-bbb', aligned: false, verdict: 'reopen', findings: ['done_criteria not demonstrated'] } });
insertEvent(db, { type: 'cycle.security', payload: { cycleId, clean: true, findings: [] } });

console.log('[smoke-training] DB seeded with 1 failed cycle. Running runTrainingReview...');

await runTrainingReview(db);

const outPath = path.join(paths.data, 'policy-refinements.json');
if (!fs.existsSync(outPath)) {
  console.error('FAIL: policy-refinements.json was not written');
  process.exit(1);
}

let arr;
try { arr = JSON.parse(fs.readFileSync(outPath, 'utf8')); }
catch (e) { console.error('FAIL: policy-refinements.json is not valid JSON:', e.message); process.exit(1); }

if (!Array.isArray(arr) || arr.length === 0) {
  console.error('FAIL: policy-refinements.json is not a non-empty array, got:', JSON.stringify(arr));
  process.exit(1);
}

console.log('[smoke-training] PASS: policy-refinements.json contains', arr.length, 'proposal(s)');
db.close();
