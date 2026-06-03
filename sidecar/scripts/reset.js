// Wipe all runtime state (product repo, agent worktrees, SQLite db) for a clean re-run.
// Does NOT touch the harness source.
import fs from 'node:fs';
import { paths } from '../src/config.js';

for (const d of [paths.worktrees, paths.workspace, paths.data]) {
  fs.rmSync(d, { recursive: true, force: true });
  console.log('removed', d);
}
console.log('reset complete.');
