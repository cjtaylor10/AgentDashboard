// Central configuration + path layout for the sidecar.
// Two git repos are involved:
//   - the HARNESS repo (project root) = this orchestrator's own source
//   - the WORKSPACE repo (paths.workspace) = the product the agent org builds in,
//     where each agent gets an isolated git worktree under paths.worktrees.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
export const sidecarDir = path.resolve(srcDir, '..');
export const rootDir = path.resolve(sidecarDir, '..');

export const paths = {
  root: rootDir,
  workspace: path.join(rootDir, 'workspace'),   // the org's product repo (its own git repo)
  worktrees: path.join(rootDir, '.worktrees'),  // per-agent worktrees (ignored by the harness repo)
  data: path.join(sidecarDir, 'data'),
  db: path.join(sidecarDir, 'data', 'harness.db'),
};

// The headless worker binary. The original Windows host had it at a fixed path, but for
// cross-platform portability we resolve it at runtime, in priority order:
//   1. $CLAUDE_BIN (explicit override)
//   2. claude / claude.exe / claude.cmd found on $PATH
//   3. common per-platform install locations
// This lets the same harness run unmodified on Windows or macOS. Override with $CLAUDE_BIN.
const CLAUDE_BIN_NAMES =
  process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] : ['claude'];

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function findClaudeOnPath() {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of CLAUDE_BIN_NAMES) {
      const full = path.join(dir, name);
      if (isFile(full)) return full;
    }
  }
  return null;
}

function commonClaudeDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      path.join(home, '.local', 'bin'),
      path.join(home, '.claude', 'local'),
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'claude'),
    ];
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
}

function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const onPath = findClaudeOnPath();
  if (onPath) return onPath;
  for (const dir of commonClaudeDirs()) {
    for (const name of CLAUDE_BIN_NAMES) {
      const full = path.join(dir, name);
      if (isFile(full)) return full;
    }
  }
  // Not found: return a platform-sensible default so messages read cleanly
  // (claudeExists() returns false and callers refuse to run).
  return process.platform === 'win32'
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
    : 'claude';
}

export const CLAUDE_BIN = resolveClaudeBin();

// §9 brakes — starting defaults. Tune via "spend per completed ticket" (see BUILD-SPEC open decisions).
export const BUDGETS = {
  usdPerRun: 1.0,
  usdPerAgent: 5.0,
  usdPerCycle: 50.0,
  usdPerDay: 200.0,
  maxSpawnDepth: 3,
  maxConcurrentAgents: 6,
};

export function ensureDirs() {
  for (const d of [paths.workspace, paths.worktrees, paths.data]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function claudeExists() {
  return fs.existsSync(CLAUDE_BIN);
}
