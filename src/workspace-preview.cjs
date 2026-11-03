const fs = require('node:fs/promises');
const path = require('node:path');
const {within, previewKind, IMAGE_MIME} = require('./file-browser.cjs');

// The desktop reads WSL through a UNC path. A Linux absolute reference must be
// rebased against the logical Work root before Windows path resolution.
function previewReference(reference, logicalRoot) {
  if (typeof reference !== 'string' || !reference || reference.length > 4096 || /[\0\r\n]/.test(reference)) throw Error('无效文件路径');
  if (/^[a-z][a-z\d+.-]*:/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)) throw Error('此链接不是工作区文件路径');
  if (logicalRoot?.startsWith('/') && reference.startsWith('/') && !reference.startsWith('//')) {
    const relative = path.posix.relative(logicalRoot, reference);
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) throw Error('只能预览当前工作区内的文件');
    return relative || '.';
  }
  return reference;
}

async function readWorkspacePreview(workPath, reference, basePath, logicalRoot) {
  try {
    const root = await fs.realpath(workPath);
    const base = basePath ? path.resolve(root, previewReference(basePath, logicalRoot)) : null;
    if (base && !within(root, base)) throw Error('只能预览当前工作区内的文件');
    const source = previewReference(reference, logicalRoot);
    // A rebased Linux absolute path is root-relative, never document-relative.
    const absoluteLinux = logicalRoot?.startsWith('/') && reference.startsWith('/') && !reference.startsWith('//');
    const candidate = path.resolve(base && !absoluteLinux ? path.dirname(base) : root, source);
    if (!within(root, candidate)) throw Error('只能预览当前工作区内的文件');
    const selected = await fs.realpath(candidate);
    if (!within(root, selected)) throw Error('只能预览当前工作区内的文件');
    const kind = previewKind(selected), mime = IMAGE_MIME[path.extname(selected).toLowerCase()];
    if (kind === 'file' || (kind === 'image' && !mime)) throw Error('此文件类型不支持预览');
    const limit = kind === 'image' ? 10 * 1024 * 1024 : 1024 * 1024;
    const handle = await fs.open(selected, 'r');
    let data;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw Error('请选择普通文件');
      const tooLarge = () => Error(`${kind === 'image' ? '图片' : '文件'}超过预览上限（${limit / 1024 / 1024} MiB）`);
      if (stat.size > limit) throw tooLarge();
      const chunks = []; let total = 0;
      while (total <= limit) {
        const chunk = Buffer.alloc(Math.min(65536, limit + 1 - total));
        const {bytesRead} = await handle.read(chunk, 0, chunk.length, total);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > limit) throw tooLarge();
        chunks.push(chunk.subarray(0, bytesRead));
      }
      data = Buffer.concat(chunks, total);
    } finally { await handle.close(); }
    const result = {kind, name: path.basename(selected), path: path.relative(root, selected).split(path.sep).join('/')};
    if (kind === 'image') return {...result, dataUrl: `data:${mime};base64,${data.toString('base64')}`};
    if (data.includes(0)) throw Error('该文件包含二进制数据，无法作为文本预览');
    return {...result, content: data.toString('utf8')};
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw Error('文件不存在或已移动');
    if (error.code === 'EACCES' || error.code === 'EPERM') throw Error('没有权限读取此文件');
    throw error;
  }
}

module.exports = {readWorkspacePreview, previewReference};
