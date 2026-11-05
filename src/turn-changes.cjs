const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createHash, randomUUID} = require('node:crypto');
const {journalIdentity} = require('./work-assistant-sources.cjs');
const {turnMessageKey} = require('./turn-message-key.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const maxReviews = 30;
const maxOutput = 4 * 1024 * 1024;
const validId = id => typeof id === 'string' && /^(user|skill)-[0-9]{1,16}$/.test(id);

function launchCapture(root, runtime) {
  const file = path.join(__dirname, 'turn-changes.py');
  const script = runtime.fromWslUnc(file)
    || file.replace(/^([A-Za-z]):/, (_, drive) => '/mnt/' + drive.toLowerCase()).replaceAll('\\', '/');
  const child = spawn('wsl.exe', [...runtime.wslPrefix, '--exec', 'python3', script, root],
    {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
  let ready, ended, output = '';
  const baseline = new Promise(resolve => {ready = resolve;});
  const result = new Promise(resolve => {ended = resolve;});
  const cancel = () => {
    ready(false);
    ended(null);
    child.stdin.destroy();
  };
  child.stdin.on('error', cancel);
  child.on('error', cancel);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.length > maxOutput) {
      output = '';
      cancel();
    } else if (output.startsWith('ready\n')) ready(true);
  });
  child.on('close', code => {
    ready(false);
    if (code !== 0 || !output.startsWith('ready\n')) return ended(null);
    try { ended(JSON.parse(output.slice(6))); }
    catch { ended(null); }
  });
  return {baseline, cancel, finish: () => {
    child.stdin.end('finish\n');
    return result;
  }};
}

async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => {timer = setTimeout(resolve, ms);})]); }
  finally { clearTimeout(timer); }
}

class TurnChanges {
  constructor({directory, runtime, launch = root => launchCapture(root, runtime)}) {
    this.directory = directory;
    this.launch = launch;
    this.active = new WeakMap();
    this.finishing = new Map();
    this.writes = new Map();
    this.jobs = new Set();
  }

  folder(root, file) {
    return path.join(this.directory, hash(root), journalIdentity(file));
  }

  async begin(record, emit) {
    if (!record.sessionFile || record.creation || !record.root || this.active.has(record)) return;
    const {root, sessionFile} = record;
    const capture = {root, sessionFile, startedAt: Date.now(), emit};
    this.active.set(record, capture);
    try {
      const prior = this.finishing.get(root);
      if (prior) {
        await within(prior.task, 3000);
        if (this.finishing.get(root) === prior) prior.cancel();
      }
      if (this.active.get(record) !== capture || record.root !== root || record.sessionFile !== sessionFile) return false;
      capture.process = this.launch(root);
      if (await within(capture.process.baseline, 3500) !== true) {
        capture.process.cancel();
        capture.process = undefined;
      }
    } catch {
      capture.process?.cancel();
      capture.process = undefined;
    }
    return this.active.get(record) === capture ? capture : false;
  }

  cancel(record, beforePromptOnly = false, expected) {
    const capture = this.active.get(record);
    if (!capture || (expected && capture !== expected) || (beforePromptOnly && capture.sent)) return;
    this.active.delete(record);
    capture.process?.cancel();
  }

  sent(record, expected) {
    const capture = this.active.get(record);
    if (capture && capture === expected) capture.sent = true;
  }

  observe(record, event) {
    if (event.type === 'process_exit' || event.type === 'process_error') {
      this.cancel(record);
      return;
    }
    const capture = this.active.get(record);
    if (!capture?.sent) return;
    if (event.type === 'message_start' || event.type === 'message_end') {
      const key = turnMessageKey(event.message);
      if (key) {
        if (!capture.messageId) capture.messageId = key;
        else if (capture.messageId !== key || event.type === 'message_start') capture.multiple = true;
      }
    }
    if (event.type === 'session_settled' || event.type === 'prompt_result' && event.sessionSettled === true) {
      this.active.delete(record);
      if (capture.multiple || !capture.messageId || record.root !== capture.root || record.sessionFile !== capture.sessionFile) {
        capture.process?.cancel();
        return;
      }
      this.finish(capture);
    }
  }

