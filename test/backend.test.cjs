const test = require('node:test');
const assert = require('node:assert/strict');
const { wslUnc } = require('../src/backend.cjs');
test('maps an allowed WSL work path to a UNC path', () => assert.equal(wslUnc('/home/user/develop/a'), '\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\develop\\a'));
test('rejects traversal and paths outside the work root', () => { for (const value of ['/etc/passwd', '/home/user/develop/../secret', '/home/user/develop', 'C:\\temp']) assert.throws(() => wslUnc(value)); });
test('closing a native session waits for process exit before a new session can start', async () => {
  const { EventEmitter } = require('node:events');
  const { OmpSession } = require('../src/backend.cjs');
  const session = new OmpSession(() => {}), child = new EventEmitter();
  let ended = false, resolved = false;
  child.stdin = {end: () => { ended = true; }};
  session.child = child;
  const closing = session.close().then(() => {resolved = true;});
  await Promise.resolve(); assert.equal(ended, true); assert.equal(resolved, false);
  child.emit('close', 0); await closing; assert.equal(resolved, true);
});
