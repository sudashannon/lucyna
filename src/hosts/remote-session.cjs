const {EventEmitter} = require('node:events');
const {randomUUID} = require('node:crypto');
const {FrameDecoder, readMessages} = require('../native-rpc.cjs');

class RemoteSession extends EventEmitter {
  constructor(connection, clientId) {
    super(); this.connection = connection; this.clientId = clientId; this.pending = new Map();
    this.cursor = 0; this.committedCursor = 0; this.decoder = new FrameDecoder();
    this.pollGeneration = 0;
    this.lost = () => {
      this.pollGeneration++;
      this.polling = false; clearTimeout(this.timer);
      for (const [operationId, item] of this.pending) {
        clearTimeout(item.timer);
        item.reject(Object.assign(Error('连接已断开，操作保留在远端；请查询执行状态'), {code: 'transport_lost', operationId, uncertain: true}));
      }
      this.pending.clear(); this.emit('disconnected');
    };
    connection.on('disconnected', this.lost);
  }
  identity() { return {sessionId: this.record.id, generation: this.record.generation, clientId: this.clientId, epoch: this.record.epoch}; }
  async start(config, operationId = randomUUID()) {
    await this.connection.connect();
    this.record = await this.connection.request('session.create', {...config, clientId: this.clientId, operationId});
    if (!['starting', 'live'].includes(this.record.status)) throw Object.assign(Error('会话已中断，需要显式恢复 journal'), {code: 'session_interrupted'});
    this.beginPolling(); return this.record;
  }
  descriptor() { return {record: this.record, cursor: this.committedCursor, clientId: this.clientId}; }
  async attach({record, cursor = 0}, {takeover = false} = {}) {
    this.connection.off('disconnected', this.lost).on('disconnected', this.lost);
    await this.connection.connect(); this.record = record;
    this.record = await this.connection.request('session.attach', {...this.identity(), takeover});
    if (!['starting', 'live'].includes(this.record.status)) throw Object.assign(Error('远端 OMP 已退出'), {code: 'session_interrupted'});
    this.decoder = new FrameDecoder(); this.cursor = this.committedCursor = cursor;
    this.emit('questions', this.record.questions || []); this.beginPolling(); return this.record;
  }
  async resync() {
    this.lost();
    const record = await this.connection.request('session.attach', this.identity());
    await this.attach({record, cursor: record.latestCursor});
    const state = await this.request('get_state');
    const history = await this.messages();
    return {state, ...history, questions: this.record.questions || []};
  }
  beginPolling() {
    if (this.polling) return;
    this.polling = true;
    const generation = ++this.pollGeneration;
    const poll = async () => {
      try {
        const page = await this.connection.request('session.events', {...this.identity(), cursor: this.cursor});
        if (!this.polling || generation !== this.pollGeneration) return;
        for (const item of page.frames) {
          if (item.sequence !== this.cursor + 1) throw Object.assign(Error('远端事件不连续'), {code: 'resync_required'});
          const frame = this.decoder.push(item.frame);
          this.cursor = item.sequence;
          if (!frame) continue;
          this.committedCursor = item.sequence;
          if (frame.type === 'response' && frame.id?.startsWith('host-')) continue;
          if (frame.type === 'response' && typeof frame.id === 'string' && frame.id.startsWith('operation-')) {
            const key = frame.id.slice(10), pending = this.pending.get(key);
            if (pending) {
              this.pending.delete(key); clearTimeout(pending.timer);
              frame.success ? pending.resolve(frame.data) : pending.reject(Object.assign(Error(frame.error || 'OMP 请求失败'), {code: frame.code, operationId: key}));
              continue;
            }
          }
          this.emit('frame', frame);
        }
        if (page.status === 'exited' && page.cursor === page.latest) { this.lost(); return; }
        if (this.polling) { this.timer = setTimeout(poll, page.cursor < page.latest ? 0 : 100); this.timer.unref?.(); }
      } catch (error) {
        if (!this.polling || generation !== this.pollGeneration) return;
        this.lost(); this.emit('diagnostic', error);
      }
    };
    void poll();
  }
  request(type, extra = {}, {operationId = randomUUID(), timeoutMs = 45000} = {}) {
    if (!this.polling) return Promise.reject(Object.assign(Error('远端会话未连接'), {code: 'transport_lost'}));
    if (this.pending.has(operationId)) return Promise.reject(Error('操作正在等待确认'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.get(operationId) !== pending) return;
        this.pending.delete(operationId); reject(Object.assign(Error('OMP 响应超时，不能自动重发'), {operationId, code: 'operation_uncertain'}));
      }, timeoutMs);
      const pending = {resolve, reject, timer};
      this.pending.set(operationId, pending);
      this.connection.request('session.request', {...this.identity(), operationId, frame: {...extra, type}}).then(ack => {
        if (ack.replayed && this.pending.get(operationId) === pending) {
          clearTimeout(timer); this.pending.delete(operationId);
          reject(Object.assign(Error('该操作已有远端记录，请读取状态或重建快照'), {code: 'operation_recorded', operationId, status: ack.status}));
        }
      }).catch(error => {
        if (this.pending.get(operationId) !== pending) return;
        clearTimeout(timer); this.pending.delete(operationId); error.operationId = operationId; reject(error);
      });
    });
  }
  respond(frame, operationId = randomUUID()) {
    return this.connection.request('session.request', {...this.identity(), operationId, frame: {...frame, type: 'extension_ui_response'}});
  }
  messages() { return readMessages((type, extra) => this.request(type, extra)); }
  operationStatus(operationId) { return this.connection.request('operation.get', {operationId}); }
  detach() { this.lost(); this.connection.off('disconnected', this.lost); }
  async stop() {
    const result = await this.connection.request('session.stop', this.identity());
    this.detach(); return result;
  }
}
module.exports = {RemoteSession};