  finish(capture) {
    const {root, sessionFile, process: child, messageId, startedAt, emit} = capture;
    if (!child) return;
    const finishedAt = Math.max(startedAt, Date.now());
    const cancel = () => child.cancel();
    const previous = this.finishing.get(root);
    previous?.cancel();
    const job = {cancel};
    this.finishing.set(root, job);
    job.task = (async () => {
      try {
        const snapshot = await within(child.finish(), 12000);
        if (!snapshot || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.warnings)
          || (!snapshot.files.length && !snapshot.warnings.length)) return;
        await this.save(root, sessionFile, {messageId, startedAt, finishedAt, ...snapshot});
        emit({type: 'turn_changes_ready'});
      } finally {
        cancel();
        if (this.finishing.get(root) === job) this.finishing.delete(root);
        this.jobs.delete(job);
      }
    })().catch(error => console.error('Turn changes:', error.code || error.name));
    this.jobs.add(job);
  }

  drain() { return Promise.allSettled([...this.jobs].map(job => job.task)); }

  async save(root, file, snapshot) {
    const folder = this.folder(root, file);
    const prior = this.writes.get(folder);
    const pending = (async () => {
      await prior?.catch(() => {});
      await fs.mkdir(folder, {recursive: true, mode: 0o700});
      const target = path.join(folder, hash(snapshot.messageId) + '.json');
      const temporary = target + '.' + randomUUID() + '.tmp';
      try {
        const summary = {
          messageId: snapshot.messageId,
          files: snapshot.files.length,
          partial: !!snapshot.warnings.length || snapshot.files.some(file => file.omitted),
        };
        await fs.writeFile(temporary, JSON.stringify(summary) + '\n' + JSON.stringify(snapshot), {flag: 'wx', mode: 0o600});
        await fs.rename(temporary, target);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      const entries = await this.entries(folder);
      await Promise.all(entries.slice(maxReviews).map(entry => fs.unlink(path.join(folder, entry.name)).catch(() => {})));
    })();
    this.writes.set(folder, pending);
    try { await pending; }
    finally { if (this.writes.get(folder) === pending) this.writes.delete(folder); }
  }

  async entries(folder) {
    const names = await fs.readdir(folder).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const entries = await Promise.all(names.filter(name => /^[0-9a-f]{64}\.json$/.test(name)).map(async name => {
      const stat = await fs.lstat(path.join(folder, name)).catch(() => null);
      return stat?.isFile() && stat.size <= maxOutput ? {name, at: stat.mtimeMs} : null;
    }));
    return entries.filter(Boolean).sort((a, b) => b.at - a.at);
  }

  async read(record, messageId) {
    if (!record?.sessionFile || !validId(messageId)) return null;
    const folder = this.folder(record.root, record.sessionFile);
    const file = path.join(folder, hash(messageId) + '.json');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > maxOutput) return null;
      const content = await fs.readFile(file, 'utf8');
      const value = JSON.parse(content.slice(content.indexOf('\n') + 1));
      return value.messageId === messageId ? value : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(record) {
    if (!record?.sessionFile) return [];
    const folder = this.folder(record.root, record.sessionFile);
    const entries = (await this.entries(folder)).slice(0, maxReviews);
    const rows = await Promise.all(entries.map(async ({name}) => {
      let handle;
      try {
        handle = await fs.open(path.join(folder, name), 'r');
        const header = Buffer.alloc(256);
        const {bytesRead} = await handle.read(header);
        const newline = header.subarray(0, bytesRead).indexOf(10);
        if (newline < 0) return null;
        const summary = JSON.parse(header.subarray(0, newline).toString('utf8'));
        return validId(summary.messageId) ? summary : null;
      } catch { return null; }
      finally { await handle?.close(); }
    }));
    return rows.filter(Boolean);
  }
}

module.exports = {TurnChanges};
