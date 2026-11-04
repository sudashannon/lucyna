const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {WorkWorkflow, validateReminder} = require('../src/work-workflow.cjs');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function makeSources(revision = 1, userText = '我决定不再沿用旧编译流程，改为先确认 Python 版本。') {
  return [
    {sessionId: 'session-a', messageId: 'user-1', role: 'user', title: '构建流程', at: 1, text: userText},
    {sessionId: 'session-b', messageId: 'assistant-2', role: 'assistant', title: '构建流程讨论', at: 2, text: '先检查 Python 版本，再决定后续构建步骤。'},
  ];
}

function setupAssistant({sources = makeSources(), sourceRevision = 1, enabled = true} = {}) {
  const current = {sources, sourceRevision, enabled};
  const identity = input => ({
    root: input.root,
    hostId: input.hostId || '',
    workId: digest(JSON.stringify([input.hostId || 'local', input.root])),
  });
  const assistant = {
    identity,
    async evidence(input) {
      const resolved = identity(input);
      return {
        ...resolved,
        ...(resolved.hostId ? {hostId: resolved.hostId} : {}),
        enabled: current.enabled,
        sourceRevision: current.sourceRevision,
        sessions: [
          {sessionId: 'session-a', title: '构建流程', messageCount: 1, lastActivityAt: 1},
          {sessionId: 'session-b', title: '构建流程讨论', messageCount: 1, lastActivityAt: 2},
        ],
        coverage: {sessions: 2, totalMessages: 2, visibleMessages: current.sources.length, omittedMessages: 0, historyCoverage: {}},
        sources: structuredClone(current.sources),
      };
    },
    async view(input) {
      const resolved = identity(input);
      return {workId: resolved.workId, root: input.root, hostId: input.hostId || undefined, enabled: current.enabled,
        sourceRevision: current.sourceRevision, summaryRevision: current.sourceRevision, summary: {overview: {text: 'summary'}}};
    },
  };
  return {assistant, current};
}

function makeReminder(sourceQuote = '我决定不再沿用旧编译流程，改为先确认 Python 版本。') {
  return {
    kind: 'record_update',
    key: 'Python 构建流程',
    title: '同步构建流程记录',
    reason: '用户明确调整了构建流程，SESSION.md 仍记录旧流程。',
    draftText: '建议把 Work 当前流程更新为先确认 Python 版本，再执行构建。',
    sources: [
      {type: 'conversation', sessionId: 'session-a', messageId: 'user-1', role: 'user', quote: sourceQuote},
      {type: 'record', path: 'SESSION.md', quote: '当前流程：仍使用旧编译流程。'},
    ],
  };
}

async function fixture(t, {source, record, output, run, clock, debounceMs = 0} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucyna-work-workflow-'));
  const {assistant, current} = setupAssistant(source || {});
  const calls = [];
  const agent = {run: async (config, instructions, prompt, signal, options) => {
    calls.push({config, instructions, prompt: JSON.parse(prompt), signal, options});
    if (run) return run({config, instructions, prompt: JSON.parse(prompt), signal, options, calls});
    return {text: JSON.stringify({reminders: output || [makeReminder()]}), finishReason: 'stop'};
  }};
  const recordState = {value: record === undefined ? {available: true, path: 'SESSION.md', text: '# Work\n\n当前流程：仍使用旧编译流程。', version: digest('# Work\n\n当前流程：仍使用旧编译流程。')} : record};
  const notifications = [];
  const options = {
    directory,
    assistant,
    agent,
    config: async () => ({baseURL: 'http://fixture.invalid/v1', model: 'fixture'}),
    configVersion: () => 1,
    resolveWork: async () => {},
    readRecord: async () => structuredClone(recordState.value),
    notify: snapshot => notifications.push(snapshot),
    ...(clock ? {clock} : {}),
    debounceMs,
  };
  const workflow = new WorkWorkflow(options);
  t.after(async () => {
    await workflow.close();
    await fs.rm(directory, {recursive: true, force: true});
  });
  return {workflow, assistant, current, directory, calls, notifications, recordState, options};
}

