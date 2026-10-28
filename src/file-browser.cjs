const fs = require('node:fs/promises');
const path = require('node:path');
const IMAGE_MIME = {'.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.bmp':'image/bmp'};
const TEXT_EXTENSIONS = new Set(['.txt','.log','.json','.jsonl','.yaml','.yml','.toml','.xml','.csv','.ini','.cfg','.conf','.py','.js','.jsx','.ts','.tsx','.cjs','.mjs','.css','.scss','.html','.htm','.sh','.bash','.zsh','.ps1','.bat','.cmd','.c','.cc','.cpp','.h','.hpp','.rs','.go','.java','.kt','.swift','.sql','.vue','.svelte','.cmake','.gitignore','.gitattributes','.editorconfig']);
function previewKind(name) {
  const extension = path.extname(name).toLowerCase();
  if (['.md','.markdown'].includes(extension)) return 'markdown';
  if (IMAGE_MIME[extension]) return 'image';
  if (TEXT_EXTENSIONS.has(extension) || ['dockerfile','makefile','cmakelists.txt','license','.gitignore','.gitattributes','.editorconfig'].includes(path.basename(name).toLowerCase())) return 'text';
  return 'file';
}
function within(root, target) {const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);}
async function listDirectory(workPath, directory = '', options = {}) {
  if (typeof directory !== 'string' || directory.includes('\0') || directory.length > 4096) throw Error('无效目录路径');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('无效列表选项');
  const offset = options.offset ?? 0, query = options.query ?? '';
  if (!Number.isSafeInteger(offset) || offset < 0 || typeof query !== 'string' || query.length > 200) throw Error('无效筛选条件');
  const root = await fs.realpath(workPath), candidate = path.resolve(root, directory);
  if (!within(root, candidate)) throw Error('只能浏览当前 work 根目录中的文件');
  const target = await fs.realpath(candidate);
  if (!within(root, target)) throw Error('只能浏览当前 work 根目录中的文件');
  const term = query.trim().toLocaleLowerCase();
  const entries = (await fs.readdir(target, {withFileTypes:true})).filter(e => (options.showHidden === true || !e.name.startsWith('.')) && (!term || e.name.toLocaleLowerCase().includes(term)))
    .sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN', {numeric:true}));
  const page = await Promise.all(entries.slice(offset, offset + 200).map(async e => {
    const fullPath = path.join(target,e.name);
    let kind = e.isDirectory() ? 'directory' : e.isFile() ? previewKind(e.name) : 'file', reason;
    if (e.isSymbolicLink()) {
      try {const real = await fs.realpath(fullPath); if (!within(root,real)) {kind='blocked';reason='链接目标在当前工作区之外';} else {const stat=await fs.stat(real);kind=stat.isDirectory()?'directory':stat.isFile()?previewKind(e.name):'file';}}
      catch {kind='blocked';reason='链接目标无法读取';}
    }
    return {name:e.name,path:fullPath,kind,link:e.isSymbolicLink(),reason};
  }));
  return {directory:path.relative(root,target).split(path.sep).join('/'),entries:page,total:entries.length,nextOffset:offset+page.length<entries.length?offset+page.length:null};
}
module.exports = {listDirectory, previewKind, IMAGE_MIME, within};
