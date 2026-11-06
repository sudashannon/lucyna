const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {AuxiliaryAgent} = require('../src/auxiliary-agent.cjs');
const {WorkAssistant} = require('../src/work-assistant.cjs');
const {WorkGuidance} = require('../src/work-guidance.cjs');
const {WorkWorkflow} = require('../src/work-workflow.cjs');

for (const protocol of ['chat-completions', 'responses']) {
  test(`draft guidance and workflow reminders use the native auxiliary SDK through ${protocol}`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucyna-intelligence-sdk-'));
    const requests = [];
    const server = http.createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const bytes of req) raw += bytes;
        const body = JSON.parse(raw);
        requests.push(body);
        const message = (body.messages || body.input).at(-1).content;
        const input = JSON.parse(typeof message === 'string' ? message : message.map(part => part.text || '').join(''));
        const source = (input.sources || input.conversations).find(row => row.role === 'user');
        const workflowResult = input.sources ? {
          completions: [{text: '，先整理构建日志并保留未决问题。', reason: '沿用此前确认的工作顺序', basis: 'inferred', sources: [{sessionId: source.sessionId, messageId: source.messageId, role: source.role, quote: source.text}]}],
          assets: [{id: input.assets[0].id, reason: '名称对应正在整理的构建日志'}],
        } : {
          reminders: [{kind: 'record_update', key: 'build-order', title: '核对 Work 的执行顺序',
            reason: '用户改变了执行顺序，而 Work 记录仍描述原顺序。', draftText: '请核对新决定，并将确认后的执行顺序更新到 SESSION.md。',
            sources: [{evidenceId: source.excerpts[0].evidenceId}, {evidenceId: input.record.excerpts[0].evidenceId}]}],
        };
        const text = JSON.stringify(workflowResult);
        res.setHeader('Content-Type', 'application/json');
        if (protocol === 'responses') {
          res.end(JSON.stringify({id: 'response', object: 'response', created_at: 1, model: 'local-fixture', status: 'completed',
            output: [{id: 'message', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text, annotations: []}]}],
            usage: {input_tokens: 100, output_tokens: 50, total_tokens: 150, output_tokens_details: {reasoning_tokens: 0}}}));
        } else {
          res.end(JSON.stringify({id: 'chat', object: 'chat.completion', created: 1, model: 'local-fixture',
            choices: [{index: 0, message: {role: 'assistant', content: text}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 100, completion_tokens: 50, total_tokens: 150}}));
        }
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({error: {message: error.message}})); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const agent = new AuxiliaryAgent();
    const config = async () => ({protocol, baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'local-fixture', apiKey: 'local-fixture-secret', timeoutSeconds: 5});
    const identity = {root: '/work/demo'};
    const assistant = new WorkAssistant({directory: path.join(directory, 'assistant'), agent, config});
    await assistant.ingest({...identity, sessionId: 'first', title: '新决定', messages: [
      {role: 'user', timestamp: 1, content: '改变原来的执行顺序：先整理构建日志，再修改代码，并保留未决问题。'},
    ]}, {schedule: false});
    await assistant.ingest({...identity, sessionId: 'second', title: '工作交接', messages: [
      {role: 'assistant', timestamp: 2, content: '下一次会话需要沿用已确认的构建日志整理顺序。'},
    ]}, {schedule: false});
    const asset = {id: 'build-log', path: 'notes/build.md', title: '构建日志', kind: 'note',
      version: 'catalog-v1', origin: 'work-file', snapshot: true};
    let materialReads = 0;
    const resolveWork = async value => assert.equal(value.root, identity.root);
    const guidance = new WorkGuidance({assistant, agent, config, resolveWork, minIntervalMs: 0,
      listAssets: async () => ({available: true, assets: [asset]}),
      readAsset: async (_identity, selected) => { materialReads++; assert.equal(selected.id, asset.id);
        return {...asset, ...identity, snapshotVersion: 'snapshot-v1', sourceHash: 'verified-source-hash',
          content: 'PRIVATE_BODY_ONLY_AFTER_SELECTION', truncated: false}; },
    });
    const workflow = new WorkWorkflow({directory: path.join(directory, 'workflow'), assistant, agent, config, resolveWork,
      readRecord: async () => ({available: true, path: 'SESSION.md', text: '当前计划：先修改代码，再整理构建日志。', version: 'record-v1'}),
    });
    t.after(async () => { await guidance.close(); await workflow.close(); await assistant.close(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); await fs.rm(directory, {recursive: true, force: true}); });

    const draft = '请继续处理 UNSENT_DRAFT_FIXTURE';
    const query = {...identity, sessionKey: 'draft-one', draft, caret: draft.length, revision: 1};
    const suggestion = await guidance.call('suggest', query);
    assert.equal(suggestion.status, 'complete', suggestion.error);
    assert.equal(suggestion.completions.length, 1);
    assert.equal(suggestion.assets.length, 1);
    assert.equal(materialReads, 0);
    assert.ok(!JSON.stringify(requests).includes('PRIVATE_BODY_ONLY_AFTER_SELECTION'));
    const cached = await guidance.call('suggest', {...query, revision: 2});
    assert.equal(cached.status, 'complete');
    assert.equal(cached.revision, 2);
    assert.notEqual(cached.requestId, suggestion.requestId);
    assert.equal(requests.length, 1, 'identical draft content should reuse a source-bound result');
    const material = await guidance.call('material', {...identity, sessionKey: 'draft-one', requestId: cached.requestId, assetId: asset.id});
    assert.equal(material.content, 'PRIVATE_BODY_ONLY_AFTER_SELECTION');
    assert.equal(material.snapshotVersion, 'snapshot-v1');
    assert.equal(materialReads, 1);

    const {snapshot} = await workflow.call('refresh', identity);
    assert.equal(snapshot.status, 'idle', snapshot.error);
    assert.equal(snapshot.reminders.length, 1);
    const prepared = await workflow.call('action', {...identity, id: snapshot.reminders[0].id,
      revision: snapshot.revision, action: 'draft'});
    assert.match(prepared.draftText, /SESSION\.md/);
    assert.equal(requests.length, 2);
    await assistant.ingest({...identity, sessionId: 'third', title: '新增构建讨论', messages: [
      {role: 'user', timestamp: 3, content: '再检查构建日志是否仍需整理。'},
    ]}, {schedule: false});
    const incremental = await workflow.refresh(identity, {force: false});
    assert.equal(incremental.analysis.mode, 'incremental');
    assert.equal(incremental.analysis.contextMessages, 1);
    assert.equal(requests.length, 3, 'one appended message makes one native model request');
    const incrementalInput = JSON.parse(typeof (requests.at(-1).messages || requests.at(-1).input).at(-1).content === 'string'
      ? (requests.at(-1).messages || requests.at(-1).input).at(-1).content
      : (requests.at(-1).messages || requests.at(-1).input).at(-1).content.map(part => part.text || '').join(''));
    assert.equal(incrementalInput.mode, 'incremental');
    assert.equal(incrementalInput.conversations.length, 1, 'the native model receives only the changed message on an ordinary delta');
    assert.match(incrementalInput.conversations[0].excerpts[0].text, /再检查构建日志/);
    for (const body of requests) {
      assert.ok(!body.tools?.length);
      if (protocol === 'responses') assert.equal(body.store, false);
    }
    for (const file of await fs.readdir(path.join(directory, 'workflow'))) {
      const stored = await fs.readFile(path.join(directory, 'workflow', file), 'utf8');
      assert.ok(!stored.includes('local-fixture-secret'));
      assert.ok(!stored.includes('UNSENT_DRAFT_FIXTURE'));
    }
  });
}
