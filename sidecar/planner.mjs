// Planner driver: translates a Chair goal into tickets by running the Research
// agent first, injecting the resulting brief into the Claude prompt, then calling
// Claude to produce the ticket list.
//
// INVARIANT: no path through this module calls Claude without first awaiting
// runResearchAgent and appending the brief to the prompt.
//
// All external dependencies (appendEvent, webSearch, grepLocal, callClaude) are
// injectable so the integration test can stub them without network/API access.

import { runResearchAgent } from './agents/research.mjs';

/**
 * Default Claude caller — uses the Anthropic messages API via built-in fetch.
 * Requires ANTHROPIC_API_KEY in the environment.
 * Returns the assistant's text content as a string.
 */
async function defaultCallClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.content?.find((b) => b.type === 'text')?.text ?? '';
}

/**
 * Run the planning pipeline for the given goal.
 *
 * Steps (in strict order):
 *   1. Spawn the Research agent and await its brief.
 *   2. Append the brief to the event store.
 *   3. Build the Claude prompt with the brief injected as <research_brief>.
 *   4. Call Claude and return the response as the ticket list.
 *
 * @param {string} goal - The Chair's planning goal.
 * @param {object} opts
 * @param {(type:string, payload:object)=>void} [opts.appendEvent]
 * @param {(query:string)=>Promise<string>}       [opts.webSearch]
 * @param {(query:string)=>Promise<string>}       [opts.grepLocal]
 * @param {(prompt:string)=>Promise<any>}          [opts.callClaude]
 * @returns {Promise<{tickets:any, brief:object, prompt:string}>}
 */
export async function runPlanner(goal, { appendEvent, webSearch, grepLocal, callClaude } = {}) {
  const doCallClaude = callClaude ?? defaultCallClaude;

  // ── Step 1 & 2: Research first — Claude is never called before this resolves ──
  const brief = await runResearchAgent(goal, { appendEvent, webSearch, grepLocal });

  // ── Step 3: Build prompt with brief injected verbatim ────────────────────────
  const briefBlock =
    '<research_brief>\n' +
    JSON.stringify(brief, null, 2) +
    '\n</research_brief>';

  const systemSection =
    'You are the Planner/Driver of an autonomous engineering org.\n' +
    'Translate the goal into the SMALLEST set of tickets that fully satisfies it.\n' +
    'Each ticket must have a subject and concrete done_criteria. Be terse.\n\n' +
    briefBlock;

  const prompt =
    systemSection +
    '\n\nGoal:\n' +
    goal +
    '\n\nRespond with a JSON array of ticket objects.';

  // ── Step 4: Call Claude (only reachable after brief is in hand) ──────────────
  const tickets = await doCallClaude(prompt);

  return { tickets, brief, prompt };
}
