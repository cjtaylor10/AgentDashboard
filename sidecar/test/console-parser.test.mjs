import { workerEventToLine } from '../src/server.js';

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

if (!failed) {
  console.log('PASS');
} else {
  process.exit(1);
}
