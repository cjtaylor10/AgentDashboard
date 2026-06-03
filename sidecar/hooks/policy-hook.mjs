#!/usr/bin/env node
// Layer-B PreToolUse policy hook (BUILD-SPEC §8). Defense-in-depth behind the sidecar gate.
// Reads the tool-call payload on stdin; DENIES (exit 2) integration/state-changing git in the worker
// shell so an agent cannot bypass the approval gate. Ordinary work (add/commit/status/diff) is allowed.
// Layer A (sidecar-owned merge) remains the primary guarantee; this is the second lock.
let raw = '';

function decideAndExit() {
  let p = {};
  try { p = JSON.parse(raw || '{}'); } catch { /* treat as empty */ }
  const tool = p.tool_name;
  const cmd = (p.tool_input && p.tool_input.command) || '';
  const DANGER = /\bgit\s+(merge|push|rebase|reset|checkout|switch|cherry-pick)\b/;
  if (tool === 'Bash' && DANGER.test(cmd)) {
    process.stderr.write(
      `POLICY DENY: "${cmd.slice(0, 80)}" — integration/merge must go through the sidecar approval gate, not the worker shell.`
    );
    process.exit(2); // block the tool call
  }
  process.exit(0); // allow
}

process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', decideAndExit);
setTimeout(decideAndExit, 4000); // safety: never hang the worker if stdin stalls
