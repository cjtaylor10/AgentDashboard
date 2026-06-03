# P0 — De-risk Spike Findings

Date: 2026-06-02 · Host: Windows 11 · Result: **ALL GREEN — headless-MVP thesis validated.**

Four load-bearing assumptions were tested with throwaway spikes (temp dirs, no footprint on the project). All passed.

## Environment

| Tool | Version | Note |
|---|---|---|
| git | 2.52.0 | worktrees work (see Spike 1) |
| node | v24.11.1 | **sidecar targets Node** — Bun is NOT installed |
| npm | 11.10.1 | |
| python | 3.14.0 | available if ever needed |
| cargo / rustc | 1.94.1 | **Rust present → Tauri viable for the P2 cockpit** |
| claude | 2.1.92 (SDK 0.3.160) | binary at `C:\Users\carso\.local\bin\claude.exe` (not on PATH) |

**Auth model:** no `ANTHROPIC_API_KEY`. Workers authenticate through the host's **Claude Code OAuth** session — confirmed working from a spawned process with the "inside Claude Code" env markers stripped. (Do **not** use `--bare`; it forces API-key auth and skips hooks.)

## Spike results

### 1. Worktree isolation — PASS
`git worktree add -b agent-1 <path>` gives each agent its own branch + working dir. An agent editing/creating files in its worktree left the main tree's files untouched and did not leak new files into it. → The orchestrator's per-agent filesystem isolation holds.

### 2. Headless worker spawn — PASS
A spawned `claude.exe -p` worker (clean env, throwaway cwd) **authenticated via OAuth**, **honored a 2-tool allowlist** (`--allowedTools Write Read`), executed the task (created the file), and emitted **parseable `stream-json`** (system/user/assistant/result events). Result: `subtype=success`, **cost $0.074**, 2 turns, 4.6s.

### 3. Native budget cap — PASS
`--max-budget-usd` is a real per-run hard ceiling (`--print` only), and each run reports `total_cost_usd`. → Part of the §9 brakes is native. **Calibration data point:** a *trivial* one-file task ≈ **$0.074 on Sonnet**; real tickets will be multiples, so the spec's ~$5/agent is in the right zone.

### 4. PreToolUse enforcement (the keystone) — PASS
A PreToolUse `command` hook that **exits 2** blocked a `Write` the worker was explicitly told to do: the file was **not created**, the hook's stderr reason was **fed back to the worker**, and the worker stopped without retrying. → Governance can be **physically enforced**, not just a status field.

## The confirmed worker-spawn recipe (canonical for P1)

```
cwd = <the agent's git worktree>
claude.exe -p "<task>"
  --output-format stream-json --include-hook-events --verbose   # event stream → sidecar
  --model <sonnet|opus>                                         # cost-tiered per role
  --append-system-prompt "<role charter>"                       # role injection
  --allowedTools "<scoped list>"                                # per-worker tool scope
  --permission-mode acceptEdits                                 # autonomous file work
  --max-budget-usd <cap>                                        # native per-run hard cap
  --settings <hooks+perms.json>                                 # PreToolUse policy hook
  --add-dir <worktree>                                          # grant the worktree
  --session-id <uuid> | --resume <id> | --no-session-persistence # lifecycle control
  < NUL                                                         # avoid the 3s stdin wait
```

The sidecar's worker module = "spawn this subprocess, stream-parse its `stdout`, persist events." Tool-scoping, per-run budget, role injection, session lifecycle, MCP attach (`--mcp-config`), and hook enforcement are **all native flags** — no custom runtime needed.

## Implications for the spec
- **Sidecar = Node**, not Bun.
- **Worker = `claude.exe -p` (stream-json)**, not the embedded SDK — simpler and already OAuth-authed.
- Enforcement **Layer B** (PreToolUse deny) is proven. **Layer A** (irreversible actions are sidecar-owned tools the worker never holds) remains primary; the hook is defense-in-depth.

## Not yet de-risked (later phases)
- **Hook → local HTTP sidecar** delivery (vs the exit-2 command hook used here) for richer, centralized policy decisions — P1/P2.
- **Resume + idempotency** after a mid-run crash — P1.
- **`tauri-plugin-pty`** embedded terminal on Windows 11 — P2 spike (Electron+node-pty fallback noted).
- **Concurrency at scale** (6–8 live workers, the spawn-depth cap) under real load — P1.
