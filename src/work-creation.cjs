const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {windowsSessionPath} = require('./client-settings.cjs');
const {validateNativeSession,listNativeSessions,invalidateWslHistory} = require('./history.cjs');
const {requireWorkRoot} = require('./work-access.cjs');

const namePattern = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u;
const childName = (base, root) => typeof root === 'string' && root.startsWith(base + '/') &&
  namePattern.test(root.slice(base.length + 1)) ? root.slice(base.length + 1) : null;

function handoffRoot(messages, base) {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || last.stopReason && last.stopReason !== 'stop') return null;
  const text = typeof last.content === 'string' ? last.content
    : (last.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const candidates = new Set();
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    const command = line.trim().replace(/^`(\/move [^`]+)`$/, '$1');
    if (!fenced && command.startsWith('/move ')) candidates.add(command.slice(6).trim());
  }
  if (!candidates.size) return null;
  const [root] = candidates;
  if (candidates.size !== 1 || !childName(base, root)) throw Error('OMP 未提供唯一有效的 Work 交接路径');
  return root;
}

class WorkCreation {
  constructor({directory,base,initialize,verify,admit,listWorks,toNative=windowsSessionPath,
    validateJournal=validateNativeSession,listJournals=listNativeSessions}) {
    Object.assign(this,{directory,base,initialize,verify,admit,listWorks,toNative,validateJournal,listJournals});
  }

  async save(id, state) {
    const target = path.join(this.directory,id+'.json');
    const temporary = target+'.'+randomUUID()+'.tmp';
    try {
      await fs.writeFile(temporary,JSON.stringify(state)+'\n',{flag:'wx',mode:0o600});
      await fs.rename(temporary,target);
    } finally {
      await fs.rm(temporary,{force:true});
    }
  }

  async work(root, before, nativeId) {
    const name = childName(this.base,root);
    if (!name || before.includes(name)) throw Error('交接目录不是这次新建的 Work');
    let works = await this.listWorks({refresh:true});
    if (!works.some(work=>work.root===root&&!work.hostId)) works = await this.listWorks({refresh:true});
    const work = requireWorkRoot(works,root);
    if (work.kind === 'invalid') throw Error('新 Work 登记尚未通过校验，请让 OMP 核对后重试');
    await this.verify(root);
    if (typeof nativeId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(nativeId))throw Error('建根会话的原生 ID 无效');
    const log = await fs.lstat(path.join(this.toNative(root),'SESSION-'+nativeId+'.md')).catch(error=>{
      if (error.code!=='ENOENT') throw error;
      return null;
    });
    if (!log?.isFile()) throw Error('新 Work 尚未保存本次建根会话的私有日志，请让 OMP 核对后重试');
    return work;
  }

  async prepare(id, settings) {
    await fs.mkdir(this.directory,{recursive:true});
    let state;
    try { state = JSON.parse(await fs.readFile(path.join(this.directory,id+'.json'),'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.initialize(settings.wslAgentDir);
      state = {version:1, before:await fs.readdir(this.toNative(this.base)), agentDir:settings.wslAgentDir};
      await this.save(id,state);
    }
    if (state.version !== 1 || !Array.isArray(state.before) || state.agentDir !== settings.wslAgentDir)
      throw Error('新建 Work 的 OMP 配置已变更，请先恢复原 WSL 配置目录');
    let root = this.base, work, journal;
    const agent = this.toNative(settings.wslAgentDir);
    if (state.target) {
      work = await this.work(state.target,state.before,state.nativeId);
      const matches = (await this.listJournals(agent,work.root)).filter(item=>item.id===state.nativeId&&item.executionRoot===work.root);
      if (matches.length>1) throw Error('发现多个原生会话日志，请核对后再恢复');
      journal = matches[0];
      if (journal) root = work.root;
    }
    if (!journal && state.source) {
      try { journal = await this.validateJournal(agent,state.source,this.base); }
      catch (error) { if (error.code!=='ENOENT' || state.target) throw error; }
      if (journal && (journal.executionRoot!==this.base || journal.id!==state.nativeId))
        throw Error('建根会话的原生身份已变更，请核对原会话');
    }
    return {root, settings, agentDir:settings.wslAgentDir, nativeHistory:true,
      ...(journal?{resume:journal.sessionFile,resumeId:journal.id}:{}),
      ...(root===this.base?{creation:{state,started:!!journal}}:{creationWork:work})};
  }

  remember(record) {
    const creation = record.creation;
    if (!creation || creation.state.target || !record.sessionFile || !record.nativeId) return creation?.writing;
    const {state} = creation;
    if (state.source === record.sessionFile && state.nativeId === record.nativeId && creation.writing) return creation.writing;
    state.source = record.sessionFile;
    state.nativeId = record.nativeId;
    const writing = Promise.resolve(creation.writing).catch(()=>{}).then(()=>this.save(record.id,state));
    creation.writing = writing;
    void writing.catch(()=>{if(creation.writing===writing)creation.writing=undefined;});
    return writing;
  }

  async finish(record, bind) {
    const {state} = record.creation;
    await record.creation.writing;
    const native = await record.session.request('get_state');
    if (!native?.isSettled || native.isStreaming || native.isCompacting || native.queuedMessages?.length || !native.sessionFile || !native.sessionId) return null;
    const target = state.target || handoffRoot((await record.session.messages()).messages,this.base);
    if (!target) return null;
    const work = await this.work(target,state.before,native.sessionId);
    return this.admit(target,async()=>{
      const agent = this.toNative(record.agentDir);
      const before = await this.validateJournal(agent,this.toNative(native.sessionFile),this.base);
      if (before.id!==native.sessionId || state.nativeId && before.id!==state.nativeId) throw Error('建根会话的原生身份已变更');
      if (before.executionRoot!==this.base && before.executionRoot!==target) throw Error('原生会话目录与新 Work 不一致');
      state.target = target;
      state.nativeId = before.id;
      if (before.executionRoot===this.base) state.source = before.sessionFile;
      await this.save(record.id,state);
      if (before.executionRoot===this.base) {
        const latest = await record.session.request('get_state');
        if (!latest.isSettled || latest.queuedMessages?.length || latest.sessionId!==before.id || record.questions.size)
          throw Error('建根会话仍在运行，请结束当前操作后重试交接');
        const moved = await record.session.request('prompt',{message:'/move '+target,images:[],streamingBehavior:'followUp'});
        if (moved?.agentInvoked!==false) throw Error('OMP 未确认原生会话迁移，请重试交接');
      }
      const current = await record.session.request('get_state');
      const journal = await this.validateJournal(agent,this.toNative(current.sessionFile),target);
      if (journal.executionRoot!==target || current.sessionId!==before.id || journal.id!==before.id)
        throw Error('无法确认同一个原生会话已迁入新 Work');
      invalidateWslHistory();
      return bind(work,journal);
    });
  }
}

module.exports = {WorkCreation,handoffRoot};
