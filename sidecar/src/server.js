// Cockpit server (BUILD-SPEC §4.4, web-first). A dependency-free HTTP + SSE server that reads the
// SQLite spine and streams live state to the browser dashboard. Decoupled from the loop: it POLLS the
// WAL db (which the cycle process writes) and pushes a snapshot whenever something changes. Also exposes
// the PAUSE-ALL kill switch the loop checks before every model call.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { BUDGETS, sidecarDir, paths } from './config.js';

const webDir = path.join(sidecarDir, 'web');
const PORT = Number(process.env.COCKPIT_PORT || 4317);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function snapshot(db) {
  const goal = db.prepare('SELECT id, text, status FROM goal ORDER BY created_ts DESC LIMIT 1').get() || null;
  const ks = db.prepare('SELECT engaged, reason FROM kill_switch WHERE id = 1').get() || { engaged: 0 };
  const sp = db.prepare('SELECT COALESCE(SUM(usd),0) usd, COUNT(*) runs FROM run').get();
  const cyc = db.prepare("SELECT type FROM event WHERE type LIKE 'cycle.%' ORDER BY id DESC LIMIT 1").get();
  return {
    goal,
    killSwitch: { engaged: ks.engaged === 1, reason: ks.reason || null },
    spend: { usd: sp.usd, runs: sp.runs, capCycle: BUDGETS.usdPerCycle, capDay: BUDGETS.usdPerDay },
    cycleState: cyc ? cyc.type.replace('cycle.', '') : null,
    agents: db.prepare('SELECT id, role, reports_to, status, current_action, model FROM agent ORDER BY role, id').all(),
    tickets: db.prepare('SELECT id, subject, status, kanban_column FROM ticket ORDER BY created_ts').all(),
    changes: db.prepare('SELECT id, category, state, summary, author_agent_id FROM change_request ORDER BY created_ts DESC').all(),
    approvals: db.prepare('SELECT change_id, approver_agent_id, decision, reason FROM approval ORDER BY ts DESC').all(),
    events: db.prepare('SELECT id, ts, type, agent_id FROM event ORDER BY id DESC LIMIT 60').all(),
  };
}

const sig = (s) => JSON.stringify([s.events[0]?.id ?? 0, s.spend.usd, s.killSwitch.engaged, s.cycleState,
  s.tickets.map((t) => t.kanban_column), s.changes.map((c) => c.state), s.agents.map((a) => a.status)]);

export function startCockpit() {
  const db = openDb();
  const clients = new Set();
  const send = (res, snap) => { try { res.write('data: ' + JSON.stringify(snap) + '\n\n'); } catch { /* dropped */ } };

  let last = '';
  setInterval(() => {
    try {
      const snap = snapshot(db);
      const s = sig(snap);
      if (s !== last) { last = s; for (const res of clients) send(res, snap); }
    } catch { /* db mid-write; try next tick */ }
  }, 700);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/kill') {
      db.prepare("UPDATE kill_switch SET engaged = 1, reason = ?, ts = datetime('now') WHERE id = 1").run('paused from cockpit');
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}');
    }
    if (req.method === 'POST' && url.pathname === '/api/resume') {
      db.prepare("UPDATE kill_switch SET engaged = 0, reason = NULL, ts = datetime('now') WHERE id = 1").run();
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(snapshot(db)));
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      send(res, snapshot(db));
      clients.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* closed */ } }, 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }

    // static files
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(webDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(webDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); res.end('not found');
  });

  server.listen(PORT, () => {
    console.log(`[cockpit] http://localhost:${PORT}`);
    console.log(`[cockpit] reading ${paths.db}`);
    console.log('[cockpit] in another terminal, run:  npm run cycle');
  });
  return server;
}
