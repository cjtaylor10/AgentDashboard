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

## Run the spine smoke test

```sh
node --no-warnings scripts/prove-spine.js     # or: npm run prove
node --no-warnings scripts/reset.js           # or: npm run reset  (clean slate)
```

Spawns one real (small, budget-capped) model call. Override the worker binary with `CLAUDE_BIN`.

## Status

P1 first slice — the spine (spawn → isolate → persist → query). Next: the council-loop FSM
(PLAN → TICKET → ASSIGN → DEV → TEST → AUDIT → CHANGE_APPROVAL → GOAL_REALIGN) + the 4 MVP roles +
the enforcement chokepoint.
