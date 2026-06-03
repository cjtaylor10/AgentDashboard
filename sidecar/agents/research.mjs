// Research agent pre-pass: given a goal, gathers context from the web and the
// local codebase, then returns a structured brief and appends a research_brief
// event to the event store.
//
// All I/O dependencies (webSearch, grepLocal, appendEvent) are injectable so
// callers (and tests) can substitute lightweight stubs without network access.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sidecarDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Default codebase grep: search the sidecar/src directory for tokens from the
 * goal and return up to 20 matching lines as a single string.
 * Uses a pure-JS walk so it works cross-platform without relying on grep.
 */
function defaultGrepLocal(goal) {
  const words = goal.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const term = words.slice(0, 2).join('|') || 'function';
  const re = new RegExp(term, 'i');
  const srcDir = path.join(sidecarDir, 'src');
  const lines = [];
  try {
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue;
      const content = fs.readFileSync(path.join(srcDir, f), 'utf8');
      for (const [i, line] of content.split('\n').entries()) {
        if (re.test(line)) {
          lines.push(`${f}:${i + 1}: ${line.trim()}`);
          if (lines.length >= 20) break;
        }
      }
      if (lines.length >= 20) break;
    }
  } catch {
    // If src dir is not accessible, return empty
  }
  return lines.join('\n');
}

/**
 * Run the Research agent for the given goal.
 *
 * @param {string} goal - The planning goal to research.
 * @param {object} opts
 * @param {(type:string, payload:object)=>void} [opts.appendEvent] - Event store writer.
 * @param {(query:string)=>Promise<string>} [opts.webSearch]  - Web search stub.
 * @param {(query:string)=>Promise<string>} [opts.grepLocal]  - Codebase search stub.
 * @returns {Promise<{query:string, web_summary:string, codebase_notes:string}>}
 */
export async function runResearchAgent(goal, { appendEvent, webSearch, grepLocal } = {}) {
  const doWebSearch = webSearch ?? (async () => '');
  const doGrepLocal = grepLocal ?? ((q) => Promise.resolve(defaultGrepLocal(q)));

  const [webSummary, codebaseNotes] = await Promise.all([
    doWebSearch(goal),
    doGrepLocal(goal),
  ]);

  const brief = {
    query: goal,
    web_summary: String(webSummary ?? ''),
    codebase_notes: String(codebaseNotes ?? ''),
  };

  if (appendEvent) {
    appendEvent('research_brief', brief);
  }

  return brief;
}
