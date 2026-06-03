import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { paths } from '../src/config.js';
import { runDocumentationReview } from '../src/documentation.js';

let failed = false;

function fail(desc, detail) {
  console.error('FAIL: ' + desc + (detail !== undefined ? ' — ' + String(detail) : ''));
  failed = true;
}

// ── Stub DB: returns two advanced goals ──────────────────────────────────────
const stubDb = {
  prepare(sql) {
    return {
      all() {
        if (sql.includes("status = 'advanced'")) {
          return [
            { text: 'Add shortId helper to server.js' },
            { text: 'Add truncate helper to server.js' },
          ];
        }
        return [];
      },
      get() { return null; },
    };
  },
};

// ── Redirect data writes to a temp dir so we don't touch sidecar/data ────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctest-'));
const origData = paths.data;
paths.data = tmpDir;

// ── Stub worker: simulates agent completing without spawning Claude ───────────
// Does NOT write POLICIES.md itself — exercises the fallback path in the module.
const stubWorker = async () => ({
  result: {
    result: 'Updated README.md with Current capabilities section and wrote POLICIES.md with all governance rules.',
  },
});

const result = await runDocumentationReview(stubDb, { _worker: stubWorker });

paths.data = origData;

// ── Assertions ───────────────────────────────────────────────────────────────
if (typeof result !== 'object' || result === null) {
  fail('result must be an object', result);
} else {
  if (!('policiesPath' in result))    fail('result must have key policiesPath');
  if (!('readmeUpdated' in result))   fail('result must have key readmeUpdated');
  if (!('summary' in result))         fail('result must have key summary');

  if (typeof result.policiesPath !== 'string')   fail('policiesPath must be a string',   typeof result.policiesPath);
  if (typeof result.readmeUpdated !== 'boolean') fail('readmeUpdated must be a boolean', typeof result.readmeUpdated);
  if (typeof result.summary !== 'string')        fail('summary must be a string',        typeof result.summary);

  if (!fs.existsSync(result.policiesPath)) fail('POLICIES.md was not created at policiesPath', result.policiesPath);
  if (result.summary.length === 0)         fail('summary must not be empty');
}

// Clean up
fs.rmSync(tmpDir, { recursive: true, force: true });

if (failed) {
  process.exit(1);
} else {
  console.log('PASS');
}
