const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {resolveDataRoot} = require('../src/data-root.cjs');
test('uses the physical marker location when Windows AppData parent paths are virtualized', () => {
  const logical = path.join(os.tmpdir(), 'logical-appdata'), physical = path.join(os.tmpdir(), 'package-cache', 'omp-cindy');
  let realpathArgument;
  const io = {mkdirSync() {}, writeFileSync() {}, lstatSync: () => ({isFile: () => true, isSymbolicLink: () => false}), readFileSync: () => '{"application":"omp-cindy","version":1}', realpathSync: Object.assign(p => p, {native: p => { realpathArgument = p; return path.join(physical, '.omp-cindy-data-root'); }})};
  assert.equal(resolveDataRoot(logical, io), physical);
  assert.equal(realpathArgument, path.join(logical, '.omp-cindy-data-root'));
});
test('keeps an ordinary root stable across launches and preserves existing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-data-root-'));
  fs.writeFileSync(path.join(root, 'existing'), 'keep');
  assert.equal(resolveDataRoot(root), fs.realpathSync(root));
  assert.equal(resolveDataRoot(root), fs.realpathSync(root));
  assert.equal(fs.readFileSync(path.join(root, 'existing'), 'utf8'), 'keep');
});
