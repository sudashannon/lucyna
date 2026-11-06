const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {WorkAssistant} = require('../src/work-assistant.cjs');
const {withSummaryReconciliation} = require('./work-summary-fixture.test.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucyna-summary-batches-'));
  const requests = [], checkpoints = [];
  let now = 1000000, state;
  const agent = {run: withSummaryReconciliation(async (_config, _instructions, raw) => {
    const payload = JSON.parse(raw);
    requests.push(payload);
    checkpoints.push(state.analysis.hashes.length);
    const output = {changes: []};
    if (!payload.previousSummary?.overview) output.overview = {
      text: '当前工作整理已有构建资料。', sources: [{evidenceId: payload.messages[0].excerpts[0].evidenceId}],
    };
    return {text: JSON.stringify(output), finishReason: 'stop', totalUsage: {inputTokens: 10, outputTokens: 5}};
  })};
  const assistant = new WorkAssistant({directory, agent, debounceMs: 600000, clock: () => now,
    config: async () => ({baseURL: 'http://fixture.invalid', model: 'fixture', apiKey: 'fixture'})});
  const identity = {root: '/work/summary-batches'};
  state = (await assistant.load(identity)).state;
  const ingest = async ids => assistant.ingest({...identity, sessionId: 'first', title: '构建资料',
    messages: ids.map(id => ({id, role: 'user', timestamp: now++, content: `消息 ${id}：整理已有构建资料并保留未决事项。`}))}, {schedule: false});
  const drain = async () => {
    for (let batch = 0; batch < 20; batch++) {
      await assistant.summarize(state.workId);
      const snapshot = await assistant.view(identity);
      assert.notEqual(snapshot.status, 'error', snapshot.error);
      if (!snapshot.analysis.pendingMessages && !state.analysis.sweep) return snapshot;
    }
    assert.fail('summary batch sweep did not finish');
  };
  t.after(async () => { await assistant.close(); await fs.rm(directory, {recursive: true, force: true}); });
  return {assistant, identity, state, ingest, drain, requests, checkpoints, advance: delta => { now += delta; }};
}

test('summary deltas larger than one batch checkpoint every message without silently skipping pending rows', async t => {
  const f = await fixture(t);
  await f.ingest(['baseline']);
  await f.drain();
  await f.ingest(Array.from({length: 40}, (_, index) => `delta-${index}`));
  const snapshot = await f.drain();
  assert.deepEqual(f.requests.slice(1).map(request => request.messages.length), [16, 16, 8]);
  assert.deepEqual(f.checkpoints.slice(1), [1, 17, 33]);
  assert.equal(f.state.analysis.hashes.length, 41);
  assert.equal(snapshot.summaryRevision, snapshot.sourceRevision);
  assert.equal(snapshot.analysis.pendingMessages, 0);
  assert.equal(snapshot.analysis.contextMessages, 8);
  assert.equal(new Set(f.requests.slice(1).flatMap(request => request.messages.map(row => row.messageId))).size, 40);
  assert.ok(f.requests.slice(1).every(request => !JSON.stringify(request.previousSummary).includes('"quote"')),
    'old source quotations must not be hidden inside the derived previous summary');
});

test('summary full correction covers all retained messages in chronological batches and runs again after a day', async t => {
  const f = await fixture(t);
  await f.ingest(Array.from({length: 140}, (_, index) => `baseline-${index}`));
  let snapshot = await f.drain();
  assert.deepEqual(f.requests.map(request => request.messages.length), [64, 64, 12]);
  assert.deepEqual(f.requests.flatMap(request => request.messages.map(row => row.messageId)),
    Array.from({length: 140}, (_, index) => `baseline-${index}`));
  assert.equal(snapshot.analysis.fullProcessedMessages, 140);
  assert.equal(snapshot.analysis.fullTotalMessages, 140);
  assert.equal(snapshot.analysis.contextMessages, 12);
  const calls = f.requests.length;
  await f.drain();
  assert.equal(f.requests.length, calls);
  f.advance(24 * 60 * 60 * 1000 + 1);
  snapshot = await f.drain();
  assert.deepEqual(f.requests.slice(calls).map(request => request.messages.length), [64, 64, 12]);
  assert.equal(snapshot.analysis.pendingMessages, 0);
  assert.equal(snapshot.analysis.fullProcessedMessages, 140);
  assert.equal(snapshot.analysis.contextMessages, 12);
});

test('summary correction threshold counts successful incremental batches rather than newly received messages', async t => {
  const f = await fixture(t);
  await f.ingest(['baseline']);
  await f.drain();
  for (let index = 0; index < 20; index++) {
    await f.ingest([`turn-${index}`]);
    await f.drain();
  }
  await f.drain();
  const full = f.requests.filter(request => request.analysis.mode === 'full');
  const delta = f.requests.filter(request => request.analysis.mode === 'incremental');
  assert.equal(delta.length, 20);
  assert.equal(full.length, 2);
  assert.equal(full[1].messages.length, 21);
  assert.equal(f.state.analysis.deltasSinceFull, 0);
});
