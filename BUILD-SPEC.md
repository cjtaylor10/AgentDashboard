# AgentDashboard — Build Spec

**An autonomous multi-agent software organization, with a governance layer and a visibility cockpit.**

Status: **DRAFT v0.6** — the system now **develops itself** (`npm run self-cycle` / `self-loop`) and has redesigned its own cockpit: a cohesive **steel-blue** UI (Org · Kanban · Changes · Activity · Console · **agent Chat**), domain-routed roles (frontend-lead builds via the **impeccable** skill), a Security review step, and a **built native desktop app** in [`desktop/`](desktop/) (Tauri 2 — `agent-dashboard.exe` wraps the cockpit in a window). See [P0-FINDINGS.md](P0-FINDINGS.md).
Owner / "Chair": Carson. Last updated: 2026-06-02.

---

## 0. How to read this doc

This is the spec we build from. It encodes three decisions already made:

1. **Deliverable now:** this written spec (review → iterate → then build).
2. **Cockpit stack:** Tauri desktop (Electron is the named fallback).
3. **MVP shape:** prove the core loop **headless first** — 4 roles + the Chair, enforced gate, hard budget, kill switch, outcome-based test. No dashboard/terminal/crypto in v1.

Everything here is deliberately **lean**. A first design pass came back maximalist (crypto audit chains, a 4-runtime selector, a policy DSL, event-sourcing, 20 roles); adversarial review correctly called that "enterprise compliance machinery on a single-user local tool." We are **not** building that version. See [§3 Non-goals](#3-non-goals-what-we-are-deliberately-not-building-in-v1).

---

## 1. The one reframe everything rests on

**Claude Code is the *worker*, not the *org*.** Claude Code / the Agent SDK is a single-session reasoning+tool engine. It cannot be the persistent, multi-role company with durable state, budgets, and approval gates. So we build a small **orchestrator service** ("the **sidecar**") that lives outside Claude, owns the state and the rules, and *spawns Claude agents as workers*.

> Claude is the reasoning engine. The sidecar is the board harness.

### Three planes

```
┌──────────────────────────────────────────────────────────────┐
│  GOVERNANCE + VISIBILITY PLANE                                 │
│  SQLite (WAL) = single source of truth · Tauri cockpit · term  │
└──────────────────────────────────────────────────────────────┘
                     ▲ reads/writes        ▲ one WebSocket
┌──────────────────────────────────────────────────────────────┐
│  ORCHESTRATION PLANE  (the sidecar — long-lived TS process)    │
│  council-loop FSM · spawner · budget+brakes · enforcement gate │
└──────────────────────────────────────────────────────────────┘
                     ▲ spawns / hooks      │ spawns workers
┌──────────────────────────────────────────────────────────────┐
│  WORKER PLANE  (Claude agents, one per role spec)             │
│  headless Agent SDK runs · each on its own git worktree        │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Design principles (non-negotiable)

1. **Governance is only real if it's *enforced at a chokepoint*.** An "APPROVED" status field is decoration. Mutating actions (merge to `main`, deploy, spend, create-agent) are **physically blocked** unless a valid approval exists. This is the single load-bearing control. See [§8](#8-the-enforcement-chokepoint).
2. **Status flows from *demonstrated* state, never self-report.** A ticket is "done" because tests ran and the UI was actually exercised — not because an agent said so. See [§7 the loop](#7-the-council-loop-state-machine) + the Tester role.
3. **Independent verification, off the chain it polices.** Auditor / Security / Compliance never report to the people they check. Enforced by a constraint: *an approver may not be the author or downstream of the author*.
4. **Hard brakes on by default.** A synchronous dollar ceiling, a spawn-depth cap, and a concurrency cap exist *before* the first unattended run. Budget is not a "tune later" item. See [§9](#9-budgets-brakes--safety).
5. **The org must justify its own growth.** New roles/agents are added only through the same change-management gate the org uses on code. HR detects gaps; it cannot spawn. Anti-bloat applies to the roster itself.
6. **One ingest spine, many views.** All visibility derives from one append-only `event` log + thin projection tables. New visibility = one SQL view + one UI tab, never a new subsystem.

---

## 3. Non-goals (what we are deliberately NOT building in v1)

| Tempting | v1 instead | Why |
|---|---|---|
| HMAC hash-chained tamper-evident audit | Plain append-only table the app never updates/deletes | You hold every key on a single-user box; crypto attestation defends against a third party that doesn't exist |
| 4-runtime selector (Sessions/Teams/Workflows/Routines) | **One** path: sidecar spawns headless workers on worktrees | Four crash/resume models is the hardest thing in the design and proves nothing the MVP needs |
| Rego / policy-as-code DSL + Compliance author agent | ~6 approval rules as a unit-tested TypeScript function | More auditable than a DSL for a handful of rules; no new runtime |
| Event-sourcing / CQRS replay | Normal projection tables written in the same transaction | Replay-from-log scale benefit no single-user MVP needs |
| 20-role org chart | **4 roles + Chair** | Over-decomposition; most "roles" are one prompt with a different system message. Earn each later |
| Embedded terminal + cockpit in the first milestone | Headless loop + logs first | Don't couple proof-of-loop to the riskiest UI work |

Each of these is a *later* epic, earned through the org's own justification gate when a concrete need appears.

---

## 4. Components

### 4.1 Orchestrator sidecar (the board harness)
A long-lived **TypeScript** process (Bun or Node). Responsibilities:
- Drives the council-loop state machine ([§7](#7-the-council-loop-state-machine)).
- Spawns/role-specs/supervises worker agents; assigns each an unforgeable identity.
- Owns the **single SQLite writer** and the HTTP endpoint that receives Claude hook events.
- Enforces budgets, brakes, the kill switch, and the approval chokepoint **synchronously, in sidecar code** (not only in a hook).
- Performs all irreversible actions (push/merge/deploy/spend/create-agent) **itself**, with its own credentials, so agents cannot route around the gate.

### 4.2 Worker runtime (Claude)
Claude agents spawned **headless** via the Claude Agent SDK, one per role spec ([§6](#6-role--agent-config)). Each:
- Runs on its **own git worktree** (filesystem isolation; agents don't collide).
- Has a **scoped tool allowlist** — no direct push/merge/deploy/spend; those are sidecar-owned.
- Reports lifecycle via a shared **hooks** block that POSTs to the sidecar.
- Checkpoints via **conversation log + git commit** (SDK sessions persist conversation, not filesystem state). On crash: resume session, re-checkout the worktree branch.

### 4.3 State & data (SQLite, WAL)
One database, single-writer (the sidecar), WAL mode for concurrent reads. A sibling `artifacts/` dir holds large blobs (diffs, transcripts); the DB stores `path + content_hash`. See [§5](#5-data-model-lean).

### 4.4 Cockpit (LATER — not in headless MVP)
Tauri 2 (Rust core) + React 18 + TypeScript + Vite + Tailwind. One multiplexed WebSocket from the sidecar. Embedded `xterm.js` terminal via `tauri-plugin-pty`, bottom-docked, "follow-agent" mode + free shell. **Fallback:** Electron + `node-pty`, identical UI/spine. `impeccable` skill applied to the governance surfaces (status colors, planned-vs-built chips, alert hierarchy).

---

## 5. Data model (lean)

MVP tables only. (`message`, `channel`, `policy`, `doc`, `cycle`/`epic` detail arrive in later phases.)

```sql
-- append-only spine: the live feed + replay. App NEVER updates/deletes rows.
event(            id, ts, type, agent_id, session_id, payload_json )

-- org registry + live status
agent(            id, role, reports_to, status,            -- idle|working|blocked|error
                  current_action, model, skills_json,
                  parent_agent_id, depth,                  -- for spawn-depth cap
                  created_by_change_id, identity_token )   -- identity assigned by sidecar

-- mirrors the native Agent-Teams Task shape + governance overlay columns
ticket(           id, subject, description,
                  status,                                  -- pending|in_progress|completed (native)
                  owner, blocked_by_json,
                  kanban_column,                           -- overlay: Backlog|Todo|In Progress|In Review|Blocked|Done
                  goal_id, change_id )

goal(             id, text, owner_role, parent_goal_id, status )

-- governance state machine
change_request(   id, category, blast_radius,              -- routine|cross_domain|schema|deploy|spend|agent_creation|goal
                  summary, plan_hash, author_agent_id,
                  state,                                    -- planned|reviewed|approved|implemented|audited|rejected
                  created_ts )
approval(         id, change_id, approver_agent_id, decision, reason, ts )

-- money/tokens + safety
budget_ledger(    id, scope, scope_id, tokens, usd, ts, idempotency_key )  -- scope: run|agent|cycle|day|org
run(              id, cycle_id, agent_id, session_id, tokens, usd, started_ts, ended_ts )
kill_switch(      id, engaged, reason, ts )
```

**Source of truth:** `event` (append-only). Projection tables (`agent`, `ticket`, …) are written **in the same transaction** as the event — not rebuilt via a replay handler (we skip formal event-sourcing). Claude context is ephemeral and reconstructed from these tables on resume.

---

## 6. Role / agent config

Every agent is a durable row that **compiles down** to a real `.claude/agents/<role>.md` (system prompt + tool allowlist) plus a skill list. The sidecar owns the spec; the `.md` is a disposable projection.

```yaml
# role template (example: the MVP Developer)
role: developer
reports_to: planner-driver
model: claude-sonnet-4-6          # cost default for workers
charter: |
  You implement one ticket at a time on your own git worktree. You commit your work,
  but you CANNOT merge, push, deploy, or spend — request those via the sidecar tools.
  You write the minimum that satisfies the ticket's done_criteria. No scope creep.
tools_allow:                       # scoped — note what's absent
  - Read
  - Edit
  - Write
  - Bash(git add:*)
  - Bash(git commit:*)
  - mcp__harness__request_merge    # sidecar-owned; goes through the gate
skills: []                         # e.g. frontend lead: [anthropic-skills:impeccable]
budgets: { usd_per_agent: 5, tokens_per_agent: 400000 }
spawn:
  can_spawn_subagents: true
  max_depth: 3                     # org → lead → sub-dev, hard stop
```

**Skill attachment is declarative**, with a `fire_policy`:
- Frontend lead → `anthropic-skills:impeccable`, `fire_policy: always` (on UI build/critique).
- CEO/COO (later) → look-and-feel skills, `fire_policy: on_escalation` (only when a ticket carries an `escalation_flag`) — so execs don't seize the design role.

**Agent creation is a governed change.** The IT-Manager (later) is a *pure compiler*: it renders an *already-approved* spec into `.md` + a registry row, and can never decide *whether* an agent should exist. Creating an agent without an approved `change_request(category=agent_creation)` is blocked by the same chokepoint as a code merge.

---

## 7. The council loop (state machine)

The sidecar drives one explicit FSM. **MVP runs a single cycle** (rollover is later).

```
GOAL_INTAKE → PLAN → TICKET → ASSIGN → DEV → TEST → AUDIT → CHANGE_APPROVAL → GOAL_REALIGN → STOP
                                                                                  (→ ROLLOVER, later)
```

| State | What happens | Who |
|---|---|---|
| GOAL_INTAKE | Chair sets the goal (a `goal` row). | Chair |
| PLAN | Goal → a small set of tickets; default-NO on additions (anti-bloat). | Planner/Driver |
| TICKET | Tickets written to `ticket` (mirrors native TaskCreate). | Planner/Driver |
| ASSIGN | A ticket is claimed; a Developer is spawned on a fresh worktree. | sidecar |
| DEV | Build + commit on the worktree. Cannot merge. | Developer |
| TEST | Run the suite **and** drive the real UI (preview/browser tooling). "Done" requires demonstrated behavior. | Tester |
| AUDIT | Auditor writes its **expected** outcome *first*, then judges the diff vs the plan and confirms done_criteria by observed behavior. | Auditor |
| CHANGE_APPROVAL | A `change_request` must reach `approved` by a permitted authority; sidecar then performs the merge. | authority + sidecar |
| GOAL_REALIGN | Auditor confirms the work advanced the goal; **blocks STOP on a planned-vs-built delta**. | Auditor |

---

## 8. The enforcement chokepoint

The mechanism that makes the org real instead of theater. **Two layers, fail-closed:**

**Layer A — sidecar-owned actions (primary).** Workers have *no* direct ability to push/merge/deploy/spend/create-agent. They *request* these via sidecar tools (`mcp__harness__request_merge`, etc.). The sidecar runs `evaluate()` synchronously and only then acts, with its own credentials. A dead hook or a raw shell cannot bypass this, because the capability simply isn't in the worker's hands.

**Layer B — PreToolUse hook (defense-in-depth + telemetry).** A shared hook POSTs every mutating tool call to the sidecar; on timeout/error the tool is **denied**, and the denial is logged. (A P0 chaos test: kill the policy path mid-cycle and assert a merge attempt is *blocked*, not allowed.)

The policy is ~6 boolean checks — plain, unit-tested TypeScript, no DSL:

```ts
function evaluate(change, approvals, agents, budgets, killSwitch): { allow: boolean; reason: string } {
  if (killSwitch.engaged)                                   return deny("kill switch engaged");
  if (change.state !== "approved")                          return deny("no approved change_request");
  const appr = approvals.find(a => a.change_id === change.id && a.decision === "approve");
  if (!appr)                                                return deny("no approval token");
  if (!authorityMap[change.category]?.includes(roleOf(appr.approver_agent_id)))
                                                            return deny("approver lacks authority for this category/blast_radius");
  if (appr.approver_agent_id === change.author_agent_id ||
      isDownstream(appr.approver_agent_id, change.author_agent_id, agents))
                                                            return deny("separation-of-duties: approver is author or downstream");
  if (overBudget(budgets, change))                          return deny("budget cap reached");
  return allow();
}
```

> **Note on "planned == implemented":** we do *not* ship brittle byte-equality of plan vs result. The **Auditor judges the diff** against its pre-written expectation. `plan_hash` is recorded for traceability; equality gating is reserved for genuinely hashable artifacts.

**The authority map** (data, Chair-editable out-of-band only):

| Change category | Who may approve |
|---|---|
| routine code | Developer's lead (MVP: Planner/Driver) |
| cross-domain / API | CIO (later) |
| schema / data / security | CIO + Security + Auditor quorum (later) |
| new feature / agent / dependency | COO devil's-advocate + justification (later) |
| goal change | CEO + COO co-sign, or Chair |
| irreversible (prod deploy, real spend, head-count, Auditor override, editing this map) | **Chair** |

**Identity** is assigned and verified by the sidecar; agents never self-declare who they are (otherwise "approver ≠ author" is meaningless).

---

## 9. Budgets, brakes & safety

On by default, with concrete starting numbers (tune later via "spend per completed ticket"):

- **Hard USD ceilings**, checked synchronously at spawn/spend inside the single-writer transaction: ~$20/run, $5/agent-lifetime, $50/cycle, $200/day org-wide. **Hard-stop at 100%** (not throttle).
- **Dead-man's switch:** PAUSE-ALL if spend-rate exceeds $X/min regardless of caps.
- **Spawn-depth cap = 3** (org → lead → sub-dev) and **concurrent-live-agents cap = 6–8**, enforced by the spawner — independent of any LLM "circuit breaker." This catches a *productive-looking* recursive explosion that progress-detectors miss.
- **Global PAUSE-ALL kill switch** (`kill_switch` row), one click / one call.
- **Idempotency:** every spend/spawn/merge is keyed by an idempotency token so crash-resume is a no-op if the effect already landed. On startup the sidecar reconciles in-flight runs and **quarantines** (does not auto-resume) any whose ledger/state is ambiguous, raising it to the Chair.
- **Process isolation:** the sidecar (orchestrator + SQLite writer + kill switch) runs in its **own process**, separate from in-process workers, so a worker crash can't take down the thing that can stop everything.

---

## 10. The MVP (headless-first)

**Goal:** prove the core loop and the four load-bearing mechanisms end-to-end, on real SDK primitives, **before** any cockpit.

**Roles (4 + Chair):**
- **Planner/Driver** — folds CEO+COO for v1: goal → tickets, drives the loop, holds the default-NO anti-bloat gate.
- **Developer** — claims a ticket, builds + commits on its own worktree.
- **Auditor** — independent (off the dev chain), self-grounded verification, gates rollover.
- **Tester** — outcome-based: runs tests + clicks the real UI.
- **Chair (you)** — sets the goal, holds irreversible gates, approve/deny, kill switch.

**Demonstrable end-to-end:** Chair sets a goal → Planner makes tickets → a Developer builds + commits something real on a worktree → Tester runs the suite **and drives the UI** so "done" is demonstrated → Auditor (expectation written first) judges the diff and confirms the goal advanced → the merge is **blocked until** an `approved` change exists, then the sidecar performs it → every step lands in the `event` log and is replayable.

### Acceptance criteria (the MVP is done when…)
- [ ] **Enforced gate:** a merge attempt with no approval is **blocked** and the block is in the audit log.
- [ ] **Hard budget + kill switch:** hitting the cap halts the loop; PAUSE-ALL halts immediately.
- [ ] **Outcome-based verification:** "done" requires a real test run + a real UI interaction (not an agent's claim).
- [ ] **Per-loop goal re-check:** the Auditor blocks STOP on a planned-vs-built delta.
- [ ] The full single cycle is **replayable from the `event` log**.

**Explicitly out of MVP:** the cockpit + embedded terminal, the crypto audit chain, the message bus, Agent-Teams/Workflows/Routines runtimes, dynamic agent creation, cycle-to-cycle rollover, roles 5–20.

---

## 11. Roadmap

| Phase | Goal | Key deliverables |
|---|---|---|
| **P0 — Spike & de-risk** ✅ DONE | Prove the load-bearing assumptions | Sidecar `git init`s the workspace + seeds a base branch; **verify worktree spawn on Windows 11**; verify headless Agent-SDK spawn with scoped tools + hooks delivering PreToolUse/Stop to the sidecar; confirm hook payload shapes; record Tauri-vs-Electron decision as an ADR after a `tauri-plugin-pty` spike |
| **P1 — Headless loop + brakes** ✅ DONE | The MVP ([§10](#10-the-mvp-headless-first)) | Sidecar FSM; SQLite spine; spawner + worktrees; synchronous budget + PAUSE-ALL; 4 roles; enforced gate; outcome test; goal-realign; logs-only output |
| **P2 — Cockpit shell** ✅ (web-first) | See it run & stop | Tauri shell + one WebSocket; Live Activity (org chart + "who's doing what now"); LoopControlBar (spend vs cap, PAUSE-ALL); bottom-docked terminal (follow-agent) |
| **P3 — Boards & change mgmt UI** | Visible governance | Kanban (from tickets); Change Board with named-approver cards + one-click Chair approve/deny; streaming audit view |
| **P4 — Comms & doc rigor** | Org talks; docs stay true | DB-backed message bus + channels + @mentions + speak-worthiness gate; Documentation/underwriter + doc-drift PreClose gate; circuit breakers |
| **P5 — Org growth under governance** | Earn the full org | role_template + skill_registry; IT-Manager compiler path; CIO + FE/BE/DB leads + Security + Compliance + CFO + HR, each via its own justification change; cycle rollover + complexity budget |

---

## 12. Tech stack summary

| Layer | Choice | Fallback / note |
|---|---|---|
| Orchestrator | TypeScript on **Node** (Bun absent on host) | long-lived, single SQLite writer |
| Workers | **`claude.exe -p` headless** (stream-json) on git worktrees | P0-confirmed: OAuth, tool-scoping, `--max-budget-usd`, PreToolUse block all work |
| DB | **SQLite (WAL)** (`bun:sqlite` / `better-sqlite3`) + `artifacts/` dir | ports to Postgres unchanged if ever multi-user |
| Cockpit (P2+) | **Tauri 2** + React 18 + TS + Vite + Tailwind | **Electron + node-pty** fallback |
| Terminal | `xterm.js` + `tauri-plugin-pty` | node-pty under Electron |
| Models | Opus → Auditor/Planner (judgment); Sonnet → Dev/Tester (cost) | see open decisions |

---

## 13. Open decisions to track

1. **Budget calibration vs throughput** — starting caps in [§9](#9-budgets-brakes--safety) are a guess; tune via "spend per completed ticket" and "time blocked on gates."
2. **Model per role** — does the **Auditor need Opus** to avoid being the cheap rubber-stamp the design fears? (Leaning yes.)
3. **Governance depth by blast_radius** — full ceremony only above a threshold (schema/deploy/spend/agent-creation); routine edits get Tester + single Auditor. Keep a "governance tokens per ticket" metric with an alert if it exceeds ~3× build tokens.
4. **Chair override for flaky LLM judges** — doc-drift / policy judges are probabilistic; there must be a Chair path so a false-positive can't deadlock closure. Back every LLM gate with a cheap deterministic check (lint/AST/signature) that does the actual gating.
5. **Agent Teams dependency** (P5) — experimental flag, 16-agent ceiling; confirm a subagents-under-a-lead fallback before relying on it.
6. **Scheduling ownership** — the **sidecar** owns the authoritative schedule; cron/Routines are session-only and expire, so they only *poll*.
7. **Head-count cap + simplification cadence** — max org size you authorize, and how often a mandatory simplification cycle runs.

---

## 14. The point

This system is meant to get better by **using itself to build itself**, then to build other software. That only works if the governance is load-bearing from day one — which is why the MVP proves the *gate, the brakes, the outcome-test, and the goal-recheck* before it proves anything pretty.
