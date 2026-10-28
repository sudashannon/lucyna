const {randomUUID} = require('node:crypto');

// Own one terminal from admission through actual exit, including cancellable
// work discovery. A superseded start must never spawn a hidden WSL shell.
class TerminalSession {
  constructor({listWorks, createPty, send, closeTimeoutMs = 10000}) {
    Object.assign(this, {listWorks, createPty, send, closeTimeoutMs});
    this.record = null;
  }
  async start(root, dimensions = {}) {
    if (this.record) throw new Error('已有嵌入式 WSL 终端正在运行');
    const id = dimensions.requestId || randomUUID();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('无效终端请求');
    const record = {id, root, process: null, stopping: false};
    record.closed = new Promise(resolve => {record.resolveClosed = resolve;});
    this.record = record;
    try {
      const works = await this.listWorks();
      if (this.record !== record) throw new Error('终端启动已取消');
      if (!works.some(work => work.root === root && work.kind !== 'invalid')) throw new Error('无效工作根');
      const cols = Number.isInteger(dimensions.cols) ? Math.max(20, Math.min(300, dimensions.cols)) : 100;
      const rows = Number.isInteger(dimensions.rows) ? Math.max(5, Math.min(120, dimensions.rows)) : 28;
      const proc = record.process = this.createPty(root, {cols, rows});
      proc.onData(data => this.send({type: 'data', id, data}));
      proc.onExit(({exitCode, signal}) => {
        if (this.record === record) this.record = null;
        record.resolveClosed();
        this.send({type: 'exit', id, exitCode, signal});
      });
      return {id};
    } catch (error) {
      if (this.record === record) this.record = null;
      record.resolveClosed();
      throw error;
    }
  }
  async close(id) {
    const record = this.record;
    if (!record || record.id !== id) return false;
    if (!record.process) {
      this.record = null;
      record.resolveClosed();
      this.send({type: 'exit', id, cancelled: true});
      return true;
    }
    if (!record.stopping) {record.process.kill(); record.stopping = true;}
    let timer;
    try {
      await Promise.race([record.closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('终端尚未退出，请重试结束终端')), this.closeTimeoutMs);
      })]);
      return true;
    } catch (error) {record.stopping = false; throw error;}
    finally {clearTimeout(timer);}
  }
  input(id, data) {
    if (!this.record?.process || this.record.id !== id) throw new Error('终端会话已结束');
    if (typeof data !== 'string' || data.length > 256 * 1024) throw new Error('终端输入超出限制');
    this.record.process.write(data);
  }
  resize(id, cols, rows) {
    if (!this.record?.process || this.record.id !== id) return false;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new Error('无效终端尺寸');
    this.record.process.resize(Math.max(20, Math.min(300, cols)), Math.max(5, Math.min(120, rows)));
    return true;
  }
  dispose() {
    const record = this.record; this.record = null;
    if (record?.process) {try {record.process.kill();} catch {}}
    record?.resolveClosed();
  }
}
module.exports = {TerminalSession};
