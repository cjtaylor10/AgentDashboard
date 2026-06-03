// Cockpit client — subscribes to the SSE stream and renders the live spine. Vanilla JS, no build step.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATUS_COLOR = { working: '#4682b4', idle: '#6b7f95', blocked: '#e3a84a', error: '#f47067' };
const KANBAN = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Blocked', 'Done'];
const PHASES = ['goal_intake','plan','ticket','assign','dev_done','test','audit','security','change_approval','goal_realign','stop'];

const lastSig = {};

function renderStepper(cycleState) {
  const el = $('cyclesteps');
  if (!el) return;
  const cur = PHASES.indexOf(cycleState);
  el.querySelectorAll('.step[data-phase]').forEach((pill) => {
    const i = PHASES.indexOf(pill.dataset.phase);
    const cls = cur < 0 ? 'step--pending' : i < cur ? 'step--done' : i === cur ? 'step--active' : 'step--pending';
    pill.className = `step ${cls}`;
  });
}

const INDEPENDENT_ROLES = new Set(['auditor', 'security', 'compliance']);

function buildOrgTree(agents) {
  const byId = Object.create(null);
  const byRole = Object.create(null);
  for (const a of agents) {
    byId[a.id] = a;
    const rk = (a.role || '').toLowerCase();
    if (!byRole[rk]) byRole[rk] = a;
  }

  const childrenOf = Object.create(null);
  const assigned = new Set();
  for (const a of agents) {
    const mgr = a.reports_to;
    if (!mgr) continue;
    const parent = byId[mgr] || byRole[(mgr || '').toLowerCase()];
    if (parent && parent.id !== a.id) {
      if (!childrenOf[parent.id]) childrenOf[parent.id] = [];
      childrenOf[parent.id].push(a);
      assigned.add(a.id);
    }
  }

  const roots = agents.filter((a) => !assigned.has(a.id));

  function renderNode(a, depth) {
    const color = STATUS_COLOR[a.status] || '#9ca3af';
    const isIndependent = INDEPENDENT_ROLES.has((a.role || '').toLowerCase());
    const indentStyle = depth > 0 ? ` style="margin-left:${depth * 18}px"` : '';
    const connector = depth > 0 ? '<span class="tree-branch">\u2570\u2500</span>' : '';
    const indTag = isIndependent ? '<span class="agent-tag-independent">INDEPENDENT</span>' : '';
    let html = `<div class="agent"${indentStyle}>
      ${connector}<span class="dot" style="color:${color};background:${color}"></span>
      <div class="agent-main">
        <div class="agent-role">${esc(a.role)}<span class="agent-id">${esc(a.id)}</span>${indTag}</div>
        <div class="agent-action">${esc(a.current_action || a.status)}</div>
      </div>
      <span class="agent-status">${esc(a.status)}</span>
    </div>`;
    for (const child of (childrenOf[a.id] || [])) {
      html += renderNode(child, depth + 1);
    }
    return html;
  }

  return roots.map((r) => renderNode(r, 0)).join('');
}

