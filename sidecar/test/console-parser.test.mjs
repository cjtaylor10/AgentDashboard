import { workerEventToLine, computeMetrics, selectVisibleAgents } from '../src/server.js';

let failed = false;

function assert(description, condition) {
  if (!condition) {
    console.log('FAIL', description);
    failed = true;
  }
}

// Existing: assistant text event yields formatted line
const ev = {
  ts: '2026-06-02T12:34:56.000Z',
  agent_id: 'chair',
  type: 'worker.message',
  payload_json: JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'hello from the agent' }
      ]
    }
  })
};
const line = workerEventToLine(ev);
assert('assistant text event yields its formatted text line', line.includes('hello from the agent'));

// system payload yields null
const systemEv = {
  ts: '2026-06-02T12:34:57.000Z',
  agent_id: 'chair',
  type: 'worker.message',
  payload_json: JSON.stringify({ type: 'system', subtype: 'init', system: 'You are...' })
};
assert('system payload yields null', workerEventToLine(systemEv) === null);

// user payload yields null
const userEv = {
  ts: '2026-06-02T12:34:58.000Z',
  agent_id: 'chair',
  type: 'worker.message',
  payload_json: JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } })
};
assert('user payload yields null', workerEventToLine(userEv) === null);

// computeMetrics
const m = computeMetrics({ spendUsd: 1, runs: 4, ticketsTotal: 2, ticketsDone: 1 });
assert('computeMetrics costPerRun === 0.25', m.costPerRun === 0.25);
assert('computeMetrics ticketsDone === 1', m.ticketsDone === 1);

// selectVisibleAgents: with nothing working, caps idle agents to the idle floor (6)
const capped = selectVisibleAgents(Array.from({ length: 20 }, () => ({ status: 'idle' })));
assert('selectVisibleAgents caps 20 idle agents to the idle floor (6)', capped.length === 6);

// selectVisibleAgents: working agents first, respects custom cap
const mixed = selectVisibleAgents(
  [{ status: 'working', id: 'w' }, ...Array.from({ length: 19 }, () => ({ status: 'idle' }))],
  3
);
assert('selectVisibleAgents result length === 3 with cap=3', mixed.length === 3);
assert('selectVisibleAgents working agent is first', mixed[0].status === 'working');

// --- tool_use dispatch (raw event objects) ---

// Bash
const bashLine = workerEventToLine({ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } });
assert('Bash tool_use includes command', bashLine != null && bashLine.includes('ls -la'));

// Edit
const editLine = workerEventToLine({ type: 'tool_use', name: 'Edit', input: { file_path: '/foo/bar.js' } });
assert('Edit tool_use includes file_path', editLine != null && editLine.includes('bar.js'));

// Write
const writeLine = workerEventToLine({ type: 'tool_use', name: 'Write', input: { file_path: '/out/baz.js' } });
assert('Write tool_use includes file_path', writeLine != null && writeLine.includes('baz.js'));

// Read
const readLine = workerEventToLine({ type: 'tool_use', name: 'Read', input: { file_path: '/src/index.js' } });
assert('Read tool_use includes file_path', readLine != null && readLine.includes('index.js'));

// Glob
const globLine = workerEventToLine({ type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } });
assert('Glob tool_use includes pattern', globLine != null && globLine.includes('**/*.ts'));

// Grep
const grepLine = workerEventToLine({ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } });
assert('Grep tool_use includes pattern', grepLine != null && grepLine.includes('TODO'));

// Fallback tool
const fallbackLine = workerEventToLine({ type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com' } });
assert('Fallback tool_use uses tool/Name format', fallbackLine != null && fallbackLine.includes('tool/WebFetch'));
assert('Fallback tool_use includes first input value', fallbackLine != null && fallbackLine.includes('example.com'));

// tool_result with content → starts with arrow
const resultLine = workerEventToLine({ type: 'tool_result', content: 'some output' });
assert('tool_result returns line starting with →', resultLine != null && resultLine.startsWith('→'));

// tool_result with empty content → null
const emptyResult = workerEventToLine({ type: 'tool_result', content: '' });
assert('tool_result with empty content returns null', emptyResult === null);

// tool_result with non-string content → null
const nonStringResult = workerEventToLine({ type: 'tool_result', content: ['array'] });
assert('tool_result with non-string content returns null', nonStringResult === null);

// system raw event → null
assert('raw system event returns null', workerEventToLine({ type: 'system' }) === null);

// user raw event → null
assert('raw user event returns null', workerEventToLine({ type: 'user' }) === null);

// Bash command truncated to 120 chars in the prefix
const longCmd = 'x'.repeat(200);
const longLine = workerEventToLine({ type: 'tool_use', name: 'Bash', input: { command: longCmd } });
assert('Bash command is truncated at 120 chars', longLine != null && longLine.length < 200);

if (!failed) {
  console.log('PASS');
} else {
  process.exit(1);
}
