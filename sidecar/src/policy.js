// The policy engine — the ~6 boolean checks that make the APPROVED gate real (BUILD-SPEC §8).
// Plain, testable JS. No DSL. evaluate() is called synchronously at action time, in the sidecar.
import { isKilled } from './db.js';
import { BUDGETS } from './config.js';

// Authority map (data): which agent ROLE may approve which change category.
// In the real system, editing this is itself a Chair-only action.
export const AUTHORITY = {
  routine: ['planner-driver', 'senior-dev', 'cio', 'chair'],
  cross_domain: ['cio', 'chair'],
  schema: ['chair'],
  deploy: ['chair'],
  spend: ['chair'],
  agent_creation: ['chair'],
  goal: ['chair'],
};

const deny = (reason) => ({ allow: false, reason });
const allow = (reason = 'all checks passed') => ({ allow: true, reason });

// Is `childId` below `ancestorId` in the spawn (parent_agent_id) chain? Used for separation of duties.
export function isDownstream(db, childId, ancestorId) {
  if (!childId || !ancestorId) return false;
  const seen = new Set();
  let cur = db.prepare('SELECT id, parent_agent_id FROM agent WHERE id = ?').get(childId);
  while (cur && cur.parent_agent_id && !seen.has(cur.id)) {
    if (cur.parent_agent_id === ancestorId) return true;
    seen.add(cur.id);
    cur = db.prepare('SELECT id, parent_agent_id FROM agent WHERE id = ?').get(cur.parent_agent_id);
  }
  return false;
}

function orgSpendUsd(db) {
  return db.prepare('SELECT COALESCE(SUM(usd), 0) AS s FROM run').get().s;
}

function roleOf(db, agentId) {
  const a = db.prepare('SELECT role FROM agent WHERE id = ?').get(agentId);
  // pseudo-actors like the Chair have no agent row; treat their id as their role.
  return a?.role ?? agentId;
}

/**
 * The gate. Returns { allow, reason }. Order: cheapest + most on-point checks first.
 * `change` is a change_request row; `approval` is the latest approve row (or null).
 */
export function evaluate(db, change, approval) {
  if (isKilled(db)) return deny('global kill switch is engaged');
  if (!change) return deny('no change_request exists for this action');
  if (change.state !== 'approved') return deny(`change_request state is '${change.state}', expected 'approved'`);
  if (!approval || approval.decision !== 'approve') return deny('no approval token on the change_request');

  const approverId = approval.approver_agent_id;
  if (approverId === change.author_agent_id) return deny('separation of duties: approver is the author');
  if (isDownstream(db, approverId, change.author_agent_id)) return deny('separation of duties: approver is downstream of the author');

  const approverRole = roleOf(db, approverId);
  const allowedRoles = AUTHORITY[change.category] ?? [];
  if (!allowedRoles.includes(approverRole)) {
    return deny(`role '${approverRole}' is not authorized to approve a '${change.category}' change`);
  }

  const spent = orgSpendUsd(db);
  if (spent > BUDGETS.usdPerDay) return deny(`daily org budget exceeded ($${spent.toFixed(2)} > $${BUDGETS.usdPerDay})`);

  return allow();
}
