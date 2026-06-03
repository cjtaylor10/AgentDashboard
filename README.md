# AgentDashboard

An autonomous multi-agent **software organization** — a council of role-based agents (CEO/COO, developers, auditor, testers, security, compliance…) that builds software in loops — wrapped in a **governance layer** (separation of duties, enforced change-management approvals, anti-bloat) and a **visibility cockpit** (live org chart, Kanban, team/global chat, change board, and an embedded terminal).

You are the **Chair**: you set goals and hold the irreversible gates. The agents do the work, check each other, and keep the docs and roadmap honest — all visible, all governed.

## Core idea

Claude is the **worker**, not the org. A small local **orchestrator service** (the "sidecar") owns the loop, the state, the budgets, and the approval gates, and spawns Claude agents as workers. See **[BUILD-SPEC.md](BUILD-SPEC.md)** for the full design.

## Status

🟡 **Design phase.** [BUILD-SPEC.md](BUILD-SPEC.md) is `DRAFT v0.1`, under review. No code yet.

**Next:** finalize the spec → P0 de-risk spike → P1 headless MVP (4 roles + Chair: prove the enforced gate, hard budget + kill switch, outcome-based test, and per-loop goal re-check end-to-end before building the cockpit).

## Stack (planned)

TypeScript/Bun sidecar · Claude Agent SDK workers on git worktrees · SQLite (WAL) · Tauri 2 + React cockpit (Electron fallback) · `xterm.js` terminal.
