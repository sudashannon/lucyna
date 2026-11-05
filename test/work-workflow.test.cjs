const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {WorkWorkflow, validateReminder} = require('../src/work-workflow.cjs');
const {addEvidence} = require('../src/work-evidence.cjs');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function makeSources(revision = 1, userText = '我决定不再沿用旧编译流程，改为先确认 Python 版本。') {
  return [
    {sessionId: 'session-a', messageId: 'user-1', role: 'user', title: '构建流程', at: 1, text: userText},
    {sessionId: 'session-b', messageId: 'assistant-2', role: 'assistant', title: '构建流程讨论', at: 2, text: '先检查 Python 版本，再决定后续构建步骤。'},
  ];
}

function setupAssistant({sources = makeSources(), sourceRevision = 1, enabled = true, summaryReady = true, summaryStatus = 'idle'} = {}) {
  const current = {sources, sourceRevision, enabled, summaryReady, summaryStatus};
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
        status: current.summaryStatus, sourceRevision: current.sourceRevision,
        summaryRevision: current.summaryReady ? current.sourceRevision : 0,
        summary: current.summaryReady ? {overview: {text: 'summary'}} : null};
    },
  };
  return {assistant, current};
}

function makeReminder() {
  return {
    kind: 'record_update',
    key: 'Python 构建流程',
    title: '同步构建流程记录',
    reason: '用户明确调整了构建流程，SESSION.md 仍记录旧流程。',
    draftText: '建议把 Work 当前流程更新为先确认 Python 版本，再执行构建。',
    sources: [
      {evidenceId: 'c1.1'},
      {evidenceId: 'r1.1'},
    ],
  };
}

