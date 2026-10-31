const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const {digest} = require('../tools/build-host-bundle.cjs');
const {deployFrozen, loadArtifact} = require('../src/hosts/ssh-frozen.cjs');
const target = {destination: 'fixture'};
const frame = value => 'LUCYNA_HOST_V1 '+JSON.stringify(value)+'\n';
async function artifact(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-artifact-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const bytes = Buffer.from('opaque archive only consumed by the mocked remote');
  const index = {version: 2, format: 'pyinstaller-onedir', release: 'a'.repeat(64),
    target: {os: 'Linux', arch: 'x86_64', glibcMin: '2.35'}, archive: 'host-linux-x86_64.tar.gz',
    bytes: bytes.length, sha256: digest(bytes)};
  const file = path.join(dir, 'index.json');
  await fs.writeFile(file, JSON.stringify(index)); await fs.writeFile(path.join(dir, index.archive), bytes);
  return {file, index, dir};
}
test('frozen deployment needs no Python and verifies the independent handshake', async t => {
  const {file, index} = await artifact(t); let calls = 0;
  const installed = {ok: true, mode: 'connection', format: 'frozen', release: index.release,
    installationId: 'fixture', entry: '/home/test/host', state: '/home/test/state'};
  const execute = async (config, args, options) => {
    calls++;
    assert.equal(args.join(' ').includes('python'), false);
    if (calls === 1) return frame({ok: true, platform: 'Linux', arch: 'x86_64', glibc: '2.35'});
    if (calls === 2) { assert.equal(digest(options.input), index.sha256); return frame(installed); }
    assert.deepEqual(args, [installed.entry, 'stdio', '--state', installed.state]);
    return frame({ok: true, id: 'deployment-health', data: {release: index.release, installationId: 'fixture', protocolVersion: 1}});
  };
  assert.equal((await deployFrozen(target, file, {mode: 'connection', execute})).hello.installationId, 'fixture');
  assert.equal(calls, 3);
});
test('frozen artifact corruption is detected before making an SSH connection', async t => {
  const {file, dir, index} = await artifact(t);
  await fs.writeFile(path.join(dir, index.archive), Buffer.alloc(index.bytes));
  await assert.rejects(loadArtifact(file), /摘要不匹配/);
});
test('architecture and glibc mismatches stop before upload', async t => {
  const {file} = await artifact(t);
  for (const probe of [{arch: 'aarch64', glibc: '2.35'}, {arch: 'x86_64', glibc: '2.31'}]) {
    let calls = 0;
    await assert.rejects(deployFrozen(target, file, {execute: async () => {
      calls++; return frame({ok: true, platform: 'Linux', ...probe});
    }}), {code: 'artifact_platform_mismatch'});
    assert.equal(calls, 1);
  }
});
test('archive index cannot escape its package directory', async t => {
  const {file, index} = await artifact(t);
  await fs.writeFile(file, JSON.stringify({...index, archive: '../elsewhere.tar.gz'}));
  await assert.rejects(loadArtifact(file), /无效/);
});
