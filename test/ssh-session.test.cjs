const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {RemoteSession} = require('../src/hosts/remote-session.cjs');

test('a delayed rejection from the old connection cannot cancel the new status check', async () => {
  const connection = new EventEmitter();
  const requests = [];
  const record = {id: 'session', generation: 'generation', epoch: 1, status: 'live'};
  connection.connect = async () => {};
  connection.request = (op) => {
    if (op === 'session.attach') return Promise.resolve(record);
    if (op === 'session.events') return new Promise(() => {});
    return new Promise((resolve, reject) => requests.push({resolve, reject}));
  };
  const session = new RemoteSession(connection, 'desktop');
  try {
    await session.attach({record});
    const first = session.request('prompt', {message: 'once'}, {operationId: 'stable'}).catch(e => e);
    session.detach();
    assert.equal((await first).code, 'transport_lost');
    await session.attach(session.descriptor());
    const second = session.request('prompt', {message: 'once'}, {operationId: 'stable'}).catch(e => e);
    requests[0].reject(Error('old transport closed late'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.pending.size, 1);
    requests[1].resolve({replayed: true, status: 'succeeded'});
    assert.equal((await second).code, 'operation_recorded');
    assert.equal(connection.listenerCount('disconnected'), 1);
    connection.emit('disconnected');
    assert.equal(session.polling, false);
  } finally { session.detach(); }
});
