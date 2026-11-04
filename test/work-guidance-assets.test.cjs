const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {KnowledgeLibrary} = require('../src/knowledge-library.cjs');
const {createWorkKnowledge} = require('../src/work-knowledge.cjs');
const {WorkGuidanceAssets} = require('../src/work-guidance-assets.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucyna-guidance-assets-'));
  const workPath = path.join(directory, 'work');
  await fs.mkdir(path.join(workPath, 'notes'), {recursive: true});
  const source = path.join(workPath, 'notes', 'result.md');
  await fs.writeFile(source, '# 构建记录\n\n先确认工具链版本，再执行构建。');
  const identity = {root: '/work/project'};
  const store = new KnowledgeLibrary(path.join(directory, 'library'));
  t.after(async () => { store.close(); await fs.rm(directory, {recursive: true, force: true}); });
  const details = async () => {
    try {
      const stat = await fs.stat(source);
      return {assets: [{path: 'notes/result.md', title: '构建记录', name: 'result.md', kind: 'note',
        modifiedAt: stat.mtime.toISOString(), size: stat.size},
      {path: 'notes/.env.local', title: '敏感配置', kind: 'note'}]};
    } catch (error) { if (error.code === 'ENOENT') return {assets: []}; throw error; }
  };
  const resolveWork = async value => { if (value.root !== identity.root) throw Error('Unknown Work'); };
  const capture = createWorkKnowledge({listWorks: async () => [identity], details, wslUnc: () => workPath, distro: 'fixture'});
  const calls = [];
  const knowledge = async (operation, input) => {
    calls.push(operation);
    if (operation === 'workAssetList') return store.listWork(input.root);
    if (operation === 'workAssetCapture') return store.captureWork(await capture.capture(input.root, input.path));
    if (operation === 'workAssetRead') return store.readWork(input.root, input.id);
    throw Error('Unexpected operation');
  };
  const provider = new WorkGuidanceAssets({resolveWork, details, knowledge});
  return {provider, store, source, calls, identity};
}

test('recommendation catalog is metadata-only; explicit selection freezes a Work-scoped snapshot', async t => {
  const {provider, store, source, calls, identity} = await fixture(t);
  const listed = await provider.list(identity);
  assert.equal(listed.assets.length, 1);
  assert.deepEqual(calls, ['workAssetList']);
  assert.ok(!JSON.stringify(listed).includes('先确认工具链'));
  const chosen = await provider.read(identity, listed.assets[0]);
  assert.match(chosen.content, /先确认工具链/);
  assert.ok(chosen.sourceHash && chosen.snapshotVersion);
  assert.equal(chosen.version, listed.assets[0].version);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM documents').get().n, 0);
  await fs.unlink(source);
  const after = await provider.catalog(identity, {refresh: true});
  assert.equal(after.assets[0].origin, 'saved');
  assert.equal((await provider.read(identity, after.assets[0])).content, chosen.content);
  await assert.rejects(provider.read({root: '/work/other'}, after.assets[0]), /Unknown Work/);
});

test('changed versions and new credentials cannot enter a recommended material preview', async t => {
  const {provider, source, identity} = await fixture(t);
  const listed = await provider.list(identity);
  await fs.appendFile(source, '\n新增约束：保留原始日志。');
  await assert.rejects(provider.read(identity, listed.assets[0]), /已变化/);
  await fs.writeFile(source, 'api_key: FakeButRealLooking!1234');
  const refreshed = await provider.catalog(identity, {refresh: true});
  await assert.rejects(provider.read(identity, refreshed.assets[0]), /凭据|脱敏/);
});

test('remote recommendations do not start local catalog or knowledge reads', async () => {
  let calls = 0;
  const provider = new WorkGuidanceAssets({resolveWork: async () => {},
    details: async () => { calls++; }, knowledge: async () => { calls++; }});
  const result = await provider.list({root: '/work/project', hostId: 'remote'});
  assert.equal(result.available, false);
  assert.deepEqual(result.assets, []);
  assert.equal(calls, 0);
});