test('流程建议要求逐字来源，短原文引用可用', () => {
  const short = new Map([[JSON.stringify(['session-a', 'm1']), {role: 'user', text: '不要'}]]);
  assert.ok(validateReminder({
    kind: 'handover', key: 'handover', title: '整理交接', reason: '用户明确要求暂停并交接。', draftText: '请先整理交接内容。',
    sources: [{type: 'conversation', sessionId: 'session-a', messageId: 'm1', role: 'user', quote: '不要'}],
  }, short, ''));
  const sent = new Map([[JSON.stringify(['session-a', 'm1']), {role: 'user', text: '当前方向是 A，不要改变。'}]]);
  assert.equal(validateReminder({
    ...makeReminder('当前方向是 A，不要改变。'),
    sources: [{type: 'conversation', sessionId: 'session-a', messageId: 'm1', role: 'user', quote: '用户刚刚说要改变方向'}],
  }, sent, '# Work\n\n当前流程：仍使用旧编译流程。'), null);
  assert.equal(validateReminder({
    ...makeReminder('当前方向是 A，不要改变。'),
    sources: [{type: 'conversation', sessionId: 'session-a', messageId: 'm1', role: 'user', quote: '当前方向是 A，不要改变。'},
      {type: 'record', path: 'SESSION.md', quote: '当前流程：仍使用旧编译流程。'}],
  }, sent, ''), null, '没有可读取的 Work 文档时不能生成 record_update');
});

test('只用无工具辅助调用生成建议，并把核对出处一并放入草稿', async t => {
  const f = await fixture(t);
  const identity = {root: '/work/demo'};
  const {snapshot} = await f.workflow.call('refresh', identity);
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.reminders.length, 1);
  assert.equal(snapshot.reminders[0].kind, 'record_update');
  assert.equal(snapshot.reminders[0].sources.length, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.tools, undefined);
  assert.match(f.calls[0].instructions, /Different wording or absent text alone is not evidence of conflict/);
  assert.equal(f.calls[0].prompt.record.path, 'SESSION.md');
  assert.equal(f.calls[0].prompt.conversations[0].text, '我决定不再沿用旧编译流程，改为先确认 Python 版本。');

  const drafted = await f.workflow.call('action', {...identity, id: snapshot.reminders[0].id,
    revision: snapshot.stateRevision, action: 'draft'});
  assert.match(drafted.draftText, /建议把 Work 当前流程更新为先确认 Python 版本/);
  assert.match(drafted.draftText, /sessionId=session-a，messageId=user-1/);
  assert.match(drafted.draftText, /SESSION\.md（SHA-256 [a-f0-9]{64}）/);
  assert.match(drafted.draftText, /当前流程：仍使用旧编译流程。/);
  assert.equal(drafted.snapshot.reminders[0].state, 'viewed');
  assert.ok(drafted.snapshot.stateRevision > snapshot.stateRevision);
});

test('相同证据保留忽略状态，支持证据改变后同一语义提醒重新出现', async t => {
  const f = await fixture(t);
  const identity = {root: '/work/dedupe'};
  const first = await f.workflow.refresh(identity, {automatic: true});
  const reminder = first.reminders[0];
  const ignored = await f.workflow.call('action', {...identity, id: reminder.id, revision: first.stateRevision, action: 'dismiss'});
  assert.equal(ignored.snapshot.reminders[0].state, 'dismissed');

  await f.workflow.refresh(identity, {automatic: true});
  assert.equal(f.calls.length, 1, '相同来源和版本不重复调用模型');
  const persisted = new WorkWorkflow(f.options);
  const loaded = await persisted.call('status', identity);
  assert.equal(loaded.snapshot.reminders[0].state, 'dismissed');
  await persisted.close();

  const changedQuote = '我决定改用 Python 3.12，并停止沿用旧编译流程。';
  f.current.sourceRevision = 2;
  f.current.sources = makeSources(2, changedQuote);
  f.workflow.agent.run = async (config, instructions, prompt, signal, options) => {
    f.calls.push({config, instructions, prompt: JSON.parse(prompt), signal, options});
    return {text: JSON.stringify({reminders: [makeReminder(changedQuote)]}), finishReason: 'stop'};
  };
  const refreshed = await f.workflow.refresh(identity, {automatic: true});
  assert.equal(f.calls.length, 2);
  assert.equal(refreshed.reminders[0].id, reminder.id, '语义身份保持稳定');
  assert.equal(refreshed.reminders[0].state, 'new', '新的支持证据会重新显示之前忽略的提醒');
});