async function fixture(t, {source, record, output, run, clock, debounceMs = 0} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucyna-work-workflow-'));
  const {assistant, current} = setupAssistant(source || {});
  const calls = [];
  const configurationVersion = {value: 1};
  const agent = {run: async (config, instructions, prompt, signal, options, timeout) => {
    calls.push({config, instructions, prompt: JSON.parse(prompt), signal, options, timeout});
    if (run) return run({config, instructions, prompt: JSON.parse(prompt), signal, options, timeout, calls});
    return {text: JSON.stringify({reminders: output || [makeReminder()]}), finishReason: 'stop'};
  }};
  const recordState = {value: record === undefined ? {available: true, path: 'SESSION.md', text: '# Work\n\n当前流程：仍使用旧编译流程。', version: digest('# Work\n\n当前流程：仍使用旧编译流程。')} : record};
  const notifications = [];
  const options = {
    directory,
    assistant,
    agent,
    config: async () => ({baseURL: 'http://fixture.invalid/v1', model: 'minimax-cn/MiniMax-M3.1-Flash', protocol: 'responses', timeoutSeconds: 30}),
    configVersion: () => configurationVersion.value,
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
  return {workflow, assistant, current, directory, calls, notifications, recordState, options, configurationVersion};
}

async function until(predicate, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw Error('Timed out waiting for workflow condition');
}

test('流程建议要求逐字来源，短原文引用可用', () => {
  const short = new Map([[JSON.stringify(['session-a', 'm1']), {role: 'user', text: '  不要\n'}]]);
  assert.ok(validateReminder({
    kind: 'handover', key: 'handover', title: '整理交接', reason: '用户明确要求暂停并交接。', draftText: '请先整理交接内容。',
    sources: [{type: 'conversation', sessionId: 'session-a', messageId: 'm1', role: 'user', quote: '不要'}],
  }, short, ''));
  const recordShort = new Map([[JSON.stringify(['session-a', 'm2']), {role: 'user', text: '我已确认工作流程更新。'}]]);
  assert.ok(validateReminder({
    kind: 'record_update', key: '流程记录', title: '更新流程记录', reason: '用户已确认更新，记录需同步。', draftText: '请同步已确认的流程。',
    sources: [
      {type: 'conversation', sessionId: 'session-a', messageId: 'm2', role: 'user', quote: '我已确认工作流程更新。'},
      {type: 'record', path: 'SESSION.md', quote: '不要'},
    ],
  }, recordShort, '  不要\n'), 'surrounding whitespace does not inflate the minimum quote length');
  const sent = new Map([[JSON.stringify(['session-a', 'm1']), {role: 'user', text: '当前方向是 A，不要改变。'}]]);
  assert.equal(validateReminder({
    ...makeReminder(),
    sources: [{type: 'conversation', sessionId: 'session-a', messageId: 'm1', role: 'user', quote: '用户刚刚说要改变方向'}],
  }, sent, '# Work\n\n当前流程：仍使用旧编译流程。'), null);
  assert.equal(validateReminder({
    ...makeReminder(),
    sources: [{type: 'conversation', sessionId: 'session-a', messageId: 'm1', role: 'user', quote: '当前方向是 A，不要改变。'},
      {type: 'record', path: 'SESSION.md', quote: '当前流程：仍使用旧编译流程。'}],
  }, sent, ''), null, '没有可读取的 Work 文档时不能生成 record_update');
});

test('short source IDs map to canonical evidence and retain exact quote checks', () => {
  const sessionId = 'opaque-session-journal-hash';
  const messageId = 'opaque-message-journal-hash';
  const text = '用户确认要先检查 Python 版本再执行构建。';
  const sent = new Map([[JSON.stringify([sessionId, messageId]), {role: 'user', text}]]);
  const sourceIds = new Map([['c1', {sessionId, messageId, role: 'user'}]]);
  const reminder = {
    kind: 'handover', key: 'python-build', title: '交接构建步骤', reason: '当前会话明确留下了下一步。',
    draftText: '继续前先检查 Python 版本。',
    sources: [{type: 'conversation', sourceId: 'c1', quote: '先检查 Python 版本再执行构建'}],
  };
  assert.deepEqual(validateReminder(reminder, sent, '', sourceIds)?.sources[0], {
    type: 'conversation', sessionId, messageId, role: 'user', quote: '先检查 Python 版本再执行构建',
  });
  assert.equal(validateReminder({...reminder, sources: [{...reminder.sources[0], quote: 'Python 版本不存在于原文'}]}, sent, '', sourceIds), null,
    'short IDs do not weaken exact substring checks');
  assert.equal(validateReminder({...reminder, sources: [{...reminder.sources[0], sessionId}]}, sent, '', sourceIds), null,
    'short IDs reject mixed long identifiers');
  assert.equal(validateReminder({...reminder, sources: [{...reminder.sources[0], quote: 'x'.repeat(801)}]}, sent, '', sourceIds), null,
    'quote length remains bounded at 800 characters');
  const legacy = {...reminder, sources: [{type: 'conversation', sessionId, messageId, role: 'user', quote: '先检查 Python 版本再执行构建'}]};
  assert.ok(validateReminder(legacy, sent, ''), 'the original citation format remains supported');
});

test('evidence IDs resolve only to exact request-local excerpts and preserve kind requirements', () => {
  const sent = new Map([
    [JSON.stringify(['session-a', 'user-1']), {role: 'user', text: '用户确认先整理构建日志，再修改代码。'}],
    [JSON.stringify(['session-b', 'assistant-2']), {role: 'assistant', text: '此前已完成构建日志清理并记录结果。'}],
  ]);
  const evidenceMap = new Map();
  const userExcerpts = addEvidence('用户确认先整理构建日志，再修改代码。', 'c1',
    {type: 'conversation', sessionId: 'session-a', messageId: 'user-1', role: 'user'}, evidenceMap);
  const assistantExcerpts = addEvidence('此前已完成构建日志清理并记录结果。', 'c2',
    {type: 'conversation', sessionId: 'session-b', messageId: 'assistant-2', role: 'assistant'}, evidenceMap);
  const recordText = '当前计划：先修改代码，再整理构建日志。';
  const recordExcerpts = addEvidence(recordText, 'r1', {type: 'record', path: 'SESSION.md'}, evidenceMap);
  const base = {kind: 'record_update', key: 'build-order', title: '同步构建顺序',
    reason: '用户明确改变计划，记录中仍保留旧顺序。', draftText: '请核对后同步已确认的构建顺序。'};
  const reminder = {...base, sources: [{evidenceId: userExcerpts[0].evidenceId}, {evidenceId: recordExcerpts[0].evidenceId}]};
  const validated = validateReminder(reminder, sent, recordText, new Map(), evidenceMap);
  assert.equal(validated.sources[0].quote, userExcerpts[0].text, 'the host restores the exact quote from its own excerpt map');
  assert.deepEqual(validated.sources[0], {type: 'conversation', sessionId: 'session-a', messageId: 'user-1',
    role: 'user', quote: '用户确认先整理构建日志，再修改代码。'});
  assert.deepEqual(validated.sources[1], {type: 'record', path: 'SESSION.md', quote: recordExcerpts[0].text});

  for (const source of [
    {evidenceId: 'c999.1'},
    {evidenceId: userExcerpts[0].evidenceId, quote: userExcerpts[0].text},
    {evidenceId: userExcerpts[0].evidenceId, type: 'record'},
  ]) {
    assert.equal(validateReminder({...reminder, sources: [source, reminder.sources[1]]}, sent, recordText, new Map(), evidenceMap), null,
      'unknown IDs and caller-supplied provenance/quote overrides are rejected');
  }

  assert.equal(validateReminder({...base, kind: 'handover', sources: [{evidenceId: recordExcerpts[0].evidenceId}]},
    sent, recordText, new Map(), evidenceMap), null, 'record evidence alone cannot satisfy a handover');
  assert.equal(validateReminder({...base, kind: 'record_update', sources: [
    {evidenceId: assistantExcerpts[0].evidenceId}, {evidenceId: recordExcerpts[0].evidenceId},
  ]}, sent, recordText, new Map(), evidenceMap), null, 'record updates require a user conversation citation');
  assert.ok(validateReminder({...base, kind: 'handover', sources: [{evidenceId: userExcerpts[0].evidenceId}]},
    sent, recordText, new Map(), evidenceMap), 'handover can be supported by a conversation excerpt alone');

  assert.ok(validateReminder({...base, kind: 'result_reuse', sources: [
    {evidenceId: userExcerpts[0].evidenceId}, {evidenceId: assistantExcerpts[0].evidenceId},
  ]}, sent, recordText, new Map(), evidenceMap), 'result reuse citations resolve to different session identities');
  assert.equal(validateReminder({...base, kind: 'result_reuse', sources: [
    {evidenceId: userExcerpts[0].evidenceId}, {evidenceId: userExcerpts[0].evidenceId},
  ]}, sent, recordText, new Map(), evidenceMap), null, 'result reuse still requires distinct sessions and messages');
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
  assert.equal(f.calls[0].options.maxOutputTokens, undefined, 'workflow synthesis has no artificial output token cap');
  assert.deepEqual(f.calls[0].timeout, {stepMs: 600000, totalMs: 600000}, 'workflow deadline does not inherit the 30 second settings timeout');
  assert.equal(f.calls[0].config.timeoutSeconds, 30);
  assert.match(f.calls[0].instructions, /Different wording or absent text alone is not evidence of conflict/);
  assert.equal(f.calls[0].prompt.record.path, 'SESSION.md');
  assert.equal(f.calls[0].prompt.conversations[0].excerpts[0].text, '我决定不再沿用旧编译流程，改为先确认 Python 版本。');
  assert.equal(f.calls[0].prompt.conversations[0].excerpts[0].evidenceId, 'c1.1');
  assert.equal(f.calls[0].prompt.conversations[0].sessionLabel, 's1');
  assert.equal(f.calls[0].prompt.conversations[0].sourceId, 'c1');
  assert.equal(f.calls[0].prompt.conversations[0].sessionId, undefined, 'the model sees short source IDs instead of opaque session identifiers');
  assert.equal(f.calls[0].prompt.conversations[0].messageId, undefined);
  assert.equal(f.calls[0].prompt.record.text, undefined, 'raw SESSION.md text is represented only by exact excerpts');
  assert.equal(f.calls[0].prompt.record.excerpts[0].evidenceId, 'r1.1');
  assert.equal(f.calls[0].prompt.sessions[0].sessionId, undefined, 'session labels avoid exposing opaque session identities');
  assert.match(f.calls[0].instructions, /key at most 120 characters, title at most 160, reason at most 1000, and draftText at most 4000/);
  assert.match(f.calls[0].instructions, /evidenceId/);
  assert.equal(snapshot.currentAnalysis, true);
  f.configurationVersion.value++;
  const resolvedIdentity = f.workflow.identity(identity);
  const current = await f.workflow.getCurrent(resolvedIdentity);
  const stored = f.workflow.states.get(snapshot.workId);
  assert.equal(f.workflow.publicSnapshot(resolvedIdentity, stored, current).currentAnalysis, false,
    'a configuration change makes the prior successful analysis stale');

  const drafted = await f.workflow.call('action', {...identity, id: snapshot.reminders[0].id,
    revision: snapshot.stateRevision, action: 'draft'});
  assert.match(drafted.draftText, /建议把 Work 当前流程更新为先确认 Python 版本/);
  assert.match(drafted.draftText, /sessionId=session-a，messageId=user-1/);
  assert.match(drafted.draftText, /SESSION\.md（SHA-256 [a-f0-9]{64}）/);
  assert.match(drafted.draftText, /当前流程：仍使用旧编译流程。/);
  assert.equal(drafted.snapshot.reminders[0].state, 'viewed');
  assert.ok(drafted.snapshot.stateRevision > snapshot.stateRevision);
});

test('已收集对话会在Work摘要失败时自动分析，并记录尝试与成功时间', async t => {
  let time = 1000;
  const f = await fixture(t, {source: {summaryReady: false, summaryStatus: 'error'}, clock: () => time});
  const identity = {root: '/work/summary-failed'};
  const initial = await f.workflow.call('status', identity);
  assert.equal(initial.snapshot.reminders.length, 0);
  await until(() => f.calls.length === 1);
  await f.workflow.queue;
  const completed = (await f.workflow.call('status', identity)).snapshot;
  assert.equal(completed.reminders.length, 1);
  assert.equal(completed.status, 'idle');
  assert.equal(completed.lastAttemptAt, 1000);
  assert.equal(completed.lastAttemptSourceRevision, 1);
  assert.equal(completed.lastSuccessAt, 1000);
  assert.equal(completed.lastSuccessSourceRevision, 1);
  assert.equal(f.calls.length, 1, 'same evidence and configuration do not schedule a duplicate request');

  time = 2000;
  f.workflow.agent.run = async () => ({text: JSON.stringify({reminders: []}), finishReason: 'stop'});
  const noReminder = await f.workflow.refresh(identity, {force: true});
  assert.equal(noReminder.reminders.filter(item => item.active).length, 0);
  assert.equal(noReminder.lastAttemptAt, 2000);
  assert.equal(noReminder.lastSuccessAt, 2000, 'a valid empty result counts as a successful check');
  assert.equal(noReminder.lastSuccessSourceRevision, 1);
});

test('升级到 evidence-v2 后会对旧版失败分析自动重试一次', async t => {
  const f = await fixture(t);
  const input = {root: '/work/evidence-v2-upgrade'};
  const identity = f.workflow.identity(input);
  const current = await f.workflow.getCurrent(identity);
  const {state} = await f.workflow.load(identity);
  const legacyContextFingerprint = digest(JSON.stringify([
    identity.workId, current.sourceRevision, current.record.hash || 'unavailable',
  ]));
  const configFingerprint = f.workflow.configFingerprint();
  state.contextFingerprint = legacyContextFingerprint;
  state.status = 'error';
  state.error = '流程提醒缺少可核对的对话或 SESSION.md 原文，未保存建议';
  state.lastAttemptFingerprint = digest(JSON.stringify([legacyContextFingerprint, configFingerprint]));
  state.lastSuccessFingerprint = '';
  await f.workflow.persist(identity, state);

  await f.workflow.call('status', input);
  await until(() => f.calls.length === 1);
  await f.workflow.queue;
  const recovered = (await f.workflow.call('status', input)).snapshot;
  assert.equal(recovered.status, 'idle');
  assert.equal(recovered.currentAnalysis, true);
  assert.equal(f.calls.length, 1, 'the upgraded request fingerprint prevents repeat scheduling after its successful retry');
});

test('failed workflow analysis records its attempt without advancing successful-check time', async t => {
  let time = 1000;
  const f = await fixture(t, {clock: () => time, run: async () => {
    throw Object.assign(Error('raw provider details must stay private'), {publicMessage: '辅助模型请求超时或已取消'});
  }});
  const identity = {root: '/work/workflow-error-time'};
  const failed = await f.workflow.refresh(identity);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, '辅助模型请求超时或已取消');
  assert.equal(failed.lastAttemptAt, 1000);
  assert.equal(failed.lastSuccessAt, 0);
  assert.equal(failed.lastAttemptSourceRevision, 1);
  assert.equal(failed.lastSuccessSourceRevision, 0);
  time = 2000;
  f.workflow.agent.run = async () => ({text: JSON.stringify({reminders: []}), finishReason: 'stop'});
  const recovered = await f.workflow.refresh(identity, {force: true});
  assert.equal(recovered.lastAttemptAt, 2000);
  assert.equal(recovered.lastSuccessAt, 2000);
  assert.equal(recovered.lastSuccessSourceRevision, 1);
});

