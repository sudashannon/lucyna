const fs = require('node:fs');
const path = require('node:path');

// Packaged Windows parents can virtualize AppData writes while realpath(parent)
// still returns the merged logical directory. Anchor to an actual owned file so
// child processes, Electron and containment checks all use the same physical root.
function resolveDataRoot(directory, io = fs) {
  const root = path.resolve(directory);
  io.mkdirSync(root, {recursive: true});
  const marker = path.join(root, '.omp-cindy-data-root');
  try { io.writeFileSync(marker, '{"application":"omp-cindy","version":1}\n', {flag: 'wx'}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = io.lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('应用数据目录标记不是普通文件');
  const data = JSON.parse(io.readFileSync(marker, 'utf8'));
  if (data.application !== 'omp-cindy' || data.version !== 1) throw new Error('应用数据目录标记无效');
  // The JS realpath implementation reconstructs the logical path; only the
  // native API resolves Windows package virtualization (as fs.promises does).
  return path.dirname(io.realpathSync.native(marker));
}
module.exports = {resolveDataRoot};
