const fs = require('node:fs/promises');
const path = require('node:path');
const {runSSH} = require('./ssh-executor.cjs');
const {validateSsh, linuxPath} = require('./profile.cjs');
const {digest} = require('../../tools/build-host-bundle.cjs');
const PREFIX = 'LUCYNA_HOST_V1 ';
const HASH = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE = 96 * 1024 * 1024;
const PROBE = 'set -eu; fail() { printf \'LUCYNA_HOST_V1 {"ok":false,"code":"%s"}\\n\' "$1"; exit 0; }; '+
  'test "$(uname -s)" = Linux || fail unsupported_platform; '+
  'for tool in uname id getconf stat mktemp head tar gzip sha256sum mkdir rm; do command -v "$tool" >/dev/null || fail bootstrap_tool_missing; done; '+
  'arch=$(uname -m); case "$arch" in x86_64|aarch64) ;; *) fail unsupported_arch ;; esac; '+
  'libc=$(getconf GNU_LIBC_VERSION) || fail unsupported_libc; libc=${libc#glibc }; '+
  'printf \'LUCYNA_HOST_V1 {"ok":true,"platform":"Linux","arch":"%s","glibc":"%s"}\\n\' "$arch" "$libc"';

function response(output) {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith(PREFIX));
  if (lines.length !== 1) throw Error('远端响应格式无效');
  const value = JSON.parse(lines[0].slice(PREFIX.length));
  if (!value.ok) throw Object.assign(Error('远端准备失败：' + (value.code || 'unknown')), {code: value.code});
  return value;
}

function version(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+$/.test(value)) throw Error('无效 glibc 版本');
  return value.split('.').map(Number);
}

async function loadArtifact(indexPath) {
  const text = await fs.readFile(indexPath, 'utf8');
  if (text.length > 65536) throw Error('制品索引过大');
  const index = JSON.parse(text);
  if (index.version !== 2 || index.format !== 'pyinstaller-onedir' || !HASH.test(index.release) || !HASH.test(index.sha256) ||
      index.target?.os !== 'Linux' || !['x86_64', 'aarch64'].includes(index.target.arch) ||
      index.archive !== `host-linux-${index.target.arch}.tar.gz` || !Number.isSafeInteger(index.bytes) ||
      index.bytes <= 0 || index.bytes > MAX_ARCHIVE) throw Error('无效 frozen host 制品');
  version(index.target.glibcMin);
  const archive = path.join(path.dirname(indexPath), index.archive);
  const stat = await fs.stat(archive);
  if (stat.size !== index.bytes) throw Error('host 制品长度不匹配');
  const bytes = await fs.readFile(archive);
  if (digest(bytes) !== index.sha256) throw Error('host 制品摘要不匹配');
  return {index, bytes};
}

async function deployFrozen(input, indexPath, {mode = 'user-service', prefix, signal, onProgress = () => {}, execute = runSSH} = {}) {
  const config = validateSsh(input);
  if (!['connection', 'user-service'].includes(mode)) throw Error('未知 host 模式');
  if (prefix) linuxPath(prefix);
  const {index, bytes} = await loadArtifact(indexPath);
  signal?.throwIfAborted();
  onProgress({phase: 'probing'});
  const probe = response(await execute(config, ['sh', '-c', PROBE], {signal, timeoutMs: 30000}));
  const actual = version(probe.glibc), minimum = version(index.target.glibcMin);
  if (probe.platform !== index.target.os || probe.arch !== index.target.arch ||
      actual[0] < minimum[0] || (actual[0] === minimum[0] && actual[1] < minimum[1])) {
    throw Object.assign(Error('没有匹配远端架构/glibc 的 host 制品'), {code: 'artifact_platform_mismatch'});
  }
  // This script and archive digest are bundled by the trusted desktop, never supplied by the host.
  const script = (await fs.readFile(path.join(__dirname, '../../tools/lucyna-host/bootstrap.sh'), 'utf8'))
    .split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).join(' ');
  onProgress({phase: 'transferring', bytes: index.bytes});
  const installed = response(await execute(config, ['sh', '-c', script, 'lucyna-bootstrap', index.sha256,
    index.release, String(index.bytes), mode, prefix || ''], {input: bytes, signal, timeoutMs: 180000}));
  if (installed.release !== index.release || installed.mode !== mode || installed.format !== 'frozen' ||
      typeof installed.installationId !== 'string') throw Error('远端安装身份不匹配');
  linuxPath(installed.entry); linuxPath(installed.state);
  onProgress({phase: 'verifying'});
  const request = {version: 1, id: 'deployment-health', op: 'hello', args: {protocolVersions: [1]}};
  const reply = response(await execute(config, [installed.entry, mode === 'user-service' ? 'bridge' : 'stdio', '--state', installed.state],
    {input: JSON.stringify(request) + '\n', signal, timeoutMs: 30000}));
  const hello = reply.data;
  if (reply.id !== request.id || hello?.release !== index.release || hello.installationId !== installed.installationId || hello.protocolVersion !== 1) {
    throw Error('host 握手身份不匹配');
  }
  onProgress({phase: 'ready'});
  return {...installed, hello};
}

module.exports = {deployFrozen, loadArtifact, PROBE, MAX_ARCHIVE};
