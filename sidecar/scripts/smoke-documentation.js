// Smoke test for runDocumentationReview: calls the function against the live DB and asserts
// sidecar/data/POLICIES.md is written with size > 100 bytes and the return shape is correct.
// Requires Claude CLI (CLAUDE_BIN) to be available.
// Usage: node sidecar/scripts/smoke-documentation.js
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { runDocumentationReview } from '../src/documentation.js';
import { paths } from '../src/config.js';

const db = openDb();

console.log('[smoke-documentation] Running runDocumentationReview against live DB...');

const result = await runDocumentationReview(db);

// 1. Return shape check
if (
  !result ||
  typeof result.policiesPath !== 'string' ||
  typeof result.readmeUpdated !== 'boolean' ||
  typeof result.summary !== 'string'
) {
  console.error('FAIL: runDocumentationReview did not return expected shape:', JSON.stringify(result));
  process.exit(1);
}

// 2. POLICIES.md must exist with size > 100 bytes
const policiesPath = path.join(paths.data, 'POLICIES.md');
if (!fs.existsSync(policiesPath)) {
  console.error('FAIL: POLICIES.md was not written at', policiesPath);
  process.exit(1);
}
const stat = fs.statSync(policiesPath);
if (stat.size <= 100) {
  console.error('FAIL: POLICIES.md is too small:', stat.size, 'bytes (need > 100)');
  process.exit(1);
}

console.log('[smoke-documentation] PASS: POLICIES.md at', policiesPath, '(' + stat.size + ' bytes)');
console.log('[smoke-documentation] readmeUpdated:', result.readmeUpdated);
console.log('[smoke-documentation] summary:', result.summary);

db.close();