function render(s) {
  // header: goal / cycleState pill / spend / metrics / killSwitch
  const headerSig = JSON.stringify({ goal: s.goal, cycleState: s.cycleState, spend: s.spend, metrics: s.metrics, killSwitch: s.killSwitch });
  if (headerSig !== lastSig.header) {
    lastSig.header = headerSig;

    $('goal').textContent = s.goal ? s.goal.text : '— no goal yet —';
    $('cycleState').textContent = s.cycleState || '—';

    const usd = (s.spend.usd || 0).toFixed(4);
    $('spend').textContent = `$${usd} / $${s.spend.capCycle}  ·  ${s.spend.runs} runs`;

    const mc = $('metricsChips');
    if (mc && s.metrics) {
      const { costPerRun, runs, ticketsDone, ticketsTotal } = s.metrics;
      const chips = [];
      if (costPerRun != null) chips.push(`<span class="metric-chip">$${Number(costPerRun).toFixed(3)}/run</span>`);
      if (runs != null) chips.push(`<span class="metric-chip">${Number(runs)} runs</span>`);
      if (ticketsDone != null && ticketsTotal != null) chips.push(`<span class="metric-chip">${Number(ticketsDone)}/${Number(ticketsTotal)} tickets</span>`);
      mc.innerHTML = chips.join('');
    }

    const killed = s.killSwitch.engaged;
    const btn = $('killBtn');
    btn.textContent = killed ? 'RESUME' : 'PAUSE ALL';
    btn.className = 'btn ' + (killed ? 'btn-ok' : 'btn-danger');
    document.body.classList.toggle('paused', killed);
    $('pausedBanner').classList.toggle('hidden', !killed);
  }

  // stepper
  const stepperSig = JSON.stringify(s.cycleState);
  if (stepperSig !== lastSig.stepper) {
    lastSig.stepper = stepperSig;
    renderStepper(s.cycleState);
  }

  // org — council reporting hierarchy tree
  const agentsSig = JSON.stringify(s.agents);
  if (agentsSig !== lastSig.agents) {
    lastSig.agents = agentsSig;
    const sub = $('agentsSub');
    if (sub) sub.textContent = `Agents (${s.agents.length} of ${s.agentTotal ?? s.agents.length})`;
    $('agents').innerHTML = s.agents.length
      ? buildOrgTree(s.agents)
      : '<div class="empty">no agents spawned yet — start a cycle</div>';
  }

  // kanban (hide always-empty columns to keep it tight)
  const kanbanSig = JSON.stringify(s.tickets);
  if (kanbanSig !== lastSig.kanban) {
    lastSig.kanban = kanbanSig;
    $('kanban').innerHTML = KANBAN.map((col) => {
      const items = s.tickets.filter((t) => t.kanban_column === col);
      if (!items.length && !['Todo', 'In Progress', 'In Review', 'Done'].includes(col)) return '';
      return `<div class="kcol">
      <div class="kcol-h">${col}<span>${items.length}</span></div>
      ${items.length ? items.map((t) => `<div class="card ${col === 'Done' ? 'done' : ''}">${esc(t.subject)}<div class="card-sub">${esc(t.status)}</div></div>`).join('') : '<div class="kcol-empty">—</div>'}
    </div>`;
    }).join('');
  }

  // change board
  const changesSig = JSON.stringify({ changes: s.changes, approvals: s.approvals });
  if (changesSig !== lastSig.changes) {
    lastSig.changes = changesSig;
    $('changes').innerHTML = s.changes.length ? s.changes.map((c) => {
      const appr = s.approvals.find((a) => a.change_id === c.id && a.decision === 'approve');
      const rej = s.approvals.find((a) => a.change_id === c.id && a.decision === 'rejected');
      const line = appr ? `✓ approved by ${esc(appr.approver_agent_id)}`
        : rej ? `✗ rejected — ${esc(rej.reason || '')}`
        : '⏳ awaiting approval';
      return `<div class="change">
      <div class="change-h"><span class="badge">${esc(c.category)}</span><span class="state state-${esc(c.state)}">${esc(c.state)}</span></div>
      <div class="change-sum">${esc(c.summary || '')}</div>
      <div class="change-appr">${line}</div>
    </div>`;
    }).join('') : '<div class="empty">no change requests yet</div>';
  }

  // activity feed
  const feedSig = JSON.stringify(s.events);
  if (feedSig !== lastSig.feed) {
    lastSig.feed = feedSig;
    $('feed').innerHTML = s.events.map((e) => {
      const kind = (e.type || '').split('.')[0];
      return `<div class="ev ev-${esc(kind)}"><span class="ev-t">${esc(e.type)}</span><span class="ev-a">${esc(e.agent_id || '')}</span><span class="ev-ts">${esc((e.ts || '').slice(11, 19))}</span></div>`;
    }).join('');
  }

  // terminal console — agent output stream
  const consoleSig = JSON.stringify(s.console);
  if (consoleSig !== lastSig.console) {
    lastSig.console = consoleSig;
    renderConsole(s.console || []);
  }

  // slack-style chat view
  const chatSig = JSON.stringify(s.chat);
  if (chatSig !== lastSig.chat) {
    lastSig.chat = chatSig;
    renderChat(s.console || []);
  }
}

