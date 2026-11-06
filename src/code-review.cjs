const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {classifyWorkAsset, sensitiveDocument} = require('./work-knowledge-policy.cjs');

const digest = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const ACTIVE = new Set(['queued', 'capturing', 'running', 'stopping']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const publicError = message => Object.assign(Error(message), {publicMessage: message});
function text(value, name, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\0\x08]/.test(value)) throw publicError(`无效的${name}`);
  return value;
}
function validateSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw publicError('无效的审查来源');
  const allowed = source.kind === 'turn' ? ['kind','sessionId','messageId'] : ['kind','root','member','scope'];
  if (Object.keys(source).some(key => !allowed.includes(key))) throw publicError('审查来源含不支持的参数；当前仅支持本机 Work');
  if (source.kind === 'turn') {
    const sessionId = text(source.sessionId, '会话标识', 200), messageId = text(source.messageId, '回合标识', 80);
    if (!/^(user|skill)-[0-9]{1,16}$/.test(messageId)) throw publicError('此回合缺少稳定标识，请重新打开会话');
    return {kind: 'turn', sessionId, messageId};
  }
  if (source.kind === 'workspace') {
    const root = text(source.root, '工作根', 4096), member = text(source.member, '仓库标识', 200);
    if (!root.startsWith('/') || /[\r\n]/.test(root) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(member)
      || !['all', 'staged', 'unstaged'].includes(source.scope)) throw publicError('无效的工作区审查范围');
    return {kind: 'workspace', root, member, scope: source.scope};
  }
  throw publicError('不支持的审查来源');
}

function freezeSnapshot(raw, root) {
  if (!Array.isArray(raw?.files) || !Array.isArray(raw.warnings) || raw.files.length > 240) throw publicError('审查快照格式无效');
  const warnings = raw.warnings.filter(item => typeof item === 'string').map(item => item.slice(0,1000)).slice(0,40);
  const files = [], seen = new Set(); let remaining = 160 * 1024;
  for (const entry of raw.files.slice(0,160)) {
    const member = text(entry.member, '仓库标识', 200), filename = text(entry.path, '文件路径', 4096);
    if (filename.startsWith('/') || filename.includes('\\') || filename.split('/').some(part => ['..', '.', ''].includes(part))
      || !['turn','staged','unstaged'].includes(entry.scope)) throw publicError('审查文件路径或范围无效');
    const id = digest(JSON.stringify([member, filename, entry.scope])).slice(0,24);
    if (seen.has(id)) throw publicError('快照含重复的文件范围');
    seen.add(id);
    if (typeof entry.patch !== 'string') throw publicError('审查差异正文无效');
    let patch = entry.patch, omitted = !!entry.omitted;
    const sensitive = classifyWorkAsset({path: filename}).category === 'excluded'
      || !!sensitiveDocument(patch);
    const bytes = Buffer.byteLength(patch);
    if (sensitive) { patch = ''; omitted = true; warnings.push(`${member}/${filename} 含敏感配置或疑似凭据，未保存正文或发送模型。`); }
    else if (bytes > 64 * 1024 || bytes > remaining) { patch = ''; omitted = true; warnings.push(`${member}/${filename} 超过本次模型输入范围，未参与分析。`); }
    else if (!/^@@ /m.test(patch) || patch.includes('\0')) { patch = ''; omitted = true; warnings.push(`${member}/${filename} 没有可分析的文本差异。`); }
    if (omitted) patch = '';
    remaining -= Buffer.byteLength(patch);
    files.push({id, member, path: filename, scope: entry.scope, patch, ...(omitted ? {omitted: true} : {})});
  }
  if (raw.files.length > files.length) warnings.push('其余文件超过审查文件数上限。');
  // Context is optional, bounded and frozen with the evidence, never reread by an engine.
  let context = typeof raw.context === 'string' ? raw.context.slice(0,6000) : '';
  if (sensitiveDocument(context)) {context='';warnings.push('工作要求含疑似凭据，未纳入审查上下文。');}
  const partial = !!raw.partial || warnings.length > 0 || files.some(file => file.omitted);
  const content = {root, files, context, partial, warnings: [...new Set(warnings)]};
  return {id: digest(JSON.stringify(content)), capturedAt: Number.isFinite(raw.capturedAt) ? raw.capturedAt : Date.now(), ...content};
}

