const fs = require('node:fs/promises');
const {createHash} = require('node:crypto');
const {belongsToWork} = require('./history.cjs');
const {wslSessionPath} = require('./client-settings.cjs');

function journalIdentity(file) {
  let canonical = file.startsWith('/') || /^\\\\wsl[.$]/i.test(file)
    ? wslSessionPath(file) : file.replaceAll('\\', '/').toLowerCase();
  const mountedDrive = /^\/mnt\/([a-z])\/(.*)$/i.exec(canonical);
  if (mountedDrive) canonical = `${mountedDrive[1]}:/${mountedDrive[2]}`.toLowerCase();
  return 'journal-' + createHash('sha256').update(canonical).digest('hex');
}

// The caller resolves the registered journal first. Recheck the header on the
// same handle used for reading so a replaced file cannot change Work ownership.
async function readAssistantJournal({file, root, nativeId, limit = 16 * 1024 * 1024}) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw Error('会话超过本轮 16 MiB 读取范围，可打开原会话后汇总已加载内容');
    const bytes = Buffer.alloc(stat.size);
    let position = 0;
    while (position < bytes.length) {
      const {bytesRead} = await handle.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    const lines = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, position)).split('\n');
    const entries = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      try { entries.push(JSON.parse(lines[index])); }
      catch {
        if (index !== lines.length - 1) throw Error('原生会话记录含无法解析的内容，请在原会话中核对');
      }
    }
    const header = entries[0];
    if (header?.type !== 'session' || !belongsToWork(header.cwd, root) || nativeId && header.id !== nativeId) {
      throw Error('会话身份或工作目录已变化，请刷新历史列表');
    }
    const nodes = entries.filter(entry => typeof entry.id === 'string' && entry.type !== 'session');
    let active = entries.slice(1);
    if (nodes.some(entry => Object.hasOwn(entry, 'parentId'))) {
      const byId = new Map(nodes.map(entry => [entry.id, entry]));
      active = [];
      const seen = new Set();
      let entry = nodes.at(-1);
      while (entry) {
        if (seen.has(entry.id)) throw Error('原生会话分支记录存在循环');
        seen.add(entry.id);
        active.push(entry);
        if (entry.parentId && !byId.has(entry.parentId)) throw Error('原生会话分支记录不完整');
        entry = byId.get(entry.parentId);
      }
      active.reverse();
    }
    return active.filter(entry => entry.type === 'message').map(entry => ({
      ...entry.message, timestamp: entry.message?.timestamp ?? entry.timestamp,
    }));
  } finally { await handle.close(); }
}

class WorkAssistantAccess {
  constructor({assistant, resolveWork, listHistory, readHistory}) {
    Object.assign(this, {assistant, resolveWork, listHistory, readHistory});
    this.loading = new Map();
    this.operations = new Map();
  }

  // History ingestion and journal removal share this queue, so a read which
  // started before deletion cannot restore the removed session's derived text.
  exclusive(identity, run) {
    const key = JSON.stringify([identity.hostId || '', identity.root]);
    const previous = this.operations.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(run);
    this.operations.set(key, pending);
    return pending.finally(() => {
      if (this.operations.get(key) === pending) this.operations.delete(key);
    });
  }

  async call(operation, input = {}) {
    if (!['status', 'refresh', 'configure', 'history'].includes(operation) || !input || Array.isArray(input)
      || Object.keys(input).some(key => !['root', 'hostId', 'enabled'].includes(key))
      || typeof input.root !== 'string' || input.hostId !== undefined && typeof input.hostId !== 'string'
      || input.enabled !== undefined && (operation !== 'configure' || typeof input.enabled !== 'boolean')) {
      throw Error('无效的 Work 助手请求');
    }
    const identity = {root: input.root, hostId: input.hostId};
    await this.resolveWork(identity);
    if (operation === 'configure') return this.assistant.configure(identity, {enabled: input.enabled});
    if (operation === 'refresh') return this.assistant.refresh(identity);
    if (operation === 'history') {
      if (identity.hostId) throw Error('远端会话在打开后同步摘要资料；历史批量补齐当前支持本机 Work');
      const key = JSON.stringify(identity);
      if (!this.loading.has(key)) {
        const pending = this.exclusive(identity, () => this.loadHistory(identity))
          .finally(() => this.loading.delete(key));
        this.loading.set(key, pending);
      }
      return this.loading.get(key);
    }
    return this.assistant.view(identity);
  }

  async loadHistory(identity) {
    const history = await this.listHistory(identity);
    const unique = new Map();
    for (const entry of [...history.managed || [], ...history.sessions || []]) {
      const source = entry.sessionFile || entry.path;
      if (typeof source === 'string' && !unique.has(journalIdentity(source))) unique.set(journalIdentity(source), entry);
    }
    const entries = [...unique.entries()].sort((a, b) =>
      (Date.parse(b[1].modifiedAt || b[1].modified || '') || 0) - (Date.parse(a[1].modifiedAt || a[1].modified || '') || 0));
    const historyOmitted = Math.max(0, (Number(history.total) || 0) - (history.sessions?.length || 0));
    const coverage = {available: entries.length, loaded: 0, skipped: 0, limited: entries.length > 12 || historyOmitted > 0,
      warnings: [...history.warnings || []], checkedAt: new Date().toISOString()};
    if (historyOmitted) coverage.warnings.push('历史目录还有未列出或已合并的记录，当前数量仅表示可见列表中的会话');
    for (const [sessionId, entry] of entries.slice(0, 12)) {
      try {
        await this.resolveWork(identity);
        const result = await this.readHistory(entry, identity);
        const messages = Array.isArray(result) ? result : result.messages;
        await this.assistant.ingest({...identity, sessionId, title: entry.title || entry.id || '历史会话', messages,
          authoritative: Array.isArray(result) || result.authoritative === true}, {schedule: false});
        coverage.loaded++;
      } catch (error) {
        coverage.skipped++;
        coverage.warnings.push(`${entry.title || '历史会话'} · ${error.message}`);
      }
    }
    await this.assistant.setHistoryCoverage(identity, coverage);
    return this.assistant.view(identity);
  }
}

module.exports = {WorkAssistantAccess, journalIdentity, readAssistantJournal};