test('无关新消息和引用窗口变化不会让改写 key 的旧提醒重新出现', async t => {
  const f = await fixture(t);
  const identity = {root: '/work/stable-evidence'};
  const first = await f.workflow.refresh(identity, {automatic: true});
  const reminder = first.reminders[0];
  await f.workflow.call('action', {...identity, id: reminder.id, revision: first.stateRevision, action: 'dismiss'});

  f.current.sourceRevision = 2;
  f.current.sources = [
    ...makeSources(),
    {sessionId: 'session-c', messageId: 'assistant-new', role: 'assistant', title: '其他讨论', at: 3,
      text: '顺便记录界面主题颜色的调整，不涉及构建流程。'},
  ];
  f.workflow.agent.run = async (config, instructions, prompt, signal, options) => {
    const parsed = JSON.parse(prompt);
    f.calls.push({config, instructions, prompt: parsed, signal, options});
    assert.equal(parsed.priorReminderIdentifiers[0].key, reminder.key,
      '历史标识作为去重提示传给模型，且不是证据引用');
    const generated = makeReminder('Python 版本。');
    generated.key = '先核对 Python 版本';
    generated.title = '复查 Python 构建步骤';
    generated.sources[0].quote = '我决定不再沿用旧编译流程，改为先确认 Python 版本。';
    return {text: JSON.stringify({reminders: [generated, {...generated, key: '构建环境检查', title: '重复的构建检查'}]}), finishReason: 'stop'};
  };

  const refreshed = await f.workflow.refresh(identity, {automatic: true});
  assert.equal(f.calls.length, 2);
  assert.equal(refreshed.reminders[0].id, reminder.id, '同一原生来源保持同一稳定提醒身份');
  assert.equal(refreshed.reminders[0].state, 'dismissed', '新消息和新 key 不重置未变化证据的忽略状态');
  assert.equal(refreshed.reminders.filter(item => item.active).length, 1, '同一支持来源不会在一次模型回复中重复生成卡片');
});

test('提醒状态落盘失败时不提交内存状态或版本', async t => {
  const f = await fixture(t);
  const identity = {root: '/work/persist-failure'};
  const first = await f.workflow.refresh(identity);
  const liveState = f.workflow.states.get(first.workId);
  const persist = f.workflow.persist.bind(f.workflow);
  f.workflow.persist = () => Promise.reject(Error('fixture disk failure'));

  await assert.rejects(f.workflow.call('action', {...identity, id: first.reminders[0].id,
    revision: first.stateRevision, action: 'view'}), /fixture disk failure/);
  assert.equal(f.workflow.states.get(first.workId), liveState, '状态对象身份保留');
  assert.equal(liveState.stateRevision, first.stateRevision, '失败写盘不推进版本');
  assert.equal(liveState.reminders[0].state, 'new', '失败写盘不改变提醒状态');

  f.workflow.persist = persist;
});

test('状态变更会推进乐观版本，旧版本操作和过期来源草稿都会被拒绝', async t => {
  const f = await fixture(t);
  const identity = {root: '/work/version'};
  const first = await f.workflow.refresh(identity);
  const seen = await f.workflow.call('action', {...identity, id: first.reminders[0].id,
    revision: first.stateRevision, action: 'view'});
  assert.ok(seen.snapshot.stateRevision > first.stateRevision);
  await assert.rejects(f.workflow.call('action', {...identity, id: first.reminders[0].id,
    revision: first.stateRevision, action: 'draft'}), /状态已更新/);

  f.current.sourceRevision++;
  f.current.sources = makeSources(2, '我决定改用 Python 3.12，并停止沿用旧编译流程。');
  await assert.rejects(f.workflow.call('action', {...identity, id: first.reminders[0].id,
    revision: seen.snapshot.stateRevision, action: 'draft'}), /已更新，请先刷新/);
});

