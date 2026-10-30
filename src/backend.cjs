const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const http = require('node:http');
const path = require('node:path');
const {wslArgs, wslSessionPath, toWslPath} = require('./client-settings.cjs');
const {FrameDecoder, readMessages} = require('./native-rpc.cjs');
const runtime=require('./runtime-config.cjs');
const {boundedExec:execFileAsync}=require('./bounded-exec.cjs');

const WORK_ROOT = runtime.workRoot;
const WORK_HELPER = runtime.skillDirectory+'/worktree-session/scripts/worktree-work.py';
const defaultOmp = path.join(process.env.LOCALAPPDATA || '', 'Tern', 'omp', 'bin', 'omp.exe');

let workCache, workCacheTime = 0, workInFlight;
async function listWorks({refresh = false} = {}) {
  if (!refresh && workCache && Date.now() - workCacheTime < 15000) return workCache;
  if (workInFlight) return workInFlight;
  workInFlight = (async () => {
    let stdout;
    try {stdout = await execFileAsync('wsl.exe', [...runtime.wslPrefix, '--', 'python3', toWslPath(path.join(__dirname, 'work-inventory.py')), '--root', WORK_ROOT]);}
    catch (error) {throw new Error('无法读取 WSL 工作区。请检查 runtime.local.json 和 WSL，再刷新工作区重试。\n' + error.message);}
    const result = JSON.parse(stdout);
    if (!Array.isArray(result)) throw new Error('工作根扫描返回了无效数据');
    workCache = result; workCacheTime = Date.now(); return result;
  })();
  try { return await workInFlight; } finally { workInFlight = null; }
}

function wslUnc(linuxPath) {
  if (typeof linuxPath !== 'string' || !linuxPath.startsWith(WORK_ROOT+'/') || linuxPath.includes('\0') || linuxPath.includes('\\') || linuxPath.split('/').includes('..')) throw new Error('请选择已发现的 WSL work 工作根');
  return '\\\\wsl.localhost\\'+runtime.distro + linuxPath.replaceAll('/', '\\');
}

function steleCall(name, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } });
    const req = http.request({ hostname: '127.0.0.1', port: 18989, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body) }, timeout: 20000 }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; if (text.length > 4 * 1024 * 1024) req.destroy(new Error('Stele response too large')); });
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error(`Stele HTTP ${res.statusCode}`); const data = JSON.parse(text); if (data.error || data.result?.isError) throw new Error(data.error?.message || data.result.content?.map(x => x.text).join('\n') || 'Stele call failed'); resolve(data.result); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('Stele request timed out'))); req.on('error', reject); req.end(body);
  });
}

