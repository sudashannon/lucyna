const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {WorkAssistant} = require('../src/work-assistant.cjs');
const {WorkWorkflow} = require('../src/work-workflow.cjs');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucyna-workflow-incremental-'));
  const requests = [];
  let now = 1000000, reads = 0, fail = false;
  const record = '# 工作记录\n计划：先整理构建资料，不执行设备验证。\n\n无关说明：此段只用于分隔原始行。\n\n决定：保留未验证事项供下一会话处理。';
  const config = async () => ({baseURL: 'http://fixture.invalid', model: 'fixture', apiKey: 'fixture'});
  const agent = {run: async (_config, _instructions, raw) => {
    const payload = JSON.parse(raw);
    requests.push(payload);
    if (fail) throw Error('fixture offline');
    options.inspect?.(payload, record);
    return {text: JSON.stringify({reminders: []}), finishReason: 'stop', totalUsage: {inputTokens: 10, outputTokens: 5}};
  }};
  const assistant = new WorkAssistant({directory: path.join(directory, 'summary'), agent, config,
    clock: () => now, debounceMs: 600000});
  const workflow = new WorkWorkflow({directory: path.join(directory, 'workflow'), assistant, agent, config,
    clock: () => now, debounceMs: 600000,
    readRecord: async identity => {
      reads++;
      return options.readRecord ? options.readRecord(identity, reads)
        : {available: true, path: 'SESSION.md', text: record, version: 'record-v1'};
    }});
  const identity = {root: '/work/incremental-fixture'};
  const ingest = async (ids, extra = {}) => assistant.ingest({...identity, sessionId: 'first', title: '构建资料整理',
    messages: ids.map(id => ({id, role: 'user', timestamp: now++, content: `消息 ${id}：整理构建资料，保留未验证事项。`})), ...extra}, {schedule: false});
  const refresh = async () => (await workflow.call('refresh', identity)).snapshot;
  t.after(async () => {
    await workflow.close(); await assistant.close(); await fs.rm(directory, {recursive: true, force: true});
  });
  return {assistant, workflow, identity, ingest, refresh, requests,
    get reads() { return reads; }, advance: delta => { now += delta; }, fail: value => { fail = value; }};
}

test('workflow scans all retained inventory in bounded batches, then only changed messages, and periodically corrects all sources', async t => {
  const f = await fixture(t);
  await f.ingest(Array.from({length: 80}, (_, index) => `m${index}`));
  let snapshot;
  for (let batch = 0; batch < 3; batch++) snapshot = await f.refresh();
  assert.equal(snapshot.status, 'idle', snapshot.error);
  assert.equal(snapshot.analysis.pendingMessages, 0);
  assert.equal(snapshot.analysis.fullProcessedMessages, 80);
  assert.deepEqual(f.requests.map(request => request.conversations.length), [32, 32, 16]);
  assert.equal(snapshot.analysis.contextMessages, 16, 'the displayed full count describes the last actual batch');
  assert.equal(new Set(f.requests.flatMap(request => request.conversations.map(row => row.excerpts[0].text))).size, 80);

  await f.ingest(['new-message']);
  snapshot = await f.refresh();
  assert.equal(snapshot.analysis.mode, 'incremental');
  assert.equal(snapshot.analysis.changedMessages, 1);
  assert.equal(snapshot.analysis.contextMessages, 1);
  assert.equal(f.requests.at(-1).conversations.length, 1);
  assert.match(f.requests.at(-1).conversations[0].excerpts[0].text, /new-message/);
  const before = f.requests.length;
  await f.refresh();
  assert.equal(f.requests.length, before, 'manual refresh also honors the successful checkpoint');

  f.advance(24 * 60 * 60 * 1000 + 1);
  snapshot = await f.refresh();
  assert.equal(snapshot.analysis.mode, 'full');
  assert.equal(snapshot.analysis.contextMessages, 32);
  assert.equal(snapshot.analysis.fullProcessedMessages, 32);
  assert.equal(snapshot.analysis.fullTotalMessages, 81);
  assert.equal(snapshot.analysis.pendingMessages, 49);
  await f.refresh();
  snapshot = await f.refresh();
  assert.equal(snapshot.analysis.fullProcessedMessages, 81);
  assert.equal(snapshot.analysis.pendingMessages, 0);
  assert.equal(snapshot.currentAnalysis, true);
});

