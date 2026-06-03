# sidecar

The orchestrator service for AgentDashboard — the long-lived process that owns the council loop,
durable state, budgets, the enforcement chokepoint, and spawns Claude workers. Claude is the
worker; this is the board harness. See [`../BUILD-SPEC.md`](../BUILD-SPEC.md).

**No dependencies** — uses Node 24's built-in `node:sqlite`. Just Node + the `claude` CLI.

## Layout

```
src/
  config.js     paths, the claude binary, budget defaults
  db.js         node:sqlite spine — append-only event log + projection tables
  worktree.js   git worktree isolation (one branch/dir per agent)
  worker.js     spawn a headless `claude -p` worker, stream its events
scripts/
  prove-spine.js  P1 smoke test: spawn 1 worker -> events into SQLite -> read back
  reset.js        wipe runtime state (workspace, worktrees, db) for a clean re-run
```

## Run the proofs

```sh
npm run prove           # spine: spawn 1 worker -> events into SQLite -> read back
npm run prove:enforce   # chokepoint: work reaches master ONLY via an authorized approval
npm run cycle           # full council cycle: goal -> plan -> build -> test -> audit -> gated merge
npm run cockpit         # live dashboard at http://localhost:4317 (watch the org work; PAUSE-ALL)
npm run reset           # wipe runtime state (workspace, worktrees, db) for a clean slate
```

Each spawns one real (small, budget-capped) model call. Override the worker binary with `CLAUDE_BIN`.

## Status

**P1 — the headless MVP — runs.** Proven in running code:
- the **spine** — `prove-spine.js`: spawn → isolate (git worktree) → persist (event log) → query back.
- the **enforcement chokepoint** — `prove-enforcement.js`: no-approval merge blocked; author self-approval
  blocked by separation-of-duties; authorized approval merged by the sidecar; a worker cannot self-merge
  (Layer-B PreToolUse hook + Layer-A sidecar-owned merge).
- the **council loop** — `run-cycle.js`: one goal taken GOAL_INTAKE → PLAN → TICKET → ASSIGN → DEV → TEST
  → AUDIT → CHANGE_APPROVAL → GOAL_REALIGN by 4 role agents (Planner/Driver, Developer, outcome-based
  Tester, independent Auditor), with budget + kill-switch checks before every model call.

- the **cockpit (web-first)** — `run-cycle` aside, `npm run cockpit` serves a live dashboard at
  http://localhost:4317 (org chart, kanban, change board, activity stream, spend, PAUSE-ALL) as read
  models over the SQLite spine via SSE.

Next: embedded xterm.js terminal + optional Tauri desktop wrapper; cycle-to-cycle rollover; more org roles.
