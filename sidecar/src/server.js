// Cockpit server (BUILD-SPEC §4.4, web-first). A dependency-free HTTP + SSE server that reads the
// SQLite spine and streams live state to the browser dashboard. Decoupled from the loop: it POLLS the
// WAL db (which the cycle process writes) and pushes a snapshot whenever something changes. Also exposes
// the PAUSE-ALL kill switch the loop checks before every model call.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, addIdea } from './db.js';
import { BUDGETS, sidecarDir, paths } from './config.js';
import { ROLES } from './roles.js';

const webDir = path.join(sidecarDir, 'web');
const PORT = Number(process.env.COCKPIT_PORT || 4317);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// Pick the CURRENT team out of the full (often 100+) agent history so the Org panel
// stays legible. Always keep every working agent; then top up with the most-recently
// created non-working agents. When work is happening the long idle tail is dropped
// (filled only up to `cap`); when nothing is working we still show just a small
// number of the newest agents (`idleFloor`) instead of the entire roster.
export function selectVisibleAgents(agents, cap = 12, idleFloor = 6) {
  const byNewest = (a, b) => String(b.created_ts || '').localeCompare(String(a.created_ts || ''));
  const working = agents.filter(a => a.status === 'working');
  const others = agents.filter(a => a.status !== 'working').sort(byNewest);
  // Reserve room for every working agent, but never show more than `cap` total and,
  // when nothing is working, never more than `idleFloor` idle rows.
  const fillTarget = working.length > 0 ? cap : idleFloor;
  const fillCount = Math.max(0, Math.min(others.length, fillTarget - working.length));
  return [...working, ...others.slice(0, fillCount)].slice(0, cap);
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
  // Reduce a worker.* event row (or raw event object) to a short human-readable text line.
  // Returns null for noisy framing events that clutter the console.
  // Accepts either a DB row with payload_json or a raw event object directly.
  const agent = ev.agent_id ? `[${ev.agent_id}] ` : '';
  let body = '';
  try {
    // Support both DB rows (with payload_json) and raw event objects passed directly
    const p = ev.payload_json ? JSON.parse(ev.payload_json) : ev;
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
      switch (p.name) {
        case 'Bash':
          body = 'bash: ' + truncate(String(p.input?.command ?? ''), 120);
          break;
        case 'Edit':
          body = 'edit: ' + (p.input?.file_path ?? '');
          break;
        case 'Write':
          body = 'write: ' + (p.input?.file_path ?? '');
          break;
        case 'Read':
          body = 'read: ' + (p.input?.file_path ?? '');
          break;
        case 'Glob':
          body = 'glob: ' + (p.input?.pattern ?? '');
          break;
        case 'Grep':
          body = 'grep: ' + (p.input?.pattern ?? '');
          break;
        default: {
          const firstKey = p.input ? Object.keys(p.input)[0] : null;
          const firstVal = firstKey != null ? p.input[firstKey] : '';
          body = `tool/${p.name}: ` + String(firstVal ?? '');
        }
      }
    } else if (p.type === 'tool_result') {
      if (typeof p.content === 'string' && p.content.length > 0) {
        return '→ ' + p.content.slice(0, 120);
      }
      return null;
    } else if (p.name) {
      body = `tool: ${p.name}`;
    } else if (p.type) {
      body = p.type;
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

  const allAgents = db.prepare('SELECT id, role, reports_to, status, current_action, model, created_ts FROM agent ORDER BY role, id').all();
  const agentTotal = allAgents.length;
  const agents = selectVisibleAgents(allAgents, 12);

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
    if (req.method === 'GET' && url.pathname === '/api/cycles') {
      try {
        const rows = db.prepare(
          "SELECT id, ts, type, payload_json FROM event WHERE type LIKE 'cycle.%' ORDER BY id ASC"
        ).all();

        // Group events by cycleId (present in payload of every runCycle event)
        const cycleMap = new Map(); // cycleId string -> { firstTs, lastTs, goalId, lastState }
        for (const row of rows) {
          let payload = null;
          try { payload = row.payload_json ? JSON.parse(row.payload_json) : null; } catch { /* skip */ }
          const cid = payload?.cycleId;
          if (!cid) continue; // autonomous_plan / autonomous_goal have no cycleId
          if (!cycleMap.has(cid)) cycleMap.set(cid, { firstTs: row.ts, lastTs: row.ts, goalId: null, lastState: null });
          const entry = cycleMap.get(cid);
          entry.lastTs = row.ts;
          entry.lastState = row.type.replace('cycle.', '');
          if (row.type === 'cycle.goal_intake' && payload.goalId) entry.goalId = payload.goalId;
        }

        let seq = 0;
        const summaries = [];
        for (const [, entry] of cycleMap) {
          seq++;
          let goal = '';
          if (entry.goalId) {
            const gr = db.prepare('SELECT text FROM goal WHERE id = ?').get(entry.goalId);
            if (gr) goal = gr.text;
          }
          const startMs = new Date(entry.firstTs).getTime();
          const endMs = new Date(entry.lastTs).getTime();
          summaries.push({
            cycleId: seq,
            goal,
            startedAt: entry.firstTs,
            terminalState: entry.lastState ?? 'unknown',
            durationSecs: Number(((endMs - startMs) / 1000).toFixed(2)),
          });
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(summaries));
      } catch (e) {
        console.error('[cockpit] /api/cycles error:', e.message);
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"internal error"}');
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/insights') {
      try {
        // Training proposals: the array the training agent wrote to policy-refinements.json.
        // Read safely — file may be missing on a fresh install or contain invalid JSON.
        let trainingProposals = [];
        try {
          const raw = fs.readFileSync(path.join(paths.data, 'policy-refinements.json'), 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) trainingProposals = parsed;
        } catch { /* missing or invalid — leave as [] */ }

        // Research briefs: payloads of the 10 most recent research_brief events.
        // Parse each payload defensively and expose only its .brief field.
        let researchBriefs = [];
        try {
          const rows = db.prepare(
            "SELECT payload_json FROM event WHERE type = 'research_brief' ORDER BY id DESC LIMIT 10"
          ).all();
          researchBriefs = rows.map((r) => {
            try { return JSON.parse(r.payload_json || '{}').brief ?? null; } catch { return null; }
          }).filter((b) => b != null);
        } catch { /* table/column shape may differ — leave as [] */ }

        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ trainingProposals, researchBriefs }));
      } catch (e) {
        console.error('[cockpit] /api/insights error:', e.message);
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"internal error"}');
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/roles') {
      const GROUPS = {
        'planner-driver': 'Direction', cio: 'Direction',
        developer: 'Builders', 'frontend-lead': 'Builders', 'backend-lead': 'Builders', 'database-lead': 'Builders',
        tester: 'Oversight', auditor: 'Oversight', security: 'Oversight', compliance: 'Oversight',
        research: 'Support', training: 'Support', documentation: 'Support',
      };
      const roster = Object.values(ROLES).map((r) => ({
        role: r.role, model: r.model, tools: r.tools, charter: r.charter,
        group: GROUPS[r.role] || 'Other', maxBudgetUsd: r.maxBudgetUsd ?? null,
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(roster));
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
