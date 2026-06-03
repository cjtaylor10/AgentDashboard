// Lightweight append-only event store backed by SQLite (node:sqlite, Node >=24).
// Exposes append_event(type, payload) as the single write path.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipeline_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT
);
`;

/**
 * Create (or open) an event store at dbPath.
 * If dbPath is omitted a temp file is used (useful for tests).
 *
 * Returns { append_event, get_events, close, dbPath }.
 */
export function createEventStore(dbPath) {
  if (!dbPath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdash-events-'));
    dbPath = path.join(dir, 'events.db');
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  return {
    /** Append an event synchronously. */
    append_event(type, payload) {
      db.prepare('INSERT INTO pipeline_event (ts, type, payload_json) VALUES (?, ?, ?)')
        .run(new Date().toISOString(), type, JSON.stringify(payload ?? null));
    },

    /** Return all events (optionally filtered by type), newest-last. */
    get_events(type) {
      const rows = type
        ? db.prepare('SELECT * FROM pipeline_event WHERE type = ? ORDER BY id').all(type)
        : db.prepare('SELECT * FROM pipeline_event ORDER BY id').all();
      return rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        type: r.type,
        payload: r.payload_json ? JSON.parse(r.payload_json) : null,
      }));
    },

    close() {
      db.close();
    },

    dbPath,
  };
}
