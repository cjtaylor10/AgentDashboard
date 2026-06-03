// Integration test for the planning pipeline.
//
// Validates:
//   (a) At least one research_brief event exists in the DB after the pipeline
//       runs, with at least one non-empty string field (web_summary or
//       codebase_notes).
//   (b) The prompt string passed to Claude contains the research brief text
//       verbatim (web_summary or codebase_notes appears as a substring).
//
// Does NOT require network access or an Anthropic API key — all I/O is stubbed.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createEventStore } from '../src/event-store.mjs';
import { runPlanner } from '../planner.mjs';

let failed = false;

function assert(desc, condition, detail) {
  if (!condition) {
    console.error('FAIL: ' + desc + (detail !== undefined ? '  —  ' + String(detail) : ''));
    failed = true;
  }
}

// ── Temp DB ──────────────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plantest-'));
const store = createEventStore(path.join(tmpDir, 'events.db'));

// ── Stubs ────────────────────────────────────────────────────────────────────
const FIXTURE_GOAL = 'Add JWT authentication to the REST API';

const mockWebSearch = async (query) =>
  `Web results: use jsonwebtoken npm package for JWT signing; RFC 7519 defines the standard. Query was: ${query}`;

const mockGrepLocal = async (query) =>
  `Codebase: found insertEvent in src/db.js:132 and openDb in src/db.js:122. Query was: ${query}`;

let capturedPrompt = null;
const mockCallClaude = async (prompt) => {
  capturedPrompt = prompt;
  return JSON.stringify([
    { subject: 'Install jsonwebtoken', done_criteria: 'package.json lists jsonwebtoken' },
    { subject: 'Add /auth/login endpoint', done_criteria: 'returns signed JWT on valid credentials' },
  ]);
};

// ── Run the pipeline ─────────────────────────────────────────────────────────
const result = await runPlanner(FIXTURE_GOAL, {
  appendEvent: (type, payload) => store.append_event(type, payload),
  webSearch: mockWebSearch,
  grepLocal: mockGrepLocal,
  callClaude: mockCallClaude,
});

// ── Assertion A: DB contains a research_brief event with non-empty fields ────
const events = store.get_events('research_brief');
assert('DB has at least one research_brief event', events.length > 0, `found ${events.length}`);

if (events.length > 0) {
  const payload = events[0].payload;
  assert(
    'research_brief payload is an object',
    payload !== null && typeof payload === 'object',
    JSON.stringify(payload)
  );
  const webSummaryNonEmpty =
    typeof payload.web_summary === 'string' && payload.web_summary.length > 0;
  const codebaseNotesNonEmpty =
    typeof payload.codebase_notes === 'string' && payload.codebase_notes.length > 0;
  assert(
    'research_brief payload has at least one non-empty string field (web_summary or codebase_notes)',
    webSummaryNonEmpty || codebaseNotesNonEmpty,
    `web_summary="${payload.web_summary}", codebase_notes="${payload.codebase_notes}"`
  );
}

// ── Assertion B: prompt passed to Claude contains the brief text verbatim ────
assert('callClaude was called (capturedPrompt is non-null)', capturedPrompt !== null);

if (capturedPrompt !== null && result.brief) {
  const { web_summary, codebase_notes } = result.brief;

  const webInPrompt = typeof web_summary === 'string' && web_summary.length > 0 &&
    capturedPrompt.includes(web_summary);
  const codebaseInPrompt = typeof codebase_notes === 'string' && codebase_notes.length > 0 &&
    capturedPrompt.includes(codebase_notes);

  assert(
    'prompt passed to Claude contains brief text verbatim (web_summary or codebase_notes)',
    webInPrompt || codebaseInPrompt,
    `web present=${webInPrompt}, codebase present=${codebaseInPrompt}`
  );
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
store.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

if (!failed) {
  console.log('PASS');
} else {
  process.exit(1);
}
