const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {WorkAssistantAccess, journalIdentity, readAssistantJournal} = require('../src/work-assistant-sources.cjs');
const {WorkAssistant} = require('../src/work-assistant.cjs');

async function sourceFixture(t, {root='/work/project', hostId, sessionFile='C:\\Work\\project\\sessions\\conversation.jsonl', history={managed:[],sessions:[]}, connections=[]}={}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucyna-assistant-source-resolution-'));
  const assistant = new WorkAssistant({directory, localScope:'source-resolution-fixture', agent:{run:async()=>{throw Error('unexpected model call');}}, config:async()=>null});
  t.after(async()=>{await assistant.close(); await fs.rm(directory, {recursive:true, force:true});});
  const identity = {root, ...(hostId ? {hostId} : {})};
  const source = {sessionId: journalIdentity(sessionFile), messageId:'native-message-42'};
  await assistant.ingest({...identity, ...source, title:'重复标题', messages:[{id:source.messageId,role:'user',timestamp:1234,content:'用户确认从摘要出处直接跳到原消息。'}]}, {schedule:false});
  const workAccess = new WorkAssistantAccess({
    assistant,
    resolveWork:async target=>{if(target.root!==root||(target.hostId||'')!==(hostId||''))throw Error('Work scope mismatch');},
    listHistory:async target=>{if(target.root!==root||(target.hostId||'')!==(hostId||''))throw Error('history scope mismatch');return history;},
    readHistory:async()=>{throw Error('resolver must not read journal contents');},
    connections:async()=>connections,
  });
  return {assistant, workAccess, identity, source};
}

async function journal(t, entries) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lucyna-assistant-sources-'));
  t.after(() => fs.rm(folder, {recursive: true, force: true}));
  const file = path.join(folder, 'session.jsonl');
  await fs.writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return file;
}

test('history reads the current parent chain and validates the Work and native identity', async t => {
  const file = await journal(t, [
    {type: 'session', id: 'native', cwd: '/work/project'},
    {type: 'message', id: 'one', parentId: null, message: {role: 'user', content: 'Inspect this issue'}},
    {type: 'message', id: 'discarded', parentId: 'one', message: {role: 'assistant', content: 'Abandoned branch'}},
    {type: 'message', id: 'current', parentId: 'one', message: {role: 'assistant', content: 'Current result'}},
  ]);
  const messages = await readAssistantJournal({file, root: '/work', nativeId: 'native'});
  assert.deepEqual(messages.map(message => message.content), ['Inspect this issue', 'Current result']);
  await assert.rejects(readAssistantJournal({file, root: '/another', nativeId: 'native'}), /工作目录/);
  await assert.rejects(readAssistantJournal({file, root: '/work', nativeId: 'other'}), /身份/);
  await assert.rejects(readAssistantJournal({file, root: '/work', limit: 10}), /读取范围/);
});

test('partial last append is tolerated but broken ancestry is not presented as a complete history', async t => {
  const file = await journal(t, [
    {type: 'session', id: 'native', cwd: '/work'},
    {type: 'message', id: 'one', parentId: null, message: {role: 'user', content: 'Hello'}},
  ]);
  await fs.appendFile(file, '{"type":"message"');
  assert.equal((await readAssistantJournal({file, root: '/work'})).length, 1);
  await fs.writeFile(file, [
    {type: 'session', id: 'native', cwd: '/work'},
    {type: 'message', id: 'one', parentId: 'missing', message: {role: 'user', content: 'Hello'}},
  ].map(entry => JSON.stringify(entry)).join('\n'));
  await assert.rejects(readAssistantJournal({file, root: '/work'}), /不完整/);
});

test('same Linux journal keeps its identity through UNC and Windows paths normalize case', () => {
  const runtime = require('../src/runtime-config.cjs');
  assert.equal(journalIdentity('/home/user/session.jsonl'), journalIdentity('\\\\wsl.localhost\\' + runtime.distro + '\\home\\user\\session.jsonl'));
  assert.equal(journalIdentity('C:\\Logs\\Session.jsonl'), journalIdentity('c:/logs/session.jsonl'));
  assert.equal(journalIdentity('/mnt/c/Logs/Session.jsonl'), journalIdentity('C:\\Logs\\Session.jsonl'));
  assert.notEqual(journalIdentity('/home/user/A.jsonl'), journalIdentity('/home/user/a.jsonl'));
});

test('history access validates scope, deduplicates sources and retains partial coverage', async () => {
  const calls = [], coverage = [];
  const assistant = {
    ingest: async (value, options) => { assert.equal(options.schedule, false); calls.push(value); },
    setHistoryCoverage: async (identity, value) => coverage.push(value),
    view: async identity => identity,
  };
  const access = new WorkAssistantAccess({
    assistant,
    resolveWork: async identity => { if (identity.root !== '/work') throw Error('Invalid root'); },
    listHistory: async () => ({managed: [{sessionFile: 'C:/good.jsonl', title: 'Good'}], sessions: [{path: 'c:/good.jsonl'}, {path: 'C:/bad.jsonl'}]}),
    readHistory: async entry => { if (entry.path?.includes('bad')) throw Error('Unavailable'); return [{role: 'user', content: 'Inspect'}]; },
  });
  await access.call('history', {root: '/work'});
  assert.equal(calls.length, 1);
  assert.equal(coverage[0].available, 2);
  assert.equal(coverage[0].loaded, 1);
  assert.equal(coverage[0].skipped, 1);
  await assert.rejects(access.call('history', {root: '/elsewhere'}), /Invalid root/);
  await assert.rejects(access.call('history', {root: '/work', file: 'C:/secret'}), /无效/);
  await assert.rejects(access.call('history', {root: '/work', hostId: 'remote'}), /远端/);
});

