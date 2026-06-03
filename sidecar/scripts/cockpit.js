// Start the cockpit dashboard server. Open the printed URL; run `npm run cycle` in another terminal
// to watch the org work live.
import { ensureDirs, claudeExists, CLAUDE_BIN } from '../src/config.js';
import { startCockpit } from '../src/server.js';

ensureDirs();
if (!claudeExists()) console.warn('[cockpit] note: claude not found at', CLAUDE_BIN, '— the dashboard still runs; cycles need it.');
startCockpit();
