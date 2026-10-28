const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

async function ensureOwnedAgentDir(userData, agentDir) {
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  const stat = await fs.lstat(agentDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('客户端 agent 目录不能是链接');
  const realRoot = await fs.realpath(userData);
  const realAgent = await fs.realpath(agentDir);
  const relative = path.relative(realRoot, realAgent);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('客户端 agent 目录不属于本应用数据目录');
  const defaultDir = path.join(os.homedir(), '.omp', 'agent');
  const realDefault = await fs.realpath(defaultDir).catch(error => error.code === 'ENOENT' ? path.resolve(defaultDir) : Promise.reject(error));
  const globalRelative = path.relative(realDefault, realAgent);
  if (!globalRelative || (!globalRelative.startsWith('..') && !path.isAbsolute(globalRelative))) throw new Error('客户端配置不能覆盖原有 Windows OMP 用户目录');
  return realAgent;
}
module.exports = { ensureOwnedAgentDir };
