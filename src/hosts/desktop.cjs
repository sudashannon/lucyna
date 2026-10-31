const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {HostRegistry, identifier} = require('./registry.cjs');
const {deployFrozen} = require('./ssh-frozen.cjs');
const {HostConnection} = require('./connection.cjs');
const {RemoteSession} = require('./remote-session.cjs');
const {validatePrompt} = require('../prompt-input.cjs');

const messages = {
  omp_not_executable: '远端未找到 OMP，请填写可执行文件的绝对路径。',
  user_service_unavailable: '远端 systemd 用户服务不可用，请先启用用户服务。',
  update_pending: '远端已有其他版本，当前版本已暂存；保留原服务，请先完成版本更新。',
  controller_busy: '此会话由另一台客户端控制。请在原客户端断开，或明确接管。',
  stale_controller: '会话控制权已转移，请重新连接后核对状态。',
  session_interrupted: '远端进程已结束；可从历史记录明确续聊原会话，任务不会自动重放。',
  artifact_platform_mismatch: '当前没有匹配远端架构或 glibc 的安装包。',
};
function readable(error) { return messages[error.code] || error.message || String(error); }

class RemoteDesktop {
  constructor({directory, send = () => {}, notify = () => {}, bundle, deploy = deployFrozen, connection = (p, i) => new HostConnection(p, i), prefix}) {
    this.registry = new HostRegistry(directory); this.send = send; this.notify = notify;
    this.bundle = bundle || path.resolve(__dirname, '../../resources/remote-host/index.json');
    this.deploy = deploy; this.makeConnection = connection; this.prefix = prefix;
    this.connections = new Map(); this.jobs = new Map(); this.states = new Map();
    this.active = new Map(); this.starting = new Map(); this.cancelledStarts = new Set(); this.retry = new Map(); this.paused = new Set(); this.quitting = false;
  }
  status(id, phase, extra = {}) {
    const state = {phase, ...extra}; this.states.set(id, state); this.notify({hostId: id, ...state});
  }
  async list() {
    return (await this.registry.load()).profiles.map(p => ({id: p.id, name: p.name, ssh: p.ssh, root: p.root,
      omp: p.omp, agentDir: p.agentDir, installed: !!p.installed, ...this.states.get(p.id) || {phase: 'disconnected'}}));
  }
  async save(input) {
    if (input?.id && this.jobs.has(input.id)) throw Error('主机正在连接，请先取消再修改配置');
    const result = await this.registry.save(input);
    await this.disconnectHost(result.id);
    const bound=this.connections.get(result.id);
    if(bound&&JSON.stringify([bound.profile.ssh,bound.profile.root,bound.profile.omp,bound.profile.agentDir])!==JSON.stringify([result.ssh,result.root,result.omp,result.agentDir]))this.connections.delete(result.id);
    this.notify({hostId: result.id, phase: 'disconnected', changed: true}); return result;
  }
  async works() {
    return (await this.list()).map(p => ({name: p.root.split('/').pop() || p.name, root: p.root, kind: 'remote',
      hostId: p.id, hostName: p.name, hostStatus: p.phase, health: 'ok', issues: []}));
  }
  async connectHost(id) {
    identifier(id); this.paused.delete(id);
    if (this.jobs.has(id)) return this.jobs.get(id).promise;
    const current = this.connections.get(id);
    if (current?.connection.child && current.workspace) return current;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        let profile = await this.registry.get(id), installed = profile.installed;
        if (!installed) {
          this.status(id, 'probing');
          installed = await this.deploy(profile.ssh, this.bundle, {signal: controller.signal,
            ...(this.prefix ? {prefix: this.prefix(id)} : {}),
            onProgress: value => this.status(id, value.phase)});
          await this.registry.installed(id, installed);
          profile = await this.registry.get(id);
        }
        controller.signal.throwIfAborted(); this.status(id, 'connecting');
        const connection = current?.connection || this.makeConnection(profile.ssh, installed);
        const entry = {connection, profile, workspace: current?.workspace}; this.connections.set(id, entry);
        if (!current) connection.on('disconnected', () => this.transportLost(id));
        await connection.connect(); controller.signal.throwIfAborted();
        entry.workspace = await connection.request('workspace.inspect', {root: profile.root, omp: profile.omp, agentDir: profile.agentDir});
        controller.signal.throwIfAborted(); this.status(id, 'ready', {persistenceVerified: false}); return entry;
      } catch (error) {
        this.status(id, controller.signal.aborted ? 'disconnected' : 'error', {error: controller.signal.aborted ? '' : readable(error)});
        throw Error(readable(error));
      } finally { this.jobs.delete(id); }
    })();
    this.jobs.set(id, {controller, promise}); return promise;
  }
  cancel(id) { this.paused.add(identifier(id)); this.jobs.get(id)?.controller.abort(Error('已取消连接')); void this.connections.get(id)?.connection.disconnect(); }
  async disconnectHost(id) {
    identifier(id); this.paused.add(id); clearTimeout(this.retry.get(id)); this.retry.delete(id);
    this.jobs.get(id)?.controller.abort(Error('已断开连接'));
    const entry = this.connections.get(id);
    if (entry) await entry.connection.disconnect();
    this.status(id, 'disconnected');
  }
  async remove(id) { await this.registry.remove(id); await this.disconnectHost(id); this.connections.delete(id); this.notify({hostId: id, removed: true}); }
  emit(item, event) { this.send({...event, clientSessionId: item.saved.id, workRoot: item.saved.root, hostId: item.saved.hostId, runtime: 'ssh'}); }
  async persist(item) {
    if (item.session?.record) item.saved.descriptor = item.session.descriptor();
    await this.registry.remember(item.saved);
  }
  transportLost(id) {
    if (this.quitting) return;
    this.status(id, this.paused.has(id) ? 'disconnected' : 'reconnecting');
    for (const item of this.active.values()) if (item.saved.hostId === id && !item.saved.ended && !item.saved.detached) {
      this.emit(item, {type: 'remote_disconnected', paused: this.paused.has(id)});
      void this.persist(item).catch(error => this.emit(item, {type: 'diagnostic', message: readable(error)}));
    }
    if (!this.paused.has(id) && !this.jobs.has(id) && [...this.active.values()].some(item => item.saved.hostId === id && !item.saved.ended && !item.saved.detached)) this.schedule(id);
  }
  schedule(id, attempt = 0) {
    if (this.quitting || this.paused.has(id) || this.retry.has(id)) return;
    const timer = setTimeout(async () => {
      this.retry.delete(id);
      try { await this.reconnect(id); }
      catch (error) {
        if (this.paused.has(id) || this.quitting) return;
        this.status(id, 'reconnecting', {error: readable(error)});
        if (attempt < 4) this.schedule(id, attempt + 1);
        else {
          const message='自动重连暂未成功，可手动重试。'+readable(error);
          this.status(id, 'error', {error:message});
          for(const item of this.active.values())if(item.saved.hostId===id&&!item.saved.ended&&!item.saved.detached){this.emit(item,{type:'remote_disconnected',paused:true});this.emit(item,{type:'diagnostic',message});}
        }
      }
    }, Math.min(1500 * 2 ** attempt, 15000));
    timer.unref?.(); this.retry.set(id, timer);
  }
  async reconnect(id, takeover = false) {
    clearTimeout(this.retry.get(id)); this.retry.delete(id);
    await this.connectHost(id);
    for (const item of this.active.values()) if (item.saved.hostId === id && !item.saved.ended && !item.saved.detached) {
      try {
        if (!item.saved.descriptor) continue;
        await item.session.attach(item.saved.descriptor, {takeover});
        await this.persist(item); this.emit(item, {type: 'remote_reconnected'});
      } catch (error) {
        if (['session_not_live', 'session_interrupted', 'stale_generation'].includes(error.code)) {
          item.saved.ended=true;await this.persist(item);
          this.emit(item, {type: 'remote_interrupted', ended: true, message: messages.session_interrupted});
        } else throw error;
      }
    }
  }
  bind(saved, connection, clientId) {
    const item = {saved, session: new RemoteSession(connection, clientId)};
    this.active.set(saved.id, item);
    item.session.on('frame', frame => {
      if (frame.type === 'host_process_exit') {
        saved.ended = true; this.emit(item, {...frame, type: 'process_exit'}); void this.persist(item).catch(() => {}); return;
      }
      this.emit(item, frame);
      if (['ready', 'session_settled', 'prompt_result', 'session_info_update'].includes(frame.type)) void this.persist(item).catch(() => {});
    });
    item.session.on('questions', questions => this.emit(item, {type: 'remote_questions', questions}));
    item.session.on('diagnostic', error => {
      if (error.code === 'resync_required') {
        this.emit(item,{type:'remote_disconnected'});
        void item.session.resync().then(() => this.emit(item, {type: 'remote_reconnected'}))
          .catch(e => {if(item.session.polling)this.emit(item,{type:'remote_reconnected'});else this.emit(item, {type: 'diagnostic', message: readable(e)});});
      } else this.emit(item, {type: 'diagnostic', message: readable(error)});
    });
    return item;
  }
  async start(options) {
    const id = identifier(options.clientSessionId);
    if (this.starting.has(id)) return this.starting.get(id);
    this.cancelledStarts.delete(id);
    const task = this.startNative(options).finally(() => this.starting.delete(id));
    this.starting.set(id, task); return task;
  }
  async startNative(options) {
    const id = identifier(options.clientSessionId), hostId = identifier(options.hostId);
    const profile = await this.registry.get(hostId);
    if (options.root !== profile.root) throw Error('工作区不属于所选 SSH 主机');
    const entry = await this.connectHost(hostId), data = await this.registry.load();
    if(this.quitting||this.cancelledStarts.has(id))throw Error('会话启动已取消');
    let saved = data.sessions.find(s => s.id === id);
    if (saved && (saved.hostId !== hostId || saved.root !== options.root)) throw Error('会话所属主机与工作区不匹配');
    if(saved?.ended&&!options.explicitResume)throw Error(messages.session_interrupted);
    const previous = this.active.get(id);
    if (previous?.session.polling) return this.result(previous, profile);
    previous?.session.detach();
    if (!saved || saved.ended) saved = {id, hostId, root: options.root, operationId: randomUUID(), ended: false};
    let item = this.bind({...saved,detached:false}, entry.connection, data.clientId);
    try {
      if (saved.descriptor && !saved.ended) {
        await item.session.attach(saved.descriptor);
        this.emit(item, {type: 'remote_reconnected'});
      } else if (options.remoteSessionId) {
        const record = (await entry.connection.request('session.list')).find(s => s.id === options.remoteSessionId && s.root === entry.workspace.root);
        if (!record) throw Error('请从当前主机的历史列表选择会话');
        if (['starting', 'live'].includes(record.status)) {
          if ([...this.active.values()].some(other => other !== item && other.saved.hostId === hostId && other.session.record?.id === record.id)) throw Error('此远端会话已在另一标签页打开');
          await item.session.attach({record, cursor: 0}); this.emit(item, {type: 'remote_reconnected'});
        } else {
          if (!record.journal || !record.nativeSessionId || !options.explicitResume) throw Object.assign(Error(messages.session_interrupted), {code: 'session_interrupted'});
          await this.registry.remember(item.saved);
          await item.session.start({root: entry.workspace.root, omp: entry.workspace.omp, agentDir: profile.agentDir || undefined,
            resume: record.journal, expectedNativeId: record.nativeSessionId}, item.saved.operationId);
        }
      } else {
        await this.registry.remember(item.saved); // retain create identity even if acknowledgement is lost
        await item.session.start({root: entry.workspace.root, omp: entry.workspace.omp, agentDir: profile.agentDir || undefined}, item.saved.operationId);
      }
      await this.persist(item);
      if(this.quitting||this.cancelledStarts.has(id)){item.saved.detached=true;item.session.detach();await this.persist(item);throw Error('会话启动已取消；远端记录已保留');}
      if (item.saved.pendingOperation) this.emit(item, {type: 'remote_operation_uncertain', operationId: item.saved.pendingOperation});
      return this.result(item, profile);
    } catch (error) {
      if(['session_not_live','session_interrupted','stale_generation'].includes(error.code)){item.saved.ended=true;await this.persist(item);}
      item.session.detach(); this.emit(item, {type: 'remote_interrupted', ended: item.saved.ended, message: readable(error)}); throw Error(readable(error));
    }
  }
  result(item, profile) { return {runtime: 'ssh', hostId: profile.id, agentDir: profile.agentDir, remoteSessionId: item.session.record?.id, pid: item.session.record?.pid}; }
  owns(id) { return this.active.has(id)||this.starting.has(id); }
  get(id) { const item = this.active.get(identifier(id)); if (!item) throw Error('远端会话未连接'); return item; }
  async request(id, type, data = {}) {
    const item = this.get(id); if (type === 'prompt') {
      validatePrompt(data);
      if(item.saved.pendingOperation)throw Error('上一条消息的发送结果尚未核对，请先检查远端状态');
    }
    const operationId = randomUUID();
    if(type==='prompt') { item.saved.pendingOperation=operationId; await this.persist(item); }
    try {
      const result = type === 'get_messages' ? await item.session.messages() : await item.session.request(type, data, {operationId});
      if (type === 'get_state') {
        item.saved.sessionFile = result.sessionFile; item.saved.nativeId = result.sessionId;
        if(item.session.record&&!item.saved.ended)Object.assign(item.session.record,{nativeSessionId:result.sessionId,journal:result.sessionFile,status:'live'});
        await this.persist(item);
      }
      if(type==='prompt') { delete item.saved.pendingOperation; await this.persist(item); }
      return result;
    } catch (error) {
      if (type === 'prompt') {
        item.saved.pendingOperation = operationId; await this.persist(item);
        this.emit(item, {type: 'remote_operation_uncertain', operationId});
      }
      throw Error(readable(error));
    }
  }
  async operation(id, clear = false) {
    const item = this.get(id), key = item.saved.pendingOperation;
    if (!key) return {status: 'none'};
    const result = await item.session.operationStatus(key);
    if (clear) { delete item.saved.pendingOperation; await this.persist(item); }
    return {...result, operationId: key};
  }
  async respond(id, data) { return this.get(id).session.respond(data); }
  async close(id) {
    if(this.starting.has(id)){await this.detach(id);return;}
    const item = this.get(id);
    try {
      if (!item.session.polling) { await this.connectHost(item.saved.hostId); await item.session.attach(item.saved.descriptor); }
      await item.session.stop();
    }catch(error){if(!['session_not_live','session_interrupted','stale_generation'].includes(error.code))throw error;}
    item.saved.ended = true; await this.persist(item);
    this.emit(item, {type: 'process_exit', code: 0});
  }
  async detach(id) {
    if(this.starting.has(id))this.cancelledStarts.add(id);
    if(!this.active.has(id))return;
    const item = this.get(id); item.saved.detached=true;await this.persist(item); item.session.detach();
    this.emit(item, {type: 'remote_disconnected', paused: true});
  }
  async reconnectSession(id) {const item=this.get(id);item.saved.detached=false;return this.reconnect(item.saved.hostId);}
  listConnections() {
    return [...this.active.values()].filter(item => !item.saved.ended&&!item.saved.detached).map(item => ({id: item.saved.id, root: item.saved.root,
      hostId: item.saved.hostId, runtime: 'ssh', sessionFile: item.saved.sessionFile || '', ready: item.session.polling,
      remoteSessionId: item.session.record?.id, agentDir: '', questions: item.session.record?.questions || []}));
  }
  async history(root, hostId) {
    const profile = await this.registry.get(hostId);
    if (root !== profile.root) throw Error('无效远端工作区');
    const {connection, workspace} = await this.connectHost(hostId);
    const records = await connection.request('session.list');
    // Explicit resume creates a new process record, but still owns one journal.
    // Prefer its live writer so a stale process row cannot create a duplicate tab.
    const journals = new Map(), live = r => ['starting','live'].includes(r.status);
    for(const record of records.slice().reverse())if(record.root===workspace.root&&record.journal){
      const previous=journals.get(record.journal);
      if(!previous||live(record)&&!live(previous))journals.set(record.journal,record);
    }
    return {sessions: [], managed: [...journals.values()].map(r => ({
      id: r.nativeSessionId, sessionFile: r.journal, runtime: 'ssh', hostId, remoteSessionId: r.id,
      title: r.nativeSessionId?.slice(0, 12) || '远端会话', status: r.status, sourceKind: 'remote', agentDir: profile.agentDir,
    })), warnings: [], trash: []};
  }
  async readWork(root, hostId) {
    const profile = await this.registry.get(hostId); if (profile.root !== root) throw Error('无效远端工作区');
    const {connection} = await this.connectHost(hostId);
    const workspace = await connection.request('workspace.inspect', {root, omp: profile.omp, agentDir: profile.agentDir});
    return workspace.document || '# '+profile.name+'\n\n远端工作目录：'+root+'\n\n此目录尚无 SESSION.md。';
  }
  async shutdown() {
    this.quitting = true;
    for(const id of this.starting.keys())this.cancelledStarts.add(id);
    for (const timer of this.retry.values()) clearTimeout(timer);
    for (const job of this.jobs.values()) job.controller.abort(Error('客户端已退出'));
    for (const item of this.active.values()) { await this.persist(item); item.session.detach(); }
    await Promise.allSettled([...this.connections.values()].map(entry => entry.connection.disconnect()));
  }
}
module.exports = {RemoteDesktop, readable};
