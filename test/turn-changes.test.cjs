const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {SessionManager} = require('../src/session-manager.cjs');
const {TurnChanges} = require('../src/turn-changes.cjs');
const {turnMessageKey} = require('../src/turn-message-key.cjs');

test('captures before prompt and binds the saved interval to the native journal across connections', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucyna-turn-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const trace = [];
  let forward;
  const result = {
    files: [{member: 'app', path: 'test.js', patch: 'round patch'}],
    warnings: [],
  };
  const reviews = new TurnChanges({directory, launch() {
    trace.push('before');
    return {baseline: Promise.resolve(true), cancel() {}, finish() {
      trace.push('after');
      return Promise.resolve(result);
    }};
  }});
  const journal = 'C:/example/native.jsonl';
  const makeManager = () => new SessionManager({turnChanges: reviews, send: event => trace.push(event.type), create(emit) {
    forward = emit;
    return {
      child: null, ready: true,
      async start() {this.child = {pid: 100};return {};},
      async request(type) {trace.push(type);return {};},
      async close() {this.child = null;},
    };
  }});
  const start = (manager, id, resume = journal) => manager.start(id, launch => launch({
    root: '/work/example', resume, settings: {runtime: 'wsl'},
  }));
  const manager = makeManager();
  await start(manager, 'first');
  await manager.request('first', 'prompt', {message: 'edit the fixture'});
  const user = {role: 'user', timestamp: 1793848000000, content: [{type: 'text', text: 'edit the fixture'}]};
  forward({type: 'message_start', messageId: 'msg-9', message: user});
  forward({type: 'message_end', messageId: 'msg-9', message: user});
  forward({type: 'session_settled'});
  await reviews.drain();
  assert.ok(trace.indexOf('before') < trace.indexOf('prompt'));
  assert.ok(trace.indexOf('after') < trace.indexOf('turn_changes_ready'));
  const key = turnMessageKey(user);
  assert.deepEqual(await reviews.list(manager.get('first')), [{messageId: key, files: 1, partial: false}]);
  await manager.closeAll();

  const reopened = makeManager();
  await start(reopened, 'reopened');
  const saved = await reviews.read(reopened.get('reopened'), key);
  assert.deepEqual(saved.files, result.files);
  await start(reopened, 'other', 'C:/example/other.jsonl');
  assert.equal(await reviews.read(reopened.get('other'), key), null);

  await reopened.request('other', 'prompt', {message: 'two user messages overlap'});
  forward({type: 'message_start', messageId: 'msg-1', message: user});
  forward({type: 'message_start', messageId: 'msg-2', message: {...user, timestamp: user.timestamp + 1}});
  forward({type: 'session_settled'});
  await reviews.drain();
  assert.deepEqual(await reviews.list(reopened.get('other')), []);
  await reopened.closeAll();
});

test('closing during baseline capture prevents the delayed prompt from being sent', async () => {
  let ready, started;
  const preparing = new Promise(resolve => {started = resolve;});
  const trace = [];
  const reviews = new TurnChanges({launch() {
    const baseline = new Promise(resolve => {ready = resolve;});
    started();
    return {baseline, cancel() {ready(false);}};
  }});
  const manager = new SessionManager({turnChanges: reviews, send() {}, create: () => ({
    child: null, ready: true,
    async start() {this.child = {pid: 100};return {};},
    async request(type) {trace.push(type);},
    async close() {this.child = null;},
  })});
  await manager.start('stopping', launch => launch({
    root: '/work/example', resume: 'C:/example/native.jsonl', settings: {runtime: 'wsl'},
  }));
  const sending = assert.rejects(manager.request('stopping', 'prompt', {message: 'edit'}), /发送前已停止/);
  await preparing;
  await manager.close('stopping');
  await sending;
  assert.deepEqual(trace, []);
});
