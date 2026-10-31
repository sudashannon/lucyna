const {EventEmitter} = require('node:events');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {invocation} = require('./ssh-executor.cjs');
const {linuxPath} = require('./profile.cjs');
const PREFIX = 'LUCYNA_HOST_V1 ';
const MAX_FRAME = 2 * 1024 * 1024;

class HostConnection extends EventEmitter {
  constructor(config, installed, {execute = spawn} = {}) {
    super();
    if (installed.mode !== 'user-service' || installed.format !== 'frozen') throw Error('远端会话需要 frozen 用户服务');
    linuxPath(installed.entry); linuxPath(installed.state);
    this.config = config; this.installed = installed; this.execute = execute; this.pending = new Map();
  }
  async connect() {
    if (this.connecting) return this.connecting;
    if (this.child) return this.hello;
    this.connecting = this.open();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async open() {
    const call = invocation(this.config, [this.installed.entry, 'bridge', '--state', this.installed.state]);
    const child = this.execute(call.file, call.args, {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    this.child = child;
    let buffer = Buffer.alloc(0), diagnostics = 0;
    const lost = () => {
      if (this.child !== child) return;
      this.child = null;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(Object.assign(Error('SSH 已断开；已发送操作需查询确认，不能自动重发'), {code: 'transport_lost', uncertain: true}));
      }
      this.pending.clear(); this.emit('disconnected');
    };
    const invalid = () => { child.kill(); lost(); };
    this.markLost = lost;
    child.once('error', lost); child.once('close', lost);
    child.stdin.on('error', lost);
    child.stderr.on('data', data => { diagnostics += data.length; if (diagnostics > MAX_FRAME) invalid(); });
    child.stdout.on('data', data => {
      if (this.child !== child) return;
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        const end = buffer.indexOf(10);
        if (end < 0) { if (buffer.length > MAX_FRAME) invalid(); break; }
        if (end > MAX_FRAME) { invalid(); break; }
        const line = buffer.subarray(0, end).toString('utf8'); buffer = buffer.subarray(end + 1);
        if (!line.startsWith(PREFIX)) continue;
        try {
          const frame = JSON.parse(line.slice(PREFIX.length));
          const request = this.pending.get(frame.id);
          if (!request) continue;
          clearTimeout(request.timer); this.pending.delete(frame.id);
          if (frame.ok) request.resolve(frame.data);
          else request.reject(Object.assign(Error(frame.code || 'host_error'), {code: frame.code}));
        } catch { invalid(); break; }
      }
    });
    try {
      const hello = await this.request('hello', {protocolVersions: [1]});
      if (hello.installationId !== this.installed.installationId || hello.release !== this.installed.release ||
          hello.protocolVersion !== 1 || !hello.ompSessionsSupported) throw Error('远端服务身份或能力不匹配');
      this.hello = hello; return hello;
    } catch (error) { this.disconnect(); throw error; }
  }
  request(op, args = {}, timeoutMs = 45000) {
    if (!this.child) return Promise.reject(Object.assign(Error('SSH 未连接'), {code: 'transport_lost'}));
    if (this.pending.size >= 64) return Promise.reject(Error('远端请求过多'));
    const id = randomUUID(), payload = JSON.stringify({version: 1, id, op, args})+'\n';
    if (Buffer.byteLength(payload) > MAX_FRAME) return Promise.reject(Error('远端请求超过大小限制'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(Object.assign(Error('远端请求超时，执行结果需核对'), {code: 'request_timeout', uncertain: true}));
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      try { this.child.stdin.write(payload); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  disconnect() {
    const child = this.child;
    if (!child) return Promise.resolve();
    // EOF only detaches this bridge. session.stop is the explicit process-ending operation.
    child.stdin.end();
    this.markLost?.();
    const timer = setTimeout(() => child.kill(), 1500);
    timer.unref?.(); child.once('close', () => clearTimeout(timer));
    return new Promise(resolve => child.once('close', resolve));
  }
}
module.exports = {HostConnection};
