'use strict';

const path = require('node:path');
const {spawn} = require('node:child_process');
const runtime = require('./runtime-config.cjs');

const MAX_OUTPUT = 4 * 1024 * 1024;
const scriptPath = path.join(__dirname, 'code-review-snapshot.py');
const toWsl = file => runtime.fromWslUnc(file)
  || file.replace(/^([A-Za-z]):/, (_, drive) => '/mnt/' + drive.toLowerCase()).replaceAll('\\', '/');

function publicError(message) {
  return Object.assign(Error(message), {publicMessage: message});
}

function defaultLaunch(file, options) {
  return spawn('wsl.exe', [...runtime.wslPrefix, '--exec', 'python3', toWsl(file)], options);
}

function abortError(signal, fallback = '工作区审查快照已取消') {
  return signal?.reason instanceof Error ? signal.reason : publicError(fallback);
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw publicError('无效工作区快照请求');
  const {root, member, scope = 'all'} = input;
  if (typeof root !== 'string' || root.length > 4096 || !root.startsWith('/') || /[\0\r\n]/.test(root)
    || root.split('/').includes('..')) throw publicError('无效工作根');
  if (typeof member !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(member)) throw publicError('无效 Git 成员');
  if (!['all', 'staged', 'unstaged'].includes(scope)) throw publicError('无效改动范围');
  return {root, member, scope};
}

function createCodeReviewSnapshot({launch = defaultLaunch, timeoutMs = 30000, killGraceMs = 1500, maxOutput = MAX_OUTPUT} = {}) {
  if (typeof launch !== 'function') throw TypeError('launch must be a function');
  return function captureWorkspace(input, signal) {
    let request;
    try { request = validateInput(input); }
    catch (error) { return Promise.reject(error); }
    if (signal?.aborted) return Promise.reject(abortError(signal));

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = launch(scriptPath, {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      } catch {
        reject(publicError('无法启动本机工作区快照服务'));
        return;
      }

      const stdout = [];
      let stdoutBytes = 0;
      let processError;
      let cancelReason;
      let settled = false;
      let hardKillTimer;
      const timeout = setTimeout(() => cancel(publicError('工作区快照读取超时')), timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(hardKillTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        error ? reject(error) : resolve(value);
      };
      const cancel = reason => {
        if (cancelReason || settled) return;
        cancelReason = reason;
        // EOF is the cooperative cancellation signal. Python then terminates
        // only the Git child it owns and exits after that child has exited.
        try { child.stdin.end(); } catch {}
        hardKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        }, killGraceMs);
      };
      const onAbort = () => cancel(abortError(signal));

      child.once('error', error => {
        processError = error;
        // A spawn failure has no owned process whose exit we need to await.
        if (child.pid === undefined) finish(publicError('无法启动本机工作区快照服务'));
      });
      child.stdout.on('data', chunk => {
        if (cancelReason || settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutput) {
          cancel(publicError('工作区快照结果超过记录上限'));
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.resume();
      child.once('close', code => {
        if (cancelReason) return finish(cancelReason);
        if (processError) return finish(publicError('工作区快照进程异常退出'));
        let result;
        try { result = JSON.parse(Buffer.concat(stdout).toString('utf8')); }
        catch { return finish(publicError('工作区快照返回无效数据')); }
        if (code !== 0 || result?.success !== true || !result.snapshot) {
          return finish(publicError(typeof result?.error === 'string' ? result.error : '工作区快照读取失败'));
        }
        finish(null, result.snapshot);
      });
      signal?.addEventListener('abort', onAbort, {once: true});
      if (signal?.aborted) onAbort();
      if (!cancelReason) {
        child.stdin.on('error', error => {
          if (error.code !== 'EPIPE' && !cancelReason && !settled) cancel(publicError('无法向工作区快照服务发送请求'));
        });
        child.stdin.write(JSON.stringify(request) + '\n', 'utf8');
      }
    });
  };
}

const captureWorkspace = createCodeReviewSnapshot();
module.exports = {captureWorkspace, createCodeReviewSnapshot};
