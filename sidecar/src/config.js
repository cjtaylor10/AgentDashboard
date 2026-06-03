// Central configuration + path layout for the sidecar.
// Two git repos are involved:
//   - the HARNESS repo (project root) = this orchestrator's own source
//   - the WORKSPACE repo (paths.workspace) = the product the agent org builds in,
//     where each agent gets an isolated git worktree under paths.worktrees.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

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

// The headless worker binary (P0: confirmed at this path, not on PATH). Override with $CLAUDE_BIN.
export const CLAUDE_BIN =
  process.env.CLAUDE_BIN || 'C:\\Users\\carso\\.local\\bin\\claude.exe';

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
