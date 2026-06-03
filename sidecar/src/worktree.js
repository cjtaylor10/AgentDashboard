// Git worktree isolation (BUILD-SPEC §4.2, P0-validated).
// Each agent works on its own branch + working directory so parallel agents never collide.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function isRepo(dir) {
  try { return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true'; }
  catch { return false; }
}

// Initialize the product repo with a seed commit so worktrees can branch off it.
export function ensureRepo(dir, { name = 'harness', email = 'harness@local' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (isRepo(dir)) return false;
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', name]);
  git(dir, ['config', 'user.email', email]);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, '# Workspace\n\nThe product repository the AgentDashboard org builds in.\n');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: seed workspace base']);
  return true;
}

// Idempotent: tears down any prior worktree/branch of the same name, then creates a fresh one.
export function createWorktree(repoDir, worktreesDir, name) {
  fs.mkdirSync(worktreesDir, { recursive: true });
  const wtPath = path.join(worktreesDir, name);
  const branch = `agent/${name}`;
  try { git(repoDir, ['worktree', 'remove', '--force', wtPath]); } catch { /* none */ }
  try { git(repoDir, ['branch', '-D', branch]); } catch { /* none */ }
  git(repoDir, ['worktree', 'add', '-q', '-b', branch, wtPath]);
  return { path: wtPath, branch };
}

export function removeWorktree(repoDir, wtPath) {
  try { git(repoDir, ['worktree', 'remove', '--force', wtPath]); } catch { /* none */ }
}

// Commit whatever the agent produced on its worktree branch (the durable checkpoint).
export function commitAll(wtPath, message) {
  git(wtPath, ['add', '-A']);
  try { git(wtPath, ['commit', '-q', '-m', message]); return true; }
  catch { return false; } // nothing to commit
}

export function listWorktrees(repoDir) {
  try { return git(repoDir, ['worktree', 'list']); } catch { return ''; }
}
