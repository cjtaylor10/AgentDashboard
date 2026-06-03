import { shortId } from '../src/server.js';

let failed = false;

function assert(desc, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL: ${desc} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed = true;
  }
}

assert('null returns empty string', shortId(null), '');
assert('undefined returns empty string', shortId(undefined), '');
assert('id with dash returns suffix', shortId('abc-123'), '123');
assert('id with multiple dashes returns last suffix', shortId('a-b-xyz'), 'xyz');
assert('id without dash returns whole string', shortId('nodash'), 'nodash');

if (failed) {
  process.exit(1);
} else {
  console.log('PASS');
}