test('unclassified workflow model errors use generic public text', async t => {
  const f = await fixture(t, {run: async () => { throw Error('raw provider response contains a credential'); }});
  const failed = await f.workflow.refresh({root: '/work/workflow-private-error'});
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'Work 流程提醒暂未生成');
  assert.equal(failed.error.includes('credential'), false);
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
    return {text: JSON.stringify({reminders: [makeReminder()]}), finishReason: 'stop'};
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

test('重复对话通知只安排一次，来源变化会取消旧结果并在无摘要时重新分析', async t => {
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
    return {text: JSON.stringify({reminders: [makeReminder()]}), finishReason: 'stop'};
  }, debounceMs: 10});
  const identity = {root: '/work/observe'};
  const summaryFailure = {root: identity.root, enabled: true, sourceRevision: 1, summaryRevision: 0, status: 'error', summary: null};
  f.workflow.observe(summaryFailure);
  f.workflow.observe(summaryFailure);
  await start;
  f.current.sourceRevision = 2;
  f.current.sources = makeSources(2, '我决定改用 Python 3.12，并停止沿用旧编译流程。');
  f.workflow.observe({...summaryFailure, sourceRevision: 2});
  release();
  await until(() => f.calls.length === 2);
  await f.workflow.queue;
  const state = f.workflow.states.get(f.assistant.identity(identity).workId);
  assert.equal(state.currentReminderIds.length, 1, 'new source revision is analyzed automatically');
  assert.equal(state.reminders[0].sources[0].quote, '我决定改用 Python 3.12，并停止沿用旧编译流程。',
    'the cancelled old result does not overwrite the newer reminder');
  const updated = (await f.workflow.call('status', identity)).snapshot;
  assert.equal(updated.lastSuccessSourceRevision, 2, 'new source revision is analyzed without a Work summary');
  assert.equal(f.calls.length, 2, '相同对话修订通知只触发一次，后续新来源自动触发一次');
});

test('同 Work 路径的本机与不同远端身份隔离，多个 Work 的模型请求仍串行', async t => {
  let active = 0;
  let maxActive = 0;
  const f = await fixture(t, {run: async ({calls}) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    active--;
    return {text: JSON.stringify({reminders: [makeReminder()]}), finishReason: 'stop'};
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
