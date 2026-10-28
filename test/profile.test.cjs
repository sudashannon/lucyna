const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ensureOwnedAgentDir } = require('../src/profile.cjs');

test('agent configuration remains within its dedicated application data directory', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-profile-test-'));
  const root = path.join(temp, 'app');
  const valid = await ensureOwnedAgentDir(root, path.join(root, 'agent'));
  assert.equal(path.basename(valid), 'agent');
  await assert.rejects(() => ensureOwnedAgentDir(root, path.join(temp, 'outside')));
  const target = path.join(temp, 'target');
  await fs.mkdir(target);
  const link = path.join(root, 'linked-agent');
  try { await fs.symlink(target, link, 'junction'); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') return; throw error; }
  await assert.rejects(() => ensureOwnedAgentDir(root, link));
});