class OmpSession {
  constructor(send, executable = defaultOmp) { this.send = send; this.executable = executable; this.pending = new Map(); this.child = null; this.ready = false; }
  async start({ root, executionRoot, resume, fork, model, agentDir, env: extraEnv, settings, sessionDir, signal }) {
    signal?.throwIfAborted();
    if (this.child) throw new Error('已有活动 OMP 进程；请先关闭当前会话');
    const works = await listWorks();
    signal?.throwIfAborted();
    if (this.child) throw new Error('已有活动 OMP 进程；请先关闭当前会话');
    if (!works.some(x => x.root === root && x.kind !== 'invalid')) throw new Error('工作根不存在、无效或不在已发现的 work 列表中');
    if (executionRoot && executionRoot !== root && !executionRoot.startsWith(root + '/')) throw new Error('会话工作目录不属于所选 work');
    const isWsl = settings?.runtime === 'wsl';
    const cwd = isWsl ? executionRoot || root : wslUnc(executionRoot || root);
    const args = ['--mode', 'rpc-ui', '--cwd', cwd];
    if (!isWsl) args.push('--append-system-prompt', `This OMP process runs on Windows. The work root and repositories are in ${runtime.distro} WSL. Before handling work lifecycle or persistent knowledge, load the installed worktree-session skill and use the Stele MCP work_skill tool for its WSL-specific references. Use wsl.exe -d ${runtime.distro} -u ${runtime.user} for Linux commands with an explicit Linux working directory. Do not assume built-in tools, scripts, LSP, or subagents run inside WSL; check their execution context. Respect the worktree-session approval and preservation boundaries.`);
    if (resume) args.push(fork?'--fork':'--resume', isWsl ? wslSessionPath(resume) : resume);
    if (sessionDir) args.push('--session-dir', isWsl ? wslSessionPath(sessionDir) : sessionDir);
    if (model) args.push('--model', model);
    if (settings?.thinking && settings.thinking !== 'inherit') args.push('--thinking', settings.thinking);
    const env = { ...process.env, ...(extraEnv || {}) };
    if (agentDir && !isWsl) { env.PI_CODING_AGENT_DIR = agentDir; env.OMP_PROFILE = ''; }
    if (isWsl) {delete env.PI_CODING_AGENT_DIR; delete env.OMP_PROFILE;}
    this.child = spawn(isWsl ? 'wsl.exe' : settings?.windowsExecutable || this.executable, isWsl ? wslArgs(settings,args) : args, { cwd: isWsl ? path.resolve(__dirname,'..') : cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const proc = this.child;
    const decoder=new FrameDecoder();
    readline.createInterface({ input: proc.stdout }).on('line', line => {
      try {
        const event=decoder.push(JSON.parse(line));if(!event)return;
        if(event.type==='ready') {
          this.ready=true;
          if(event.supportedProtocolVersions?.includes(2)) {
            void this.request('negotiate_protocol',{protocolVersion:2})
              .then(()=>this.request('set_event_filter',{events:null,messageUpdates:'delta'}).catch(()=>{}))
              .then(()=>{if(this.child===proc)this.send(event);}).catch(e=>{this.send({type:'diagnostic',message:e.message});if(this.child===proc)this.send(event);});
            return;
          }
        }
        if(event.type==='response'&&this.pending.has(event.id)) {
          const {resolve,reject,timer}=this.pending.get(event.id);clearTimeout(timer);this.pending.delete(event.id);
          if(event.success)resolve(event.data);else reject(Object.assign(new Error(event.error||'OMP 请求失败'),{code:event.code}));
          return; // RPC results already cross IPC as replies; do not broadcast large histories twice.
        }
        this.send(event);
      } catch(e) {this.send({type:'diagnostic',message:'OMP 协议读取失败：'+e.message});}
    });
    proc.stderr.on('data', b => this.send({ type: 'stderr', message: b.toString('utf8').slice(-3000) }));
    proc.stdin.on('error',e=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();this.send({type:'diagnostic',message:'OMP 输入连接已关闭：'+e.message});});
    proc.on('error', e => this.send({ type: 'process_error', message: e.message }));
    proc.on('close', (code, signal) => { if (this.child === proc) this.child = null; this.ready = false; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('OMP 进程已退出')); } this.pending.clear(); this.send({ type: 'process_exit', code, signal }); });
    return { cwd, pid: proc.pid, runtime: isWsl ? 'wsl' : 'windows' };
  }
  sendFrame(frame) { if (!this.child || !this.child.stdin.writable) throw new Error('OMP 尚未启动'); this.child.stdin.write(JSON.stringify(frame) + '\n'); }
  messages() {return readMessages((type,data)=>this.request(type,data));}
  request(type, extra = {}, timeoutMs = 30000) { const id = randomUUID(); return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${type} 超时`)); }, timeoutMs); this.pending.set(id, { resolve, reject, timer }); try { this.sendFrame({ ...extra, id, type }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); } }); }
  close() {
    const child = this.child;
    if (!child) return Promise.resolve();
    // Do not acknowledge New Chat until the old native process has actually exited.
    // This prevents rapid close/start from racing two writes to a session.
    return new Promise((resolve, reject) => {
      const closed = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.removeListener('close', closed); reject(new Error('OMP 尚未退出，请稍候再试')); }, 10000);
      child.once('close', closed);
      child.stdin.end();
    });
  }
}

module.exports = { WORK_ROOT, WORK_HELPER, defaultOmp, listWorks, wslUnc, steleCall, OmpSession };
