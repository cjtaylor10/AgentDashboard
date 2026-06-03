// Generates a Claude settings file that runs the Layer-B PreToolUse policy hook on every Bash call.
// Written OUTSIDE the worktree so the worker's `git add -A` never stages it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const POLICY_HOOK = path.resolve(here, '..', 'hooks', 'policy-hook.mjs');

export function writeWorkerSettings(outDir, name = 'worker-settings.json') {
  fs.mkdirSync(outDir, { recursive: true });
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${POLICY_HOOK}"` }] },
      ],
    },
  };
  const p = path.join(outDir, name);
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
  return p;
}
