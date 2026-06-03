import { workerEventToLine } from '../src/server.js';

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

if (line.includes('hello from the agent')) {
  console.log('PASS');
} else {
  console.log('FAIL', line);
  process.exit(1);
}
