// The governance spine: one SQLite (WAL) database, single-writer (this sidecar).
// node:sqlite is built into Node >=24 — zero native dependencies.
// Design (BUILD-SPEC §5): one append-only `event` log is the source of truth;
// the other tables are thin projections written in the same transaction. No event-sourcing replay,
// no crypto chain — deliberately lean for v1.
import { DatabaseSync } from 'node:sqlite';
import { paths, ensureDirs } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  agent_id     TEXT,
  session_id   TEXT,
  payload_json TEXT
);

CREATE TABLE IF NOT EXISTS agent (
  id                  TEXT PRIMARY KEY,
  role                TEXT NOT NULL,
  reports_to          TEXT,
  status              TEXT NOT NULL DEFAULT 'idle',
  current_action      TEXT,
  model               TEXT,
  skills_json         TEXT,
  parent_agent_id     TEXT,
  depth               INTEGER NOT NULL DEFAULT 0,
  created_by_change_id TEXT,
  identity_token      TEXT,
  worktree_path       TEXT,
  created_ts          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goal (
  id             TEXT PRIMARY KEY,
  text           TEXT NOT NULL,
  owner_role     TEXT,
  parent_goal_id TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  created_ts     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket (
  id             TEXT PRIMARY KEY,
  subject        TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',   -- native Task vocab: pending|in_progress|completed
  owner          TEXT,
  blocked_by_json TEXT,
  kanban_column  TEXT NOT NULL DEFAULT 'Backlog',   -- overlay: Backlog|Todo|In Progress|In Review|Blocked|Done
  goal_id        TEXT,
  change_id      TEXT,
  created_ts     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS change_request (
  id              TEXT PRIMARY KEY,
  category        TEXT NOT NULL,                     -- routine|cross_domain|schema|deploy|spend|agent_creation|goal
  blast_radius    TEXT NOT NULL DEFAULT 'routine',
  summary         TEXT,
  plan_hash       TEXT,
  author_agent_id TEXT,
  state           TEXT NOT NULL DEFAULT 'planned',   -- planned|reviewed|approved|implemented|audited|rejected
  created_ts      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval (
  id                TEXT PRIMARY KEY,
  change_id         TEXT NOT NULL,
  approver_agent_id TEXT,
  decision          TEXT NOT NULL,                   -- approve|deny
  reason            TEXT,
  ts                TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scope           TEXT NOT NULL,                     -- run|agent|cycle|day|org
  scope_id        TEXT,
  tokens          INTEGER DEFAULT 0,
  usd             REAL DEFAULT 0,
  ts              TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS run (
  id          TEXT PRIMARY KEY,
  cycle_id    TEXT,
  agent_id    TEXT,
  session_id  TEXT,
  tokens      INTEGER DEFAULT 0,
  usd         REAL DEFAULT 0,
  started_ts  TEXT,
  ended_ts    TEXT
);

CREATE TABLE IF NOT EXISTS kill_switch (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  engaged INTEGER NOT NULL DEFAULT 0,
  reason  TEXT,
  ts      TEXT
);
INSERT OR IGNORE INTO kill_switch (id, engaged) VALUES (1, 0);
`;

export function nowIso() {
  return new Date().toISOString();
}

export function openDb() {
  ensureDirs();
  const db = new DatabaseSync(paths.db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// --- append-only spine ---
export function insertEvent(db, { type, agentId = null, sessionId = null, payload = null }) {
  db.prepare(
    'INSERT INTO event (ts, type, agent_id, session_id, payload_json) VALUES (?, ?, ?, ?, ?)'
  ).run(nowIso(), type, agentId, sessionId, payload == null ? null : JSON.stringify(payload));
}

// --- projections ---
export function upsertAgent(db, a) {
  db.prepare(
    `INSERT INTO agent (id, role, reports_to, status, current_action, model, skills_json,
                        parent_agent_id, depth, worktree_path, identity_token, created_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status, current_action=excluded.current_action, worktree_path=excluded.worktree_path`
  ).run(
    a.id, a.role, a.reports_to ?? null, a.status ?? 'idle', a.current_action ?? null,
    a.model ?? null, a.skills_json ?? null, a.parent_agent_id ?? null, a.depth ?? 0,
    a.worktree_path ?? null, a.identity_token ?? null, nowIso()
  );
}

export function setAgentStatus(db, id, status, currentAction = null) {
  db.prepare('UPDATE agent SET status = ?, current_action = ? WHERE id = ?').run(status, currentAction, id);
}

export function recordRun(db, r) {
  db.prepare(
    'INSERT INTO run (id, cycle_id, agent_id, session_id, tokens, usd, started_ts, ended_ts) VALUES (?,?,?,?,?,?,?,?)'
  ).run(r.id, r.cycleId ?? null, r.agentId ?? null, r.sessionId ?? null, r.tokens ?? 0, r.usd ?? 0, r.startedTs ?? null, r.endedTs ?? null);
}

export function isKilled(db) {
  return db.prepare('SELECT engaged FROM kill_switch WHERE id = 1').get()?.engaged === 1;
}