function renderConsole(lines) {
  const el = $('console');
  if (!el) return;
  // Parse each pre-built line from server: "HH:MM:SS [agent] body"
  // Re-render with span-level coloring for readability.
  const linePattern = /^(\d{2}:\d{2}:\d{2}) (\[([^\]]+)\] )?(.*)$/;
  el.innerHTML = lines.map((raw) => {
    const m = linePattern.exec(raw);
    if (m) {
      const ts = esc(m[1]);
      const agentId = m[3] ? esc(m[3]) : '';
      const body = esc(m[4] || '');
      const agentHtml = agentId ? `<span class="term-agent">[${agentId}]</span> ` : '';
      return `<span class="term-line"><span class="term-ts">${ts}</span>${agentHtml}<span class="term-body">${body}</span></span>`;
    }
    return `<span class="term-line"><span class="term-body">${esc(raw)}</span></span>`;
  }).join('\n');
  // Auto-scroll to bottom so newest output is always visible.
  el.scrollTop = el.scrollHeight;
}

// ── Chat panel ──────────────────────────────────────────────────────
const CHAT_ROLE_SLOT = {};
let _chatNextSlot = 0;
const CHAT_SLOT_COUNT = 5;

function chatSlot(role) {
  const key = (role || 'system').toLowerCase();
  if (!(key in CHAT_ROLE_SLOT)) { CHAT_ROLE_SLOT[key] = _chatNextSlot++ % CHAT_SLOT_COUNT; }
  return CHAT_ROLE_SLOT[key];
}

function renderChat(lines) {
  const el = $('chat');
  if (!el) return;

  const LP = /^(\d{2}:\d{2}:\d{2}) (?:\[([^\]]+)\] )?(.*)$/;
  let html = '';
  let prevRole = null;

  for (const raw of lines) {
    const m = LP.exec(raw);
    if (!m) continue;
    const ts    = m[1];
    const agent = m[2] || 'system';
    const body  = (m[3] || '').trim();
    const role  = (agent.split('-')[0] || 'system').toLowerCase();

    // Filter: drop system noise, rate-limit events, and empty user turns
    if (role === 'system') continue;
    if (role === 'rate_limit_event' || body.includes('rate_limit_event')) continue;
    if (role === 'user' && !body) continue;

    const slot  = chatSlot(role);

    if (role !== prevRole) {
      html += `<div class="chat-group-label chat-label-r${slot}">`
            + `<span class="chat-role">${esc(role)}</span>`
            + `<span class="chat-agent-id">${esc(agent)}</span>`
            + `</div>`;
      prevRole = role;
    }

    html += `<div class="chat-bubble chat-r${slot}">`
          + `<span class="chat-body">${esc(body)}</span>`
          + `<span class="chat-ts">${esc(ts)}</span>`
          + `</div>`;
  }

  if (!html) html = '<div class="chat-empty">no agent messages yet</div>';
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

// live stream
let es;
function connect() {
  es = new EventSource('/events');
  es.onopen = () => $('conn').classList.add('on');
  es.onmessage = (m) => { try { render(JSON.parse(m.data)); } catch { /* ignore */ } };
  es.onerror = () => { $('conn').classList.remove('on'); /* EventSource auto-reconnects */ };
}
connect();

$('killBtn').onclick = async () => {
  const killed = document.body.classList.contains('paused');
  try { await fetch(killed ? '/api/resume' : '/api/kill', { method: 'POST' }); } catch { /* offline */ }
};
