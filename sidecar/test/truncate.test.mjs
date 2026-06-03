import { truncate } from '../src/server.js';

const pass1 = truncate('hello', 10) === 'hello';
const pass2 = truncate('abcdefgh', 5) === 'ab...';

if (pass1 && pass2) {
  console.log('PASS');
} else {
  console.log('FAIL');
  process.exit(1);
}