test('workflow polling shares SESSION.md reads, reuses the 60-second cache, and keeps selected excerpts verbatim', async t => {
  const f = await fixture(t, {inspect(payload, record) {
    for (const excerpt of payload.record.excerpts || []) assert.ok(record.includes(excerpt.text), 'each excerpt is a real contiguous record fragment');
  }});
  await f.ingest(['one']);
  await Promise.all(Array.from({length: 5}, () => f.workflow.call('status', f.identity)));
  assert.equal(f.reads, 1);
  f.advance(59999);
  await f.workflow.call('status', f.identity);
  assert.equal(f.reads, 1);
  f.advance(2);
  await f.workflow.call('status', f.identity);
  assert.equal(f.reads, 2);
  await f.refresh();
  const reads = f.reads, calls = f.requests.length;
  await Promise.all(Array.from({length: 5}, () => f.workflow.call('status', f.identity)));
  assert.equal(f.reads, reads);
  assert.equal(f.requests.length, calls);
});

test('forced record validation cannot reuse an older in-flight status read', async t => {
  const pending = [];
  const f = await fixture(t, {readRecord: () => new Promise(resolve => pending.push(resolve))});
  const identity = f.workflow.identity(f.identity);
  const first = f.workflow.readRecordSnapshot(identity);
  await new Promise(resolve => setImmediate(resolve));
  const forced = f.workflow.readRecordSnapshot(identity, {force: true});
  pending[0]({available: true, path: 'SESSION.md', text: '旧计划：先执行设备验证。', version: 'old'});
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1]({available: true, path: 'SESSION.md', text: '新计划：只整理资料，不执行设备验证。', version: 'new'});
  const fresh = await forced;
  assert.match(fresh.text, /新计划/);
  const cached = await f.workflow.readRecordSnapshot(identity);
  assert.deepEqual(cached, fresh);
  assert.equal(f.reads, 2);
});

test('a failed delta keeps its source pending and a manual retry analyzes that same message', async t => {
  const f = await fixture(t);
  await f.ingest(['baseline']);
  await f.refresh();
  await f.ingest(['delta']);
  f.fail(true);
  let snapshot = await f.refresh();
  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.analysis.pendingMessages, 1);
  const calls = f.requests.length;
  await f.workflow.call('status', f.identity);
  assert.equal(f.requests.length, calls);
  f.fail(false);
  snapshot = await f.refresh();
  assert.equal(snapshot.status, 'idle', snapshot.error);
  assert.equal(snapshot.analysis.contextMessages, 1);
  assert.equal(snapshot.analysis.pendingMessages, 0);
  assert.match(f.requests.at(-1).conversations[0].excerpts[0].text, /delta/);
});

test('metadata-only source revisions do not dispatch another workflow model call', async t => {
  const f = await fixture(t);
  await f.ingest(['one']);
  await f.refresh();
  const calls = f.requests.length;
  await f.ingest(['one'], {title: '重命名后的工作资料'});
  const snapshot = await f.refresh();
  assert.equal(f.requests.length, calls);
  assert.equal(snapshot.currentAnalysis, true);
  assert.equal(snapshot.analysis.pendingMessages, 0);
});

test('workflow checkpoint does not advance when saving a validated delta fails', async t => {
  const f = await fixture(t);
  await f.ingest(['baseline']);
  await f.refresh();
  await f.ingest(['delta']);
  const key = JSON.stringify(['first', 'delta']);
  const {state} = await f.workflow.load(f.identity);
  const checkpoint = structuredClone(state.checkpointHashes);
  const persist = f.workflow.persist.bind(f.workflow);
  let injected = false;
  f.workflow.persist = async (identity, candidate) => {
    if (!injected && candidate.checkpointHashes[key]) { injected = true; throw Error('fixture disk full'); }
    return persist(identity, candidate);
  };
  let snapshot = await f.refresh();
  assert.equal(injected, true);
  assert.equal(snapshot.status, 'error');
  assert.deepEqual(state.checkpointHashes, checkpoint);
  assert.equal(snapshot.analysis.pendingMessages, 1);
  f.workflow.persist = persist;
  snapshot = await f.refresh();
  assert.equal(snapshot.status, 'idle', snapshot.error);
  assert.equal(snapshot.analysis.changedMessages, 1);
  assert.equal(snapshot.analysis.pendingMessages, 0);
});