test('remote Work 文档不可读时仍可做有出处的 handover，但不能伪造 record_update', async t => {
  const handover = {
    kind: 'handover', key: 'pending-handover', title: '整理待办交接', reason: '会话明确留下了未完成的步骤。',
    draftText: '请先核对构建环境，再继续当前任务。',
    sources: [{type: 'conversation', sessionId: 'session-a', messageId: 'user-1', role: 'user', quote: '我决定不再沿用旧编译流程，改为先确认 Python 版本。'}],
  };
  const f = await fixture(t, {record: {available: false, reason: 'SSH 未连接'}});
  f.workflow.agent.run = async () => ({text: JSON.stringify({reminders: [handover]}), finishReason: 'stop'});
  const result = await f.workflow.call('refresh', {root: '/work/remote', hostId: 'host-1'});
  assert.equal(result.snapshot.recordAvailable, false);
  assert.match(result.snapshot.recordWarning, /SSH 未连接/);
  assert.equal(result.snapshot.reminders[0].kind, 'handover');
  assert.equal(result.snapshot.reminders[0].sources.some(source => source.type === 'record'), false);
});

test('同一 summary 的重复通知只安排一次，来源变化会取消正在运行的旧结果', async t => {
  let release;
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {run: async ({calls}) => {
    if (calls.length === 1) {
      started();
      await gate;
      return {text: JSON.stringify({reminders: [makeReminder()]}), finishReason: 'stop'};
    }
    return {text: JSON.stringify({reminders: [makeReminder('我决定改用 Python 3.12，并停止沿用旧编译流程。')]}), finishReason: 'stop'};
  }, debounceMs: 10});
  const identity = {root: '/work/observe'};
  const summarySnapshot = {root: identity.root, enabled: true, sourceRevision: 1, summaryRevision: 1, summary: {overview: {text: '摘要'}}};
  f.workflow.observe(summarySnapshot);
  f.workflow.observe(summarySnapshot);
  await start;
  f.current.sourceRevision = 2;
  f.current.sources = makeSources(2, '我决定改用 Python 3.12，并停止沿用旧编译流程。');
  f.workflow.observe({...summarySnapshot, sourceRevision: 2, summaryRevision: 1, summary: null});
  release();
  await f.workflow.queue;
  assert.equal(f.workflow.states.get(f.assistant.identity(identity).workId).currentReminderIds.length, 0,
    '被取消的旧模型结果不能重新写入活动提醒');
  await f.workflow.refresh(identity, {automatic: true});
  assert.equal(f.calls.length, 2, '相同 summary 通知只触发一次，后续新来源可触发一次');
});

test('同 Work 路径的本机与不同远端身份隔离，多个 Work 的模型请求仍串行', async t => {
  let active = 0;
  let maxActive = 0;
  const f = await fixture(t, {run: async ({calls}) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    active--;
    const quote = '我决定不再沿用旧编译流程，改为先确认 Python 版本。';
    return {text: JSON.stringify({reminders: [makeReminder(quote)]}), finishReason: 'stop'};
  }});
  const [local, remoteA, remoteB] = await Promise.all([
    f.workflow.call('refresh', {root: '/work/same-path'}),
    f.workflow.call('refresh', {root: '/work/same-path', hostId: 'host-a'}),
    f.workflow.call('refresh', {root: '/work/same-path', hostId: 'host-b'}),
  ]);
  assert.equal(new Set([local.snapshot.workId, remoteA.snapshot.workId, remoteB.snapshot.workId]).size, 3);
  assert.equal(maxActive, 1);
  assert.equal((await fs.readdir(f.directory)).filter(name => name.endsWith('.json')).length, 3);
});

test('forgetSession 清理该 Work 的所有提醒派生文本', async t => {
  const f = await fixture(t);
  const identity = {root: '/work/forget'};
  const result = await f.workflow.call('refresh', identity);
  assert.equal(result.snapshot.reminders.length, 1);
  const forgotten = await f.workflow.forgetSession(identity, 'session-a');
  assert.equal(forgotten.reminders.length, 0);
  const loaded = await f.workflow.call('status', identity);
  assert.equal(loaded.snapshot.reminders.length, 0);
  assert.equal(await fs.readFile(path.join(f.directory, result.snapshot.workId + '.json'), 'utf8').then(text => text.includes('我决定不再沿用旧编译流程')), false);
});
