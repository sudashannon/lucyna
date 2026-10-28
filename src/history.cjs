// Import OMP sessions through OMP's native transfer format into a unique,
// isolated Windows agent directory. Never resume or rewrite the source file.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const {wslArgs,toWslPath} = require('./client-settings.cjs');
const runtime=require('./runtime-config.cjs');

function execute(file, args, opts = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim())) : resolve({ stdout, stderr })));
}
function wslSource(source, agentDir = runtime.wslAgentDir) {
  const normalized = source.replaceAll('/', '\\');
  const linuxPath=runtime.fromWslUnc(normalized);
  const match = linuxPath ? [null,linuxPath.slice(1).replaceAll('/','\\')] : null;
  if (!match) {
    if (/^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(normalized)) throw new Error('仅支持已配置 WSL 发行版的 OMP session 目录');
    return null;
  }
  const parts = match[1].split('\\');
  if (parts.some(x => !x || x === '.' || x === '..' || x.includes('\0'))) throw new Error('无效的 WSL session 路径');
  const linux = '/' + parts.join('/');
  if (!linux.startsWith(agentDir.replace(/\/$/,'')+'/sessions/') || !linux.endsWith('.jsonl')) throw new Error('只支持选定 WSL OMP 配置目录中的 session 记录');
  return linux;
}
async function validateImportedSession(root, agentDir, sessionFile, expectedWorkRoot) {
  const realRoot = await fs.realpath(root);
  const realAgent = await fs.realpath(agentDir);
  const realSession = await fs.realpath(sessionFile);
  const relative = path.relative(realRoot, realAgent);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.basename(realAgent) !== 'agent') throw new Error('导入 session 的 agent 目录不属于客户端历史库');
  const sessionRel = path.relative(path.join(realAgent, 'sessions'), realSession);
  if (!sessionRel || sessionRel.startsWith('..') || path.isAbsolute(sessionRel) || !realSession.endsWith('.jsonl')) throw new Error('session 不属于导入的 agent 目录');
  if (expectedWorkRoot !== undefined) {
    const meta = JSON.parse(await fs.readFile(path.join(path.dirname(realAgent), 'import.json'), 'utf8'));
    if (meta.version !== 1 || meta.workRoot !== expectedWorkRoot || typeof meta.session !== 'string' || path.isAbsolute(meta.session) || path.resolve(realAgent, meta.session).toLowerCase() !== realSession.toLowerCase()) throw new Error('此历史会话属于其他工作根或导入记录已失效');
  }
  const header = await readSourceHeader(realSession);
  if (expectedWorkRoot && !belongsToWork(header.cwd, expectedWorkRoot)) throw new Error('历史会话工作目录与导入记录不一致');
  return { agentDir: realAgent, sessionFile: realSession, executionRoot: linuxCwd(header.cwd) };
}
async function readSourceHeader(source) {
  const handle = await fs.open(source, 'r');
  try {
    const buffer = Buffer.alloc(128 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    for (const line of text.split('\n').slice(0, 3)) { try { const value = JSON.parse(line); if (value.type === 'session' && typeof value.cwd === 'string') return value; } catch {} }
    throw new Error('无法读取 OMP session 头或工作目录');
  } finally { await handle.close(); }
}
// Read bounded journal windows for display metadata only. Native journals remain
// the source of truth; no parallel session database or source mutation is needed.
async function readSessionTitle(source) {
  const handle = await fs.open(source, 'r');
  try {
    const { size } = await handle.stat(), limit = 128 * 1024;
    const read = async (offset, length) => { const b = Buffer.alloc(length); const { bytesRead } = await handle.read(b, 0, length, offset); return b.subarray(0, bytesRead).toString('utf8'); };
    const head = await read(0, Math.min(size, limit));
    const tail = size > limit ? (await read(Math.max(limit, size - limit), Math.min(size - limit, limit))).split('\n').slice(1).join('\n') : '';
    let title = '', firstPrompt = '';
    for (const line of (head + '\n' + tail).split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'title' && typeof entry.title === 'string') title = entry.title;
        if (entry.type === 'session_info' && typeof entry.name === 'string') title = entry.name;
        if (!firstPrompt && entry.type === 'message' && entry.message?.role === 'user') {
          const content = entry.message.content;
          firstPrompt = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x.type === 'text').map(x => x.text || '').join(' ') : '';
        }
        if (!firstPrompt && entry.type === 'custom_message' && entry.customType === 'skill-prompt' && entry.attribution === 'user' && typeof entry.details?.name === 'string') {
          firstPrompt = typeof entry.details.prompt === 'string' ? entry.details.prompt : `/skill:${entry.details.name}${typeof entry.details.args === 'string' ? ' ' + entry.details.args : ''}`;
        }
      } catch { /* Partial lines and unfinished appends do not hide the session. */ }
    }
    return (title || firstPrompt).replace(/\s+/g, ' ').trim().slice(0, 160);
  } finally { await handle.close(); }
}
function linuxCwd(cwd) {
  if (typeof cwd !== 'string') return '';
  const linux = runtime.fromWslUnc(cwd) || cwd;
  return path.posix.normalize(linux);
}
function belongsToWork(cwd, workRoot) {
  if (typeof cwd !== 'string' || typeof workRoot !== 'string') return false;
  const normalized = linuxCwd(cwd);
  return normalized === workRoot || normalized.startsWith(workRoot + '/');
}
async function importedJournal(agentDir) {
  const sessions = path.join(agentDir, 'sessions');
  const found = [];
  for (const bucket of await fs.readdir(sessions, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    for (const file of await fs.readdir(path.join(sessions, bucket.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.jsonl')) found.push(path.join(sessions, bucket.name, file.name));
    }
  }
  if (found.length !== 1) throw new Error(`导入结果不明确（发现 ${found.length} 个主 session），已保留原件和导入目录`);
  return found[0];
}
const wslHistoryCache = new Map();
const wslHistoryInFlight = new Map();
async function scanWslSessions(root, agentDir) {
  const helper = path.resolve(__dirname, '..', 'tools', 'list_wsl_sessions.py').replaceAll('\\', '/');
  const unixHelper = toWslPath(helper);
  if (!unixHelper.startsWith('/mnt/')) throw new Error('无法定位 WSL 历史检索脚本');
  const { stdout } = await execute('wsl.exe', [...runtime.wslPrefix, '--', 'python3', unixHelper, root, agentDir], { timeout: 60000 });
  const result = JSON.parse(stdout);
  return { total: result.total, sessions: result.sessions.map(item => ({ ...item, modifiedAt: new Date(item.modified * 1000).toISOString(), path: '\\\\wsl.localhost\\'+runtime.distro + item.path.replaceAll('/', '\\') })) };
}
async function listWslSessions(root, agentDir = runtime.wslAgentDir) {
  const key=JSON.stringify([root,agentDir]);
  const cached = wslHistoryCache.get(key);
  if (cached && Date.now() - cached.time < 15000) return cached.result;
  if (wslHistoryInFlight.has(key)) return wslHistoryInFlight.get(key);
  const pending = scanWslSessions(root,agentDir).then(result => {
    wslHistoryCache.set(key, { time: Date.now(), result });
    return result;
  }).finally(() => wslHistoryInFlight.delete(key));
  wslHistoryInFlight.set(key, pending);
  return pending;
}
async function importSession({ source, cwd, destinationRoot, omp, workRoot, settings, sourceRuntime }) {
  if (typeof source !== 'string' || !source.toLowerCase().endsWith('.jsonl')) throw new Error('请选择 OMP JSONL session');
  if (!path.isAbsolute(source) || !path.isAbsolute(cwd) || !path.isAbsolute(destinationRoot)) throw new Error('导入路径必须是绝对路径');
  const stat = await fs.stat(source); if (!stat.isFile()) throw new Error('session 不是普通文件');
  const sourceHeader = await readSourceHeader(source);
  if (workRoot && !belongsToWork(sourceHeader.cwd, workRoot)) throw new Error('该 session 的原始工作目录不属于当前 work；请先切换到对应工作根');
  // A session started in work/repos/foo must resume there, not in its parent work.
  const targetCwd = workRoot ? path.join(cwd, ...path.posix.relative(workRoot, linuxCwd(sourceHeader.cwd)).split('/').filter(Boolean)) : cwd;
  const linuxSource = wslSource(source,settings?.wslAgentDir);
  const destination = path.join(destinationRoot, randomUUID());
  const agentDir = path.join(destination, 'agent');
  const archive = path.join(destination, 'session.tar');
  await fs.mkdir(agentDir, { recursive: true });
  let pack, imported, warning;
  try {
  if (linuxSource || sourceRuntime === 'wsl') {
    const archiveUnix = toWslPath(archive);
    if (!archiveUnix.startsWith('/mnt/')) throw new Error('导入临时目录不在 WSL 可访问的 Windows 驱动器内');
    const args=['session','pack',linuxSource || toWslPath(source),archiveUnix];
    pack = await execute('wsl.exe', settings ? wslArgs(settings,args) : [...runtime.wslPrefix, '--', runtime.wslExecutable,...args]);
  } else {
    pack = await execute(omp, ['session', 'pack', source, archive]);
  }
  // A unique agentDir means OMP's unpack cannot replace existing native sessions.
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: '' };
  const unpack = settings?.runtime === 'wsl'
    ? await execute('wsl.exe',wslArgs(settings,['session','unpack',toWslPath(archive),'--cwd',linuxCwd(sourceHeader.cwd)],toWslPath(agentDir)))
    : await execute(omp, ['session', 'unpack', archive, '--cwd', targetCwd], { env });
  const sessionFile = await importedJournal(agentDir);
  const metadata = { version: 1, workRoot, session: path.relative(agentDir, sessionFile), sourceKind: linuxSource || sourceRuntime==='wsl' ? 'wsl' : 'windows', runtime:settings?.runtime || 'windows', importedAt: new Date().toISOString() };
  if (typeof workRoot === 'string') await fs.writeFile(path.join(destination, 'import.json'), JSON.stringify(metadata, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  warning = /missing|缺失/i.test(pack.stderr + pack.stdout + unpack.stderr) ? '打包输出提示可能有缺失附件，请核查。' : null;
  imported = { sessionFile, agentDir, sourceKind: metadata.sourceKind, runtime:metadata.runtime };
  } finally {
    try { await fs.unlink(archive); } catch (error) { if (error.code !== 'ENOENT') warning = (warning ? warning + ' ' : '') + '临时归档未能清除。'; }
  }
  return { ...imported, warning };
}
async function listImportedSessions(destinationRoot, workRoot) {
  let entries;
  try { entries = await fs.readdir(destinationRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const home = path.join(destinationRoot, entry.name);
      const meta = JSON.parse(await fs.readFile(path.join(home, 'import.json'), 'utf8'));
      if (meta.version !== 1 || meta.workRoot !== workRoot || typeof meta.session !== 'string' || path.isAbsolute(meta.session)) continue;
      const agentDir = path.join(home, 'agent');
      const verified = await validateImportedSession(destinationRoot, agentDir, path.resolve(agentDir, meta.session), workRoot);
      const stat = await fs.stat(verified.sessionFile);
      result.push({ ...verified, title: await readSessionTitle(verified.sessionFile), modifiedAt: stat.mtime.toISOString(), importedAt: meta.importedAt, sourceKind: meta.sourceKind });
    } catch { /* A partially imported or invalid entry stays on disk and is not displayed. */ }
  }
  return result.sort((a,b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
}

async function validateNativeSession(agentDir, sessionFile, workRoot) {
  const realAgent = await fs.realpath(agentDir);
  const realSession = await fs.realpath(sessionFile);
  const relative = path.relative(path.join(realAgent, 'sessions'), realSession);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !realSession.endsWith('.jsonl')) throw new Error('session 不属于客户端的 OMP 历史库');
  const header = await readSourceHeader(realSession);
  if (!belongsToWork(header.cwd, workRoot)) throw new Error('此 session 属于其他工作根');
  return { agentDir: realAgent, sessionFile: realSession, id: header.id, executionRoot: linuxCwd(header.cwd) };
}

async function listNativeSessions(agentDir, workRoot) {
  const sessions = path.join(agentDir, 'sessions');
  let buckets;
  try { buckets = await fs.readdir(sessions, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.isSymbolicLink()) continue;
    for (const file of await fs.readdir(path.join(sessions, bucket.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      try {
        const verified = await validateNativeSession(agentDir, path.join(sessions, bucket.name, file.name), workRoot);
        const stat = await fs.stat(verified.sessionFile);
        result.push({ ...verified, title: await readSessionTitle(verified.sessionFile) || verified.id || file.name, sourceKind: 'native', modifiedAt: stat.mtime.toISOString() });
      } catch { /* Ignore incomplete journals and sessions from other work roots. */ }
    }
  }
  return result.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
module.exports = { importSession, wslSource, importedJournal, validateImportedSession, listWslSessions, listImportedSessions, belongsToWork, validateNativeSession, listNativeSessions, readSessionTitle };
