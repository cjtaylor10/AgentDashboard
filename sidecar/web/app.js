// Cockpit client — subscribes to the SSE stream and renders the live spine. Vanilla JS, no build step.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATUS_COLOR = { working: '#4682b4', idle: '#6b7f95', blocked: '#e3a84a', error: '#f47067' };
const KANBAN = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Blocked', 'Done'];

function render(s) {
  $('goal').textContent = s.goal ? s.goal.text : '— no goal yet —';
  $('cycleState').textContent = s.cycleState || '—';

  const usd = (s.spend.usd || 0).toFixed(4);
  $('spend').textContent = `$${usd} / $${s.spend.capCycle}  ·  ${s.spend.runs} runs`;

  const killed = s.killSwitch.engaged;
  const btn = $('killBtn');
  btn.textContent = killed ? 'RESUME' : 'PAUSE ALL';
  btn.className = 'btn ' + (killed ? 'btn-ok' : 'btn-danger');
  document.body.classList.toggle('paused', killed);
  $('pausedBanner').classList.toggle('hidden', !killed);

  // org
  $('agents').innerHTML = s.agents.length ? s.agents.map((a) => `
    <div class="agent">
      <span class="dot" style="color:${STATUS_COLOR[a.status] || '#9ca3af'};background:${STATUS_COLOR[a.status] || '#9ca3af'}"></span>
      <div class="agent-main">
        <div class="agent-role">${esc(a.role)}<span class="agent-id">${esc(a.id)}</span></div>
        <div class="agent-action">${esc(a.current_action || a.status)}</div>
      </div>
      <span class="agent-status">${esc(a.status)}</span>
    </div>`).join('') : '<div class="empty">no agents spawned yet — start a cycle</div>';

  // kanban (hide always-empty columns to keep it tight)
  $('kanban').innerHTML = KANBAN.map((col) => {
    const items = s.tickets.filter((t) => t.kanban_column === col);
    if (!items.length && !['Todo', 'In Progress', 'In Review', 'Done'].includes(col)) return '';
    return `<div class="kcol">
      <div class="kcol-h">${col}<span>${items.length}</span></div>
      ${items.map((t) => `<div class="card ${col === 'Done' ? 'done' : ''}">${esc(t.subject)}<div class="card-sub">${esc(t.status)}</div></div>`).join('')}
    </div>`;
  }).join('');

  // change board
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

  // activity feed
  $('feed').innerHTML = s.events.map((e) => {
    const kind = (e.type || '').split('.')[0];
    return `<div class="ev ev-${esc(kind)}"><span class="ev-t">${esc(e.type)}</span><span class="ev-a">${esc(e.agent_id || '')}</span><span class="ev-ts">${esc((e.ts || '').slice(11, 19))}</span></div>`;
  }).join('');

  // terminal console — agent output stream
  renderConsole(s.console || []);
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
