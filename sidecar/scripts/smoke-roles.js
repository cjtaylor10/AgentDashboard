#!/usr/bin/env node
// scripts/smoke-roles.js — prove role tool-scope enforcement
import { ROLES } from '../src/roles.js';

let failed = false;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    failed = true;
  }
}

function tools(roleKey) {
  return ROLES[roleKey]?.tools ?? [];
}

function hasUnrestrictedBash(t) {
  return t.includes('Bash');
}

function hasScopedBash(t, scope) {
  return t.some(x => x === `Bash(${scope})`);
}

const READ_ONLY = ['Read', 'Grep', 'Glob'];

function isExactlyReadOnly(t) {
  const s = [...t].sort().join(',');
  const e = [...READ_ONLY].sort().join(',');
  return s === e && !hasUnrestrictedBash(t);
}

console.log('\n=== smoke-roles: role tool-scope assertions ===\n');

// ── read-only review roles ──────────────────────────────────────────────────
for (const roleKey of ['auditor', 'security', 'compliance', 'training']) {
  const t = tools(roleKey);
  assert(
    `${roleKey}: tools === ['Read','Grep','Glob'] (exact, order-insensitive)`,
    isExactlyReadOnly(t),
    JSON.stringify(t),
  );
  assert(
    `${roleKey}: no Bash (scoped or unscoped)`,
    !t.some(x => x === 'Bash' || x.startsWith('Bash(')),
    JSON.stringify(t),
  );
}

// ── tester: unrestricted Bash ───────────────────────────────────────────────
{
  const t = tools('tester');
  assert(
    'tester: contains unrestricted Bash',
    hasUnrestrictedBash(t),
    JSON.stringify(t),
  );
  assert(
    'tester: no scoped-only Bash (must be full Bash, not just Bash(git:*))',
    t.includes('Bash'),
    JSON.stringify(t),
  );
}

// ── dev (developer): Bash scoped to git:* only ─────────────────────────────
{
  const t = tools('developer');
  assert(
    'dev (developer): contains Bash(git:*)',
    hasScopedBash(t, 'git:*'),
    JSON.stringify(t),
  );
  assert(
    'dev (developer): does NOT contain unrestricted Bash',
    !hasUnrestrictedBash(t),
    JSON.stringify(t),
  );
}

// ── lead roles: Bash scoped to git:* only ──────────────────────────────────
for (const roleKey of ['backend-lead', 'frontend-lead', 'database-lead']) {
  const t = tools(roleKey);
  assert(
    `${roleKey}: contains Bash(git:*)`,
    hasScopedBash(t, 'git:*'),
    JSON.stringify(t),
  );
  assert(
    `${roleKey}: does NOT contain unrestricted Bash`,
    !hasUnrestrictedBash(t),
    JSON.stringify(t),
  );
}

console.log('\n' + (failed ? '>>> SOME ASSERTIONS FAILED <<<' : '>>> All assertions passed <<<') + '\n');
process.exit(failed ? 1 : 0);
