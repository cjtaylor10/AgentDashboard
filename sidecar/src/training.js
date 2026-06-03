// Training review: queries the last 10 cycles' verdict events (test, audit, security) from the DB,
// spawns the training agent with those results as context, and writes the agent's charter amendment
// proposals to sidecar/data/policy-refinements.json.
import path from 'node:path';
import fs from 'node:fs';
import { paths, BUDGETS } from './config.js';
import { spawnWorker } from './worker.js';
import { ROLES } from './roles.js';

function extractJsonArray(text) {
  if (!text) return null;
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const lastBracket = text.lastIndexOf('[');
  if (lastBracket >= 0) candidates.push(text.slice(lastBracket));
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch { /* try next */ }
  }
  return null;
}

export async function runTrainingReview(db) {
  // Identify the last 10 completed cycles via cycle.stop events.
  const stopRows = db.prepare(
    "SELECT payload_json FROM event WHERE type = 'cycle.stop' ORDER BY ts DESC LIMIT 10"
  ).all();

  const cycleIds = stopRows
    .map((r) => { try { return JSON.parse(r.payload_json)?.cycleId; } catch { return null; } })
    .filter(Boolean);

  let verdicts = [];
  if (cycleIds.length > 0) {
    // Fetch tester, auditor, and security verdict events for those cycles.
    const placeholders = cycleIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT type, payload_json FROM event
       WHERE type IN ('cycle.test','cycle.audit','cycle.security')
         AND json_extract(payload_json, '$.cycleId') IN (${placeholders})
       ORDER BY ts ASC`
    ).all(...cycleIds);

    verdicts = rows.map((r) => {
      try { return { type: r.type, ...JSON.parse(r.payload_json) }; }
      catch { return { type: r.type }; }
    });
  }

  const role = ROLES.training;
  const cycleCount = cycleIds.length;
  const prompt =
    "Here are the verdict events from the last " + (cycleCount || 0) + " completed cycle(s) in this agent council:\n\n" +
    JSON.stringify(verdicts, null, 2) +
    "\n\nAnalyse these results and output a JSON array of specific, actionable charter amendment proposals.";

  const res = await spawnWorker({
    cwd: paths.root,
    prompt,
    charter: role.charter,
    model: role.model,
    allowedTools: role.tools,
    maxBudgetUsd: role.maxBudgetUsd ?? BUDGETS.usdPerRun,
  });

  const proposals = extractJsonArray(res.result?.result) ?? [];
  const outPath = path.join(paths.data, 'policy-refinements.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(proposals, null, 2), 'utf8');
  return proposals;
}