function patchEvidence(patch) {
  const lines = [], newLines = new Set(); let next = 0, inHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { next = Number(hunk[1]); inHunk = true; lines.push(''); continue; }
    if (!inHunk) continue;
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (/^[ +\-]/.test(line)) {
      lines.push(line.slice(1));
      if (!line.startsWith('-')) newLines.add(next++);
    }
  }
  return {code: lines.join('\n'), newLines};
}
function validateFindings(value, snapshot) {
  if (!Array.isArray(value) || value.length > 20) throw publicError('模型返回的审查问题格式无效，未保存结果');
  const files = new Map(snapshot.files.filter(file => !file.omitted && file.patch).map(file => [file.id, file]));
  const findings = [], seen = new Set(), warnings = [];
  for (const finding of value) {
    if (!finding || !files.has(finding.fileId) || !['high','medium','low'].includes(finding.severity)) throw publicError('审查问题引用了未分析的文件或无效级别，未保存结果');
    const title = text(finding.title, '问题标题', 160), body = text(finding.body, '问题说明', 3000);
    const evidence = text(finding.evidence, '代码证据', 3000).replaceAll('\r\n','\n');
    const {code, newLines} = patchEvidence(files.get(finding.fileId).patch);
    if (evidence.trim().length < 3 || !code.includes(evidence)) throw publicError('审查问题的代码证据无法在快照中核对，未保存结果');
    const suggestion = finding.suggestion === undefined ? undefined : text(finding.suggestion, '修复建议', 2000);
    const key = digest(JSON.stringify([finding.fileId, title.trim(), evidence]));
    if (seen.has(key)) continue;
    seen.add(key);
    const start = finding.lineStart, end = finding.lineEnd ?? start;
    const located = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start && end-start <= 80
      && Array.from({length: end-start+1}, (_,i) => start+i).every(line => newLines.has(line));
    if ((start !== undefined || finding.lineEnd !== undefined) && !located) warnings.push('部分问题行号不在快照范围内，已改为文件级定位。');
    findings.push({id: key.slice(0,24), fileId: finding.fileId, severity: finding.severity, title, body, evidence,
      ...(suggestion ? {suggestion} : {}), ...(located ? {lineStart: start, lineEnd: end} : {}), status: 'open'});
  }
  return {findings, warnings: [...new Set(warnings)]};
}

