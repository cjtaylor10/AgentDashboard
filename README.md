# AgentDashboard

**An autonomous multi-agent "AI company" harness with physically-enforced governance and a live web cockpit.**

AgentDashboard runs a council of role-based AI agents that builds software in gated loops — planning, implementing, testing, auditing, and merging — while you, the **Chair**, set the goals and hold the irreversible gates. Crucially, the governance is not decoration: approvals are enforced at a real chokepoint in orchestrator code, so a change reaches the main branch only when the independent reviewers actually pass it.

## Architecture: Claude is the worker, not the org

The load-bearing design decision is the separation of the *worker* from the *organization*:

- **Claude Code is the worker.** Each agent is a headless `claude.exe` process, spawned on its own isolated git worktree with a scoped tool set and a per-run USD budget. Workers do the thinking and write the code — but they never hold the ability to merge, push, deploy, or spend.
- **A Node sidecar is the long-lived orchestrator.** It owns durable state (SQLite in WAL mode), the budgets, the role roster, and the **enforced merge gate**. It assigns and verifies every agent's identity, runs the loop, and is the only component with the credentials to integrate code. A worker with a free shell still cannot bypass the gate, because the gate lives in sidecar code with sidecar-owned credentials — fail-closed by construction.

This is why Claude Code cannot simply *be* the company: the persistent, credential-holding, state-owning service has to live outside the worker.

## The 13 governance roles

The council folds a full org chart into a single auditable pipeline. Reviewers are deliberately **off the chain they police** — an approver may never be the author or downstream of the author.

**Leadership & planning**
- **Planner/Driver (CEO + COO)** — turns the Chair's goal into the smallest set of machine-checkable tickets; default answer to "should we add this?" is *no*.
- **CIO** — owns architectural direction and approves cross-domain or shared-infrastructure changes.

**Build (developer + domain leads)**
- **Developer** — implements exactly one ticket in an isolated worktree.
- **Frontend Lead** · **Backend Lead** · **Database Lead** — domain specialists the planner routes tickets to.

**Independent oversight gates** (read-only; report to no one they check)
- **Tester** — binds "done" to *demonstrated* behavior: actually runs the deliverable and observes real output.
- **Auditor** — adversarially verifies the diff and the tester's evidence against the goal; does not rubber-stamp.
- **Security** — reviews the diff for vulnerabilities (injection, info leaks, over-permission) and cites exact file/line.
- **Compliance** — checks changes against organisational policy and authors machine-checkable rules.

**Knowledge & continuity**
- **Research** — searches the wider world (web, docs, prior art) and surfaces options with sources.
- **Training** — analyses the last cycles' verdicts and proposes evidence-cited charter amendments — the self-improvement flywheel.
- **Documentation** — keeps the docs accurate to the system's current state and owns policy text.

## The gated cycle

Each cycle runs a fixed pipeline, and the sidecar **merges only if the tester, auditor, and security reviewer all pass**:

```
Chair goal
   → Planner/Driver writes tickets
   → routed to the Developer / domain Lead (isolated worktree)
   → Tester runs it for real
   → independent Auditor verifies against the goal
   → independent Security reviews the diff
   → sidecar merge gate: testPass && aligned && clean
        ✓ all pass  → merged to main
        ✗ any fails → withheld, change stays off main
```

Status flows from demonstrated state, never self-report. "Done" requires a real test run, not an agent's claim.

## Demonstrated self-improvement

Pointed at its own repository, the harness has driven its own code through this same gated pipeline — hardening agent permissions, de-noising the cockpit, adding org-health metrics — with the independent gates catching **real** security findings (XSS, prototype pollution, error-message info leaks) before they could merge. The Training role then mines those scars into charter amendments the Chair reviews and applies. The organization improves the organization, under the same change-management gate it applies to any code.

## The live cockpit

`npm run cockpit` serves a dependency-free web dashboard at **http://localhost:4317** — a Node HTTP + Server-Sent-Events server that streams live state from the SQLite spine:

- Org chart with INDEPENDENT-reviewer tags and current actions
- Kanban board of tickets and a change board with the named approver per merge
- Live activity stream and agent chat / console of real agent reasoning
- Spend-vs-cap meter and a **PAUSE-ALL** kill switch wired into the loop
- Multi-page navigation: Overview · Board · Council · Chat · Ideas · Cycles · Docs

An optional **Tauri 2 desktop app** wraps the same cockpit in a native window.

## Features

- **Enforced merge gate** — approvals checked in sidecar code with sidecar-owned credentials, not a bypassable hook.
- **Independent verification** — tester, auditor, security, and compliance sit off the dev chain.
- **Outcome-based status** — "done" means a real run, not a claim.
- **Hard brakes by default** — synchronous USD caps per run / cycle / day, spawn-depth and concurrency limits, a per-worker wall-clock timeout, and a global PAUSE-ALL.
- **One ingest spine, many views** — an append-only event log with thin projection tables; new visibility is one query plus one UI tab.
- **Anti-bloat by mandate** — the org must justify its own growth through the same gate it uses on code.
- **Zero npm dependencies** in the sidecar — Node 24's built-in `node:sqlite` and `node:http`.

## Runs on your Claude subscription — no API key

Workers authenticate through your host Claude login via **OAuth** (`claude.exe`). **No `ANTHROPIC_API_KEY` is required.** The tracked per-run cost is a usage-proxy for observability and the budget caps — it draws down your plan's usage limits rather than billing a separate metered charge. (Set an API key only if you want `--max-budget-usd` to act as a literal money guardrail.)

## Quick Start

You need **Claude Code** (logged into a Claude subscription) and **Node 24+**. Then:

```sh
git clone https://github.com/cjtaylor10/AgentDashboard
cd AgentDashboard/sidecar
npm run cockpit          # open http://localhost:4317
npm run autonomous       # in another terminal: run a self-improvement cycle
```

Full setup — including the Windows / macOS desktop app — is in **[INSTALL.md](INSTALL.md)**.
