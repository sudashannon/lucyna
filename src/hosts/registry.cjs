const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {validateSsh, linuxPath} = require('./profile.cjs');
const identifier = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw Error('无效主机或会话标识');
  return value;
};
function profile(input, id = randomUUID()) {
  if (!input || typeof input !== 'object') throw Error('请填写主机配置');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80 || /[\0\r\n]/.test(name)) throw Error('主机名称需要 1–80 个字符');
  const root = linuxPath(input.root);
  if (root === '/') throw Error('请选择具体的远端工作目录');
  return {id: identifier(id), name, ssh: validateSsh(input.ssh), root,
    omp: input.omp ? linuxPath(input.omp) : '', agentDir: input.agentDir ? linuxPath(input.agentDir) : ''};
}
class HostRegistry {
  constructor(directory) { this.file = path.join(directory, 'ssh-hosts.json'); this.queue = Promise.resolve(); }
  async load() {
    if (this.data) return this.data;
    if (!this.loading) this.loading = (async () => {
      try {
        const raw = await fs.readFile(this.file, 'utf8');
        if (raw.length > 4 * 1024 * 1024) throw Error('SSH 主机配置过大');
        const data = JSON.parse(raw);
        if (data.version !== 1 || !Array.isArray(data.profiles) || !Array.isArray(data.sessions)) throw Error('SSH 主机配置版本无效');
        identifier(data.clientId);
        data.profiles.forEach(item => profile(item, item.id));
        return this.data = data;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return this.data = {version: 1, clientId: randomUUID(), profiles: [], sessions: []};
      }
    })();
    return this.loading;
  }
  async mutate(change) {
    const run = this.queue.then(async () => {
      const before = await this.load(), data = structuredClone(before);
      const result = change(data);
      await fs.mkdir(path.dirname(this.file), {recursive: true});
      const temporary = this.file+'.'+randomUUID()+'.tmp';
      try {
        await fs.writeFile(temporary, JSON.stringify(data, null, 2)+'\n', {mode: 0o600});
        // Windows scanners may briefly hold the destination without delete sharing.
        // Keep atomic replacement: never unlink the last valid registry to get past a lock.
        for(let attempt=0;;attempt++) {
          try { await fs.rename(temporary, this.file); break; }
          catch(error) { if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=7)throw error;await new Promise(resolve=>setTimeout(resolve,25*2**attempt)); }
        }
      }
      finally { await fs.rm(temporary, {force: true}); }
      this.data = data; return result;
    });
    this.queue = run.catch(() => {}); return run;
  }
  async get(id) {
    const item = (await this.load()).profiles.find(p => p.id === identifier(id));
    if (!item) throw Error('SSH 主机不存在，请检查配置');
    return item;
  }
  async save(input) {
    const next = profile(input, input.id || undefined);
    return this.mutate(data => {
      const old = data.profiles.find(p => p.id === next.id);
      if (old) {
        const changed = JSON.stringify({...old, name: next.name, installed: undefined}) !== JSON.stringify(next);
        if (changed && data.sessions.some(s => s.hostId === next.id && !s.ended)) {
          throw Error('该主机仍有远端会话；结束会话后再修改连接或路径配置');
        }
        if (changed) delete old.installed;
        Object.assign(old, next);
      } else { if (data.profiles.length >= 32) throw Error('最多保存 32 台 SSH 主机'); data.profiles.push(next); }
      return next;
    });
  }
  async installed(id, installed) {
    return this.mutate(data => {
      const item = data.profiles.find(p => p.id === id);
      if (!item) throw Error('SSH 主机已移除');
      if (item.installed && item.installed.installationId !== installed.installationId) throw Error('远端安装身份已变化，请重新添加主机');
      item.installed = installed;
    });
  }
  async remember(record) {
    return this.mutate(data => {
      const index = data.sessions.findIndex(s => s.id === record.id);
      if (index >= 0) data.sessions[index] = structuredClone(record);
      else { if (data.sessions.length >= 1024) throw Error('远端会话记录达到上限'); data.sessions.push(structuredClone(record)); }
    });
  }
  async remove(id) {
    identifier(id);
    return this.mutate(data => {
      if (data.sessions.some(s => s.hostId === id && !s.ended)) throw Error('请先结束该主机的远端会话，再移除配置');
      data.profiles = data.profiles.filter(p => p.id !== id);
      data.sessions = data.sessions.filter(s => s.hostId !== id);
    });
  }
}
module.exports = {HostRegistry, profile, identifier};