class CodeReviewService {
  constructor({directory, resolveSource, config, engine, clock = Date.now, maxConcurrent = 1}) {
    Object.assign(this, {directory, resolveSource, config, engine, clock, maxConcurrent});
    this.records = new Map(); this.jobs = new Map(); this.writes = new Map(); this.waiters = []; this.running = 0; this.closed = false;
    this.ready = this.restore();
  }
  async restore() {
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    const names = await fs.readdir(this.directory);
    for (const name of names.filter(name => UUID.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))) {
      const file = path.join(this.directory, name), stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.size > 2*1024*1024) continue;
      let run; try { run = JSON.parse(await fs.readFile(file,'utf8')); } catch { continue; }
      if (run.version !== 1 || run.id+'.json' !== name || typeof run.sourceKey !== 'string' || !Array.isArray(run.findings)) continue;
      if (ACTIVE.has(run.status)) { run.status = 'interrupted'; run.error = '客户端已重启，上次审查中断；可重新发起审查'; run.updatedAt = run.finishedAt = this.clock(); }
      this.records.set(run.id, run);
      if (run.status === 'interrupted') await this.save(run);
    }
    await this.prune();
  }
  save(run) {
    const bytes = JSON.stringify(run), id = run.id;
    const task = (this.writes.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const target = path.join(this.directory, id+'.json'), temporary = target+'.'+randomUUID()+'.tmp';
      try { await fs.writeFile(temporary, bytes, {flag: 'wx', mode: 0o600}); await fs.rename(temporary, target); }
      finally { await fs.unlink(temporary).catch(() => {}); }
    });
    this.writes.set(id, task);
    return task.finally(() => {if (this.writes.get(id) === task) this.writes.delete(id);});
  }
  public(run, source) {
    const {sourceKey, cacheKey, version, ...value} = run;
    return clone({...value, source: source || value.source});
  }
  async identity(source) {
    const normalized = validateSource(source), identity = await this.resolveSource(normalized);
    if (!identity || typeof identity.key !== 'string' || typeof identity.root !== 'string') throw publicError('审查来源当前不可用');
    return {...identity, source: normalized};
  }
  async start(source) {
    await this.ready;
    if (this.closed) throw publicError('代码审查服务正在关闭');
    const identity = await this.identity(source);
    if (this.closed) throw publicError('代码审查服务正在关闭');
    const existing = [...this.records.values()].find(run => run.sourceKey === identity.key && ACTIVE.has(run.status));
    if (existing) return this.public(existing, identity.source);
    if (this.jobs.size >= 4) throw publicError('已有多个审查任务，请等待完成或停止其中一个');
    const now = this.clock(), run = {version: 1, id: randomUUID(), sourceKey: identity.key, source: identity.source,
      status: 'queued', createdAt: now, updatedAt: now, findings: []};
    this.records.set(run.id, run);
    let prepared;
    const controller = new AbortController(), job = {controller, task: null, prepared:new Promise(resolve=>{prepared=resolve;})};
    this.jobs.set(run.id, job);
    try { await this.save(run); } catch (error) { this.jobs.delete(run.id); this.records.delete(run.id); prepared(); throw publicError('无法保存审查任务，请检查本地磁盘空间'); }
    job.task = this.execute(run, identity, controller.signal).finally(() => this.jobs.delete(run.id));
    // All task failures are retained in the record, not unhandled IPC promises.
    job.task.catch(() => {});
    prepared();
    return this.public(run);
  }
  async transition(run, status, extra = {}) {
    Object.assign(run, extra, {status, updatedAt: this.clock()});
    await this.save(run);
  }
  async acquire(signal) {
    signal.throwIfAborted();
    if (this.running < this.maxConcurrent) {this.running++; return;}
    await new Promise((resolve,reject) => {
      const waiter = {resolve: () => {signal.removeEventListener('abort', abort); resolve();}};
      const abort = () => {const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i,1); reject(signal.reason);};
      this.waiters.push(waiter); signal.addEventListener('abort',abort,{once:true});
    });
  }
  release() { const waiter = this.waiters.shift(); if (waiter) waiter.resolve(); else this.running--; }
  async execute(run, identity, signal) {
    let acquired = false;
    try {
      signal.throwIfAborted();
      await this.transition(run,'capturing',{stage:'正在固定代码差异'});
      const raw = await identity.load(signal);
      signal.throwIfAborted();
      run.snapshot = freezeSnapshot(raw, identity.root);
      if (!run.snapshot.files.some(file => !file.omitted && file.patch)) {
        if (run.snapshot.partial) throw publicError('没有完整可分析的文本差异，请查看覆盖范围说明');
        await this.transition(run,'completed',{stage:'所选范围没有代码改动',finishedAt:this.clock()}); return;
      }
      await this.transition(run,'queued',{stage:'快照已保存，等待审查'});
      await this.acquire(signal); acquired = true; signal.throwIfAborted();
      const config = await this.config(); signal.throwIfAborted();
      if (!config?.baseURL || !config?.model) throw publicError('请先在设置中填写辅助模型 API 地址和模型名称');
      run.engine = {id:this.engine.id,version:this.engine.version,model:config.model};
      run.cacheKey = digest(JSON.stringify([identity.key, run.snapshot.id, this.engine.id, this.engine.version, config.baseURL, config.protocol, config.model]));
      const cached = [...this.records.values()].filter(prior => prior.id !== run.id && prior.status === 'completed' && prior.cacheKey === run.cacheKey)
        .sort((a,b) => b.updatedAt-a.updatedAt || b.createdAt-a.createdAt)[0];
      if (cached) {
        await this.transition(run,'completed',{findings:clone(cached.findings),warnings:clone(cached.warnings || []),reusedFrom:cached.id,stage:'相同快照已审查，复用已有结果',finishedAt:this.clock()}); return;
      }
      await this.transition(run,'running',{stage:'正在检查固定差异，最长约 3 分钟'});
      const result = await this.engine.review(config, clone(run.snapshot), signal);
      signal.throwIfAborted();
      const checked = validateFindings(result?.findings, run.snapshot);
      const usage = result?.usage;
      if (usage && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0)
        run.usage = {inputTokens:usage.inputTokens,outputTokens:usage.outputTokens};
      await this.transition(run,'completed',{findings:checked.findings, warnings:checked.warnings, stage:'代码审查完成',finishedAt:this.clock()});
    } catch (error) {
      const cancelled = signal.aborted;
      await this.transition(run,cancelled?'cancelled':'failed',{finishedAt:this.clock(),stage:cancelled?'审查已停止':'审查未完成',
        ...(cancelled ? {} : {error:error.publicMessage || '代码审查未完成，请重试；原始代码未修改'})});
    } finally {
      if (acquired) this.release();
      await this.prune();
    }
  }
  async read(id) {
    await this.ready;
    if (!UUID.test(id || '') || !this.records.has(id)) throw publicError('审查记录不存在或已清理');
    return this.public(this.records.get(id));
  }
  async list(source) {
    await this.ready; const identity = await this.identity(source);
    return [...this.records.values()].filter(run => run.sourceKey === identity.key).sort((a,b) => b.createdAt-a.createdAt).slice(0,8).map(run => this.public(run,identity.source));
  }
  async cancel(id) {
    await this.read(id);
    const run = this.records.get(id), job = this.jobs.get(id);
    if (!job || !ACTIVE.has(run.status)) return this.public(run);
    // Abort before awaiting disk I/O so late model output cannot win the race.
    job.controller.abort();
    await this.transition(run,'stopping',{stage:'正在取消审查请求'});
    return this.public(run);
  }
  async updateFinding(id, findingId, status) {
    await this.read(id);
    const run = this.records.get(id), finding = run.findings.find(item => item.id === findingId);
    if (run.status !== 'completed' || !finding || !['open','ignored'].includes(status)) throw publicError('无法更新这条审查问题');
    finding.status = status; run.updatedAt = this.clock(); await this.save(run);
    return this.public(run);
  }
  async prune() {
    const terminal = [...this.records.values()].filter(run => !ACTIVE.has(run.status)).sort((a,b) => b.createdAt-a.createdAt);
    for (const run of terminal.slice(120)) {
      if (this.jobs.has(run.id)) continue;
      await this.writes.get(run.id)?.catch(() => {});
      await fs.unlink(path.join(this.directory,run.id+'.json')).catch(() => {}); this.records.delete(run.id);
    }
  }
  async drain() { await this.ready; while (this.jobs.size) {await Promise.allSettled([...this.jobs.values()].map(job => job.task || job.prepared));} }
  async close() { this.closed = true; await this.ready; for (const job of this.jobs.values()) job.controller.abort(); await this.drain(); }
}
module.exports = {CodeReviewService, validateSource, freezeSnapshot, validateFindings, patchEvidence};
