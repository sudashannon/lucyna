const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {WorkAssistant} = require('../src/work-assistant.cjs');
const {WorkAssistantAccess} = require('../src/work-assistant-sources.cjs');
const {AuxiliaryAgent} = require('../src/auxiliary-agent.cjs');

for (const protocol of ['chat-completions', 'responses']) {
  test(`Work summary uses the real auxiliary SDK and durable sources through ${protocol}`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucyna-assistant-sdk-'));
    const requests = [];
    const server = http.createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const bytes of req) raw += bytes;
        const body = JSON.parse(raw);
        requests.push(body);
        const content = (body.messages || body.input).at(-1).content;
        const prompt = typeof content === 'string' ? content : content.map(part => part.text || '').join('');
        const input = JSON.parse(prompt);
        const citations = input.messages.map(message => ({sessionId: message.sessionId, messageId: message.messageId, role: message.role, quote: message.text}));
        const summary = {overview: {text: '两个会话共同推进 Work 协作摘要。', sources: citations}, goals: [], decisions: [], progress: [], openQuestions: [], nextSteps: []};
        const text = JSON.stringify(summary);
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
    const options = {directory, localScope: 'isolated-fixture', debounceMs: 60000, agent: new AuxiliaryAgent(),
      config: async () => ({protocol, baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-fixture', apiKey: 'local-fixture-secret', timeoutSeconds: 5})};
    const assistant = new WorkAssistant(options);
    t.after(async () => { await assistant.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, {recursive: true, force: true}); });
    const access = new WorkAssistantAccess({assistant, resolveWork: async ({root}) => assert.equal(root, '/work/demo')});
    const identity = {root: '/work/demo'};
    assert.equal((await access.call('configure', {...identity, enabled: false})).enabled, false);
    await assistant.ingest({...identity, sessionId: 'first', title: '目标讨论', messages: [{role: 'user', timestamp: 1, content: '请为整个 Work 汇总多个会话中的工作进展。'}]});
    await assistant.ingest({...identity, sessionId: 'second', title: '实现讨论', messages: [{role: 'assistant', timestamp: 2, content: '已经梳理会话来源，下一步接入摘要到草稿。'}]});
    assert.equal(requests.length, 0);
    await access.call('configure', {...identity, enabled: true});
    const pending = await assistant.view(identity);
    await assistant.summarize(pending.workId);
    const view = await assistant.view(identity);
    assert.equal(view.status, 'idle', view.error);
    assert.equal(view.summary.overview.sources.length, 2);
    assert.equal(view.coverage.sessions, 2);
    assert.equal(view.usedTokens, 150);
    assert.equal(requests.length, 1);
    assert.ok(!requests[0].tools?.length);
    if (protocol === 'responses') assert.equal(requests[0].store, false);
    await assistant.summarize(view.workId);
    assert.equal(requests.length, 1);
    await assistant.close();
    const restored = new WorkAssistant(options);
    try {
      assert.deepEqual((await restored.view(identity)).summary, view.summary);
      for (const file of await fs.readdir(directory)) assert.ok(!(await fs.readFile(path.join(directory, file), 'utf8')).includes('local-fixture-secret'));
    } finally { await restored.close(); }
  });
}
