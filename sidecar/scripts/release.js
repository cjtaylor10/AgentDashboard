#!/usr/bin/env node
// release.js — tiny zero-dep release helper for AgentDashboard.
//
// Bumps the semver in BOTH desktop/src-tauri/tauri.conf.json (the source of
// truth) and sidecar/package.json, then prints the git commands to run.
// It deliberately does NOT execute any git command — that stays in your hands.
//
// Usage:  node --no-warnings scripts/release.js [patch|minor|major]
//         (defaults to "patch")

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve repo paths relative to this file so it works from any cwd.
// __dirname here == <repo>/sidecar/scripts
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const TAURI_CONF = resolve(repoRoot, 'desktop', 'src-tauri', 'tauri.conf.json');
const PKG_JSON = resolve(repoRoot, 'sidecar', 'package.json');

// 1. Read and validate the requested bump type.
const bump = process.argv[2] ?? 'patch';
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error(`Invalid bump type "${bump}". Use one of: patch | minor | major`);
  process.exit(1);
}

// 2. Read the current version from tauri.conf.json (the authoritative source).
const tauriConf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
const current = tauriConf.version;
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current ?? '');
if (!match) {
  console.error(`Current version "${current}" in tauri.conf.json is not a valid X.Y.Z semver.`);
  process.exit(1);
}

// 3. Compute the bumped semver (patch/minor/major reset the lower fields).
let [major, minor, patch] = match.slice(1).map(Number);
if (bump === 'major') { major += 1; minor = 0; patch = 0; }
else if (bump === 'minor') { minor += 1; patch = 0; }
else { patch += 1; }
const next = `${major}.${minor}.${patch}`;

// 4. Write the new version into both files, preserving 2-space indentation
//    and a trailing newline (matches the existing on-disk style).
tauriConf.version = next;
writeFileSync(TAURI_CONF, JSON.stringify(tauriConf, null, 2) + '\n');

const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'));
pkg.version = next;
writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + '\n');

// 5. Report the result and the exact follow-up git commands (NOT executed).
const tag = `v${next}`;
console.log(`Bumped ${current} -> ${next} (${bump})`);
console.log('Updated: desktop/src-tauri/tauri.conf.json, sidecar/package.json');
console.log('\nNext steps (run manually):');
console.log('  git add -A');
console.log(`  git commit -m "release ${tag}"`);
console.log(`  git tag ${tag}`);
console.log('  git push origin master --tags');
