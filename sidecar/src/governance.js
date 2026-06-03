// Governed operations: create a change, submit an approval (authority + separation-of-duties enforced),
// and the SIDECAR-OWNED merge (Layer A) — a worker never holds the merge capability; it requests it here.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { insertEvent, nowIso } from './db.js';
import { evaluate } from './policy.js';
import { paths } from './config.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function createChangeRequest(db, { category = 'routine', blastRadius = 'routine', summary = null, authorAgentId = null, planHash = null }) {
  const id = 'chg-' + randomUUID().slice(0, 8);
  db.prepare(
    `INSERT INTO change_request (id, category, blast_radius, summary, plan_hash, author_agent_id, state, created_ts)
     VALUES (?,?,?,?,?,?, 'planned', ?)`
  ).run(id, category, blastRadius, summary, planHash, authorAgentId, nowIso());
  insertEvent(db, { type: 'change.created', agentId: authorAgentId, payload: { changeId: id, category, summary } });
  return id;
}

// Records an approval attempt. Authority + separation-of-duties decide whether it is accepted
// (change -> 'approved') or rejected-and-logged. Rejected attempts are stored as decision='rejected'
// so they can never satisfy the merge gate.
export function submitApproval(db, { changeId, approverAgentId, reason = null }) {
  const change = db.prepare('SELECT * FROM change_request WHERE id = ?').get(changeId);
  if (!change) throw new Error('no such change_request: ' + changeId);

  // Probe the gate as if the change were approved by this actor.
  const probe = evaluate(db, { ...change, state: 'approved' }, { approver_agent_id: approverAgentId, decision: 'approve' });
  const accepted = probe.allow;
  const apprId = 'apr-' + randomUUID().slice(0, 8);
  db.prepare('INSERT INTO approval (id, change_id, approver_agent_id, decision, reason, ts) VALUES (?,?,?,?,?,?)')
    .run(apprId, changeId, approverAgentId, accepted ? 'approve' : 'rejected', accepted ? reason : probe.reason, nowIso());

  if (accepted) {
    db.prepare("UPDATE change_request SET state = 'approved' WHERE id = ?").run(changeId);
    insertEvent(db, { type: 'change.approved', agentId: approverAgentId, payload: { changeId, approverAgentId } });
    return { accepted: true, approvalId: apprId };
  }
  insertEvent(db, { type: 'approval.rejected', agentId: approverAgentId, payload: { changeId, approverAgentId, reason: probe.reason } });
  return { accepted: false, approvalId: apprId, reason: probe.reason };
}

// Layer A: the ONLY path to integrate an agent branch. evaluate() runs synchronously; only on allow
// does the sidecar perform the merge with its own hands.
export function requestMerge(db, { changeId, agentId, branch, repoDir = paths.workspace }) {
  const change = db.prepare('SELECT * FROM change_request WHERE id = ?').get(changeId);
  const approval = db.prepare(
    "SELECT * FROM approval WHERE change_id = ? AND decision = 'approve' ORDER BY ts DESC LIMIT 1"
  ).get(changeId);

  const verdict = evaluate(db, change, approval);
  insertEvent(db, { type: 'merge.requested', agentId, payload: { changeId, branch, allow: verdict.allow, reason: verdict.reason } });

  if (!verdict.allow) {
    insertEvent(db, { type: 'merge.blocked', agentId, payload: { changeId, branch, reason: verdict.reason } });
    return { merged: false, reason: verdict.reason };
  }

  git(repoDir, ['merge', '--no-ff', '-m', `merge ${branch} (${changeId})`, branch]);
  db.prepare("UPDATE change_request SET state = 'implemented' WHERE id = ?").run(changeId);
  insertEvent(db, { type: 'merge.completed', agentId, payload: { changeId, branch } });
  return { merged: true };
}
