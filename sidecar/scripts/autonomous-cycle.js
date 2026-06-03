// Run ONE autonomous cycle: the CEO/management picks the next improvement (from the Chair's Ideas inbox
// or its own judgment), then the gated council cycle builds it. Targets the harness itself.
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths, ensureDirs, claudeExists, CLAUDE_BIN } from '../src/config.js';
import { openDb, updateIdea } from '../src/db.js';
import { runCycle } from '../src/loop.js';
import { proposeGoal } from '../src/autonomous.js';

const targetRepo = paths.root;
const worktreesDir = path.join(os.tmpdir(), 'agentdash-self-wt');
const git = (args) => execFileSync('git', args, { cwd: targetRepo, encoding: 'utf8' }).trim();

async function main() {
  ensureDirs();
  if (!claudeExists()) { console.error('claude not found at', CLAUDE_BIN); process.exit(1); }
  if (git(['status', '--porcelain'])) { console.error('[autonomous] REFUSING: working tree is dirty — commit/stash first'); process.exit(2); }

  const db = openDb();
  console.log('[autonomous] CEO/management is choosing the next improvement...');
  const plan = await proposeGoal(db, { targetRepo });
  if (!plan?.goal) { console.error('[autonomous] CEO produced no goal'); process.exit(1); }

  console.log('[autonomous] GOAL    :', plan.goal);
  console.log('[autonomous] source  :', plan.sourceIdeaId ?? '(own idea)', '| decision:', plan.ideaDecision);
  if (plan.rationale) console.log('[autonomous] why     :', plan.rationale);

  // record the council's decision on the chosen idea
  if (plan.sourceIdeaId) {
    const st = plan.ideaDecision === 'reject' ? 'rejected' : 'accepted';
    updateIdea(db, plan.sourceIdeaId, { status: st, councilNote: plan.ideaNote || plan.rationale || '' });
  }

  const goalText = plan.goal + (plan.domain ? ` (domain=${plan.domain})` : '');
  const r = await runCycle(db, { goalText, targetRepo, worktreesDir });

  if (plan.sourceIdeaId) {
    // A merged FIRST slice of a multi-cycle idea (ideaComplete===false) keeps the idea open with a progress note;
    // a merged idea the CEO marked complete (or left unspecified) is done; a withheld cycle leaves it considering.
    const fullyDelivered = r.merged && plan.ideaComplete !== false;
    const sliceNote = r.merged && !fullyDelivered
      ? `First slice merged at ${git(['rev-parse', '--short', 'HEAD'])}; follow-on remaining: ${plan.ideaNote || '(see goal)'}`
      : null;
    updateIdea(db, plan.sourceIdeaId, { status: fullyDelivered ? 'done' : 'considering', councilNote: sliceNote });
  }

  console.log('\n===== AUTONOMOUS CYCLE RESULT =====');
  console.log('tester PASS :', r.testPass, '| auditor ALIGNED:', r.aligned, '| security CLEAN:', r.clean, '| merged:', r.merged);
  console.log('HEAD        :', git(['rev-parse', '--short', 'HEAD']));
  db.close();
  process.exit(r.merged ? 0 : 1);
}

main().catch((e) => { console.error('[autonomous] error:', e.message); process.exit(1); });