test('history ingestion finishes before deletion removes its derived text', async () => {
  const events = [];
  let startRead, finishRead, deleted = false;
  const reading = new Promise(resolve => { startRead = resolve; });
  const messages = new Promise(resolve => { finishRead = resolve; });
  const access = new WorkAssistantAccess({
    assistant: {
      ingest: async () => events.push('ingested'),
      setHistoryCoverage: async () => {},
      view: async () => ({}),
    },
    resolveWork: async () => {},
    listHistory: async () => ({sessions: deleted ? [] : [{path: 'C:/session.jsonl'}]}),
    readHistory: async () => { startRead(); return messages; },
  });
  const history = access.call('history', {root: '/work'});
  await reading;
  const deletion = access.exclusive({root: '/work'}, async () => {
    events.push('forgotten');
    deleted = true;
  });
  finishRead([{role: 'user', content: 'A session being removed'}]);
  await Promise.all([history, deletion]);
  await access.call('history', {root: '/work'});
  assert.deepEqual(events, ['ingested', 'forgotten']);
  await assert.rejects(access.exclusive({root: '/work'}, () => { throw Error('Failed removal'); }));
  assert.equal(await access.exclusive({root: '/work'}, () => 'still usable'), 'still usable');
});

test('source resolver returns the exact live same-Work journal and native message ID', async t => {
  const {workAccess,identity,source}=await sourceFixture(t,{connections:[
    {id:'client-live',root:'/another/work',sessionFile:'C:\\Work\\project\\sessions\\conversation.jsonl'},
    {id:'client-live',root:'/work/project',hostId:'other-host',sessionFile:'C:\\Work\\project\\sessions\\conversation.jsonl'},
    {id:'client-right',root:'/work/project',sessionFile:'c:/work/project/sessions/conversation.jsonl'},
  ]});
  const result=await workAccess.resolveSource({...identity,...source});
  assert.equal(result.clientSessionId,'client-right');
  assert.equal(result.sessionId,source.sessionId);
  assert.equal(result.messageId,source.messageId);
  assert.equal(result.nativeMessageId,source.messageId);
  assert.equal(result.text,'用户确认从摘要出处直接跳到原消息。');
  assert.equal(result.at,1234);
  assert.ok(!Object.hasOwn(result,'entry'));
});

test('source resolver returns a journal entry only for its canonical Work history identity', async t => {
  const entry={title:'重复标题',sessionFile:'c:/WORK/project/sessions/conversation.jsonl',runtime:'windows',agentDir:'C:/OMP'};
  const {workAccess,identity,source}=await sourceFixture(t,{history:{managed:[entry],sessions:[{...entry,sessionFile:'C:/work/project/sessions/unrelated.jsonl'}]}});
  const result=await workAccess.resolveSource({...identity,...source});
  assert.equal(result.entry,entry);
  assert.equal(result.clientSessionId,undefined);
});

test('source resolver supports a legacy native session ID only within validated history', async t => {
  const entry={id:'legacy-native-session',title:'重复标题',sessionFile:'C:/Work/project/sessions/legacy.jsonl',runtime:'windows',agentDir:'C:/OMP'};
  const {assistant,workAccess,identity}=await sourceFixture(t,{history:{managed:[entry],sessions:[]}});
  const legacySource={sessionId:'legacy-native-session',messageId:'legacy-message'};
  await assistant.ingest({...identity,...legacySource,messages:[{id:legacySource.messageId,role:'assistant',content:'旧版身份只允许通过当前 Work 的历史目录匹配。'}]}, {schedule:false});
  const result=await workAccess.resolveSource({...identity,...legacySource});
  assert.equal(result.entry,entry);
  assert.equal(result.nativeMessageId,legacySource.messageId);
});

test('source resolver rejects forged identities, deleted sources and unrelated hosts or roots', async t => {
  const {workAccess,identity,source}=await sourceFixture(t,{history:{managed:[
    {id:'foreign',root:'/another/work',title:'重复标题',sessionFile:'C:/Work/project/sessions/conversation.jsonl'},
    {id:'foreign-host',hostId:'host-b',title:'重复标题',sessionFile:'C:/Work/project/sessions/conversation.jsonl'},
  ],sessions:[]}});
  await assert.rejects(workAccess.resolveSource({...identity,...source,root:'/another/work'}),/Work scope/);
  await assert.rejects(workAccess.resolveSource({...identity,...source,hostId:'host-b'}),/Work scope/);
  await assert.rejects(workAccess.resolveSource({...identity,...source,sessionId:'guessed-session'}),/失效/);
  await assert.rejects(workAccess.resolveSource({...identity,...source,messageId:'guessed-message'}),/失效/);
  await assert.rejects(workAccess.resolveSource({...identity,...source,sessionFile:'C:/private.jsonl'}),/无效/);
  await assert.rejects(workAccess.resolveSource({...identity,...source}),/历史中移除/);
});

test('source resolver accepts a live remote journal only for the same host and root', async t => {
  const journal='/home/user/remote.jsonl';
  const root='/home/user/work';
  const hostId='ssh-host-a';
  const {workAccess,identity,source}=await sourceFixture(t,{root,hostId,sessionFile:journal,connections:[
    {id:'wrong-root',hostId,root:'/home/user/other',sessionFile:journal},
    {id:'wrong-host',hostId:'ssh-host-b',root,sessionFile:journal},
    {id:'remote-client',hostId,root,sessionFile:journal,remoteSessionId:'remote-session'},
  ]});
  const result=await workAccess.resolveSource({...identity,...source});
  assert.equal(result.clientSessionId,'remote-client');
  assert.equal(result.hostId,hostId);
});
