// Cockpit server (BUILD-SPEC §4.4, web-first). A dependency-free HTTP + SSE server that reads the
// SQLite spine and streams live state to the browser dashboard. Decoupled from the loop: it POLLS the
// WAL db (which the cycle process writes) and pushes a snapshot whenever something changes. Also exposes
// the PAUSE-ALL kill switch the loop checks before every model call.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, addIdea } from './db.js';
import { BUDGETS, sidecarDir, paths } from './config.js';

const webDir = path.join(sidecarDir, 'web');
const PORT = Number(process.env.COCKPIT_PORT || 4317);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export function selectVisibleAgents(agents, cap = 16) {
  const working = agents.filter(a => a.status === 'working');
  const others = agents.filter(a => a.status !== 'working');
  return [...working, ...others].slice(0, cap);
}

export function computeMetrics({ spendUsd, runs, ticketsTotal, ticketsDone }) {
  return {
    spendUsd,
    runs,
    ticketsTotal,
    ticketsDone,
    costPerRun: runs > 0 ? Number((spendUsd / runs).toFixed(4)) : 0,
  };
}

export function truncate(text, max) {
  return text.length <= max ? text : text.slice(0, max - 3) + '...';
}

export function shortId(id) {
  if (id == null) return '';
  const i = id.lastIndexOf('-');
  return i === -1 ? id : id.slice(i + 1);
}

export function workerEventToLine(ev) {
  // Reduce a worker.* event row to a short human-readable text line.
  // Returns null for noisy framing events that clutter the console.
  // Columns available: id, ts, type, agent_id, payload_json
  const agent = ev.agent_id ? `[${ev.agent_id}] ` : '';
  let body = '';
  try {
    if (ev.payload_json) {
      const p = JSON.parse(ev.payload_json);
      // Drop framing / meta events entirely
      if (p.type === 'system' || p.type === 'user' || p.type === 'rate_limit_event') return null;
      // prefer assistant text content
      if (p.type === 'assistant' && Array.isArray(p.message?.content)) {
        const txt = p.message.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!txt) return null;
        body = truncate(txt, 120);
      } else if (p.type === 'result') {
        // result events with no text body are noise
        const txt = (typeof p.text === 'string' ? p.text : '').trim();
        if (!txt) return null;
        body = truncate(txt, 120);
      } else if (p.type === 'content_block_delta' && p.delta?.type === 'text_delta' && p.delta.text) {
        const txt = p.delta.text.replace(/\n/g, ' ').trim();
        body = truncate(txt, 120);
      } else if (p.type === 'tool_use' && p.name) {
        body = `tool: ${p.name}`;
      } else if (p.name) {
        body = `tool: ${p.name}`;
      } else if (p.type) {
        body = p.type;
      }
    }
  } catch { /* ignore parse errors */ }
  if (!body) body = (ev.type || '').replace('worker.', '');
  const ts = (ev.ts || '').slice(11, 19);
  return `${ts} ${agent}${body}`;
}

function snapshot(db) {
  const goal = db.prepare('SELECT id, text, status FROM goal ORDER BY created_ts DESC LIMIT 1').get() || null;
  const ks = db.prepare('SELECT engaged, reason FROM kill_switch WHERE id = 1').get() || { engaged: 0 };
  const sp = db.prepare('SELECT COALESCE(SUM(usd),0) usd, COUNT(*) runs FROM run').get();
  const cyc = db.prepare("SELECT type FROM event WHERE type LIKE 'cycle.%' ORDER BY id DESC LIMIT 1").get();

  // Fetch recent worker.* events with payload for the console pane.
  // We select payload_json so we can produce human-readable lines server-side.
  let consoleLines = [];
  try {
    const workerRows = db.prepare(
      "SELECT id, ts, type, agent_id, payload_json FROM event WHERE type LIKE 'worker.%' ORDER BY id DESC LIMIT 150"
    ).all();
    // Reverse so oldest is at top, filter framing events, keep most recent 40 non-null lines.
    const allLines = workerRows.reverse().map(workerEventToLine).filter(l => l != null && l !== '');
    consoleLines = allLines.slice(-40);
  } catch { /* table may lack payload_json column in older schemas; degrade gracefully */ }

  const ticketTotal = db.prepare('SELECT COUNT(*) AS total FROM ticket').get();
  const ticketDone = db.prepare("SELECT COUNT(*) AS done FROM ticket WHERE kanban_column='Done'").get();

  const allAgents = db.prepare('SELECT id, role, reports_to, status, current_action, model FROM agent ORDER BY role, id').all();
  const agentTotal = allAgents.length;
  const agents = selectVisibleAgents(allAgents, 16);

  return {
    goal,
    killSwitch: { engaged: ks.engaged === 1, reason: ks.reason || null },
    spend: { usd: sp.usd, runs: sp.runs, capCycle: BUDGETS.usdPerCycle, capDay: BUDGETS.usdPerDay },
    cycleState: cyc ? cyc.type.replace('cycle.', '') : null,
    agentTotal,
    agents,
    tickets: db.prepare('SELECT id, subject, status, kanban_column FROM ticket ORDER BY created_ts').all(),
    changes: db.prepare('SELECT id, category, state, summary, author_agent_id FROM change_request ORDER BY created_ts DESC').all(),
    approvals: db.prepare('SELECT change_id, approver_agent_id, decision, reason FROM approval ORDER BY ts DESC').all(),
    events: db.prepare('SELECT id, ts, type, agent_id FROM event ORDER BY id DESC LIMIT 60').all(),
    console: consoleLines,
    metrics: computeMetrics({ spendUsd: sp.usd, runs: sp.runs, ticketsTotal: ticketTotal.total, ticketsDone: ticketDone.done }),
    ideas: db.prepare('SELECT id, text, author, status, council_note, created_ts FROM idea ORDER BY created_ts DESC LIMIT 50').all(),
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
    if (req.method === 'POST' && url.pathname === '/api/ideas') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
      req.on('end', () => {
        try {
          const text = String(JSON.parse(body || '{}').text || '').trim();
          if (!text) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"empty"}'); }
          const id = addIdea(db, { text: text.slice(0, 2000) });
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, id }));
        } catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"ok":false}'); }
      });
      return;
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
