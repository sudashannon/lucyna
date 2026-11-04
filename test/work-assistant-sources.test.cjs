const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {WorkAssistantAccess, journalIdentity, readAssistantJournal} = require('../src/work-assistant-sources.cjs');

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
