// Worker runtime: spawn a headless Claude worker and stream its lifecycle events.
// This wraps the P0-confirmed recipe (see P0-FINDINGS.md). Every native flag does heavy lifting:
//   tool-scoping, per-run budget cap, role injection, hook enforcement, session control.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { CLAUDE_BIN } from './config.js';

// Strip the "running inside Claude Code" markers so the child behaves as an independent process.
const STRIP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'];

const DEFAULT_CHARTER =
  'You are an autonomous worker agent. Do exactly the assigned task and nothing more. ' +
  'If a tool call is blocked by policy, do not retry — stop and report that it was blocked.';

/**
 * Spawn one headless worker. Resolves with { exitCode, result, events, stderr }.
 * onEvent(ev) is called for every parsed stream-json line as it arrives.
 */
export function spawnWorker({
  cwd,
  prompt,
  charter = DEFAULT_CHARTER,
  model = 'sonnet',
  allowedTools = ['Read'],
  maxBudgetUsd = 1.0,
  permissionMode = 'acceptEdits',
  settingsPath = null,
  onEvent = () => {},
}) {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--include-hook-events',
    '--verbose',
    '--model', model,
    '--append-system-prompt', charter,
    '--allowedTools', allowedTools.join(' '),
    '--permission-mode', permissionMode,
    '--max-budget-usd', String(maxBudgetUsd),
    '--add-dir', cwd,
    '--no-session-persistence',
  ];
  if (settingsPath) args.push('--settings', settingsPath);

  return new Promise((resolve) => {
    // stdin 'ignore' => immediate EOF, avoids the CLI's 3s "no stdin" wait.
    const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    const events = [];
    let result = null;
    let stderr = '';

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      let ev;
      try { ev = JSON.parse(s); } catch { return; } // ignore any non-JSON noise
      events.push(ev);
      if (ev.type === 'result') result = ev;
      try { onEvent(ev); } catch { /* never let a consumer error kill the stream */ }
    });

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ exitCode: -1, result: null, events, stderr: String(err) }));
    child.on('close', (code) => { rl.close(); resolve({ exitCode: code, result, events, stderr }); });
  });
}
