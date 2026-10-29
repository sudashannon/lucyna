const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {randomUUID, createHash} = require('node:crypto');
const {toWslPath,wslUncPath} = require('./work-stele.cjs');
const runtime=require('./runtime-config.cjs');

const defaultWindowsOmp = path.join(process.env.LOCALAPPDATA || '', 'Tern', 'omp', 'bin', 'omp.exe');
const defaults = () => ({version:1, runtime:runtime.defaultRuntime, windowsExecutable:defaultWindowsOmp, wslExecutable:runtime.wslExecutable, wslAgentDir:runtime.wslAgentDir, model:'', thinking:'inherit'});
const linuxAbsolute = value => typeof value === 'string' && value.startsWith('/') && !/[\0\r\n\\]/.test(value) && !value.split('/').some(x => x === '..' || x === '.');
function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) throw new Error('客户端设置格式无效');
  if (!['windows','wsl'].includes(value.runtime)) throw new Error('请选择 Windows 或 WSL OMP');
  const text = key => {if(typeof value[key] !== 'string' || value[key].length > 2048 || /[\0\r\n]/.test(value[key])) throw new Error('设置字段无效：'+key); return value[key].trim();};
  const windowsExecutable = text('windowsExecutable'), wslExecutable = text('wslExecutable'), wslAgentDir = text('wslAgentDir'), model = text('model');
  if (!path.win32.isAbsolute(windowsExecutable) || !windowsExecutable.toLowerCase().endsWith('.exe')) throw new Error('Windows OMP 请填写完整的 .exe 路径');
  if (!linuxAbsolute(wslExecutable) || !linuxAbsolute(wslAgentDir)) throw new Error('WSL 程序和配置目录请填写 Linux 绝对路径');
  if (model && (!/^[^\s/]+\/[^\s]+$/.test(model) || model.length > 200)) throw new Error('默认模型请使用 provider/model 格式，或留空跟随 OMP');
  if (!['inherit','off','minimal','low','medium','high','xhigh','max','auto'].includes(value.thinking)) throw new Error('思考强度无效');
  return {version:1,runtime:value.runtime,windowsExecutable,wslExecutable,wslAgentDir,model,thinking:value.thinking};
}
function execute(file,args) {return new Promise((resolve,reject)=>execFile(file,args,{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:64*1024},(error,stdout)=>error?reject(new Error('环境检测失败：请检查 OMP 路径和 WSL 是否可用')):resolve(stdout.trim())));}
function wslArgs(settings, args, agentDir = settings.wslAgentDir) {
  const cwdIndex=args.indexOf('--cwd'),cwd=cwdIndex>=0?args[cwdIndex+1]:runtime.home;
  return [...runtime.wslPrefix,'--cd',cwd,'--','/usr/bin/python3',toWslPath(path.resolve(__dirname,'../tools/launch_wsl.py')),'--agent-dir',agentDir,settings.wslExecutable,...args];
}
async function checkSettings(input) {
  const settings=validateSettings(input), started=Date.now();
  const version = await execute(settings.runtime==='wsl'?'wsl.exe':settings.windowsExecutable, settings.runtime==='wsl'?wslArgs(settings,['--version']):['--version']);
  if (!/^omp\//.test(version)) throw new Error('所选程序没有返回 OMP 版本，请检查路径');
  let configFiles=[];
  if(settings.runtime==='wsl') {
    const source='import json,pathlib,sys; p=pathlib.Path(sys.argv[1]); assert p.is_dir(), "configuration directory missing"; print(json.dumps([n for n in ["config.yml","config.yaml","settings.json","models.yml","models.yaml","mcp.json","extensions","managed-skills","commands"] if (p/n).exists()]))';
    configFiles=JSON.parse(await execute('wsl.exe',[...runtime.wslPrefix,'--','python3','-c',source,settings.wslAgentDir]));
  }
  return {runtime:settings.runtime,version,configFiles,elapsedMs:Date.now()-started,note:'已检测程序版本与配置目录；模型认证、扩展和工具以实际会话为准。'};
}
function historyLocations(userData, runtime) {return {agentDir:path.join(userData,runtime==='wsl'?'wsl-agent':'agent'),historyDir:path.join(userData,runtime==='wsl'?'history-wsl':'history')};}
function sessionDirectory(agentDir, root) {return path.join(agentDir,'sessions',createHash('sha256').update(root).digest('hex').slice(0,20));}
function windowsSessionPath(value) {
  const match=typeof value==='string' && /^\/mnt\/([a-z])\/(.*)$/i.exec(value);
  return match ? `${match[1].toUpperCase()}:\\${match[2].replaceAll('/','\\')}` : typeof value==='string'&&value.startsWith('/')&&!value.startsWith('//') ? wslUncPath(value) : value;
}
function wslSessionPath(value) {
  if(linuxAbsolute(value)&&!value.startsWith('//'))return value;
  const linux=runtime.fromWslUnc(value);
  if(linux){if(!linuxAbsolute(linux))throw new Error('无效的 WSL session 路径');return linux;}
  return toWslPath(value);
}
class SettingsStore {
  constructor(userData){this.file=path.join(userData,'client-settings.json');this.value=null;}
  async get(){if(this.value)return {...this.value};try{this.value=validateSettings(JSON.parse(await fs.readFile(this.file,'utf8')));}catch(e){if(e.code!=='ENOENT')throw new Error('客户端设置无法读取，请检查 client-settings.json；原文件已保留');this.value=defaults();}return {...this.value};}
  async save(input){const next=validateSettings(input);await fs.mkdir(path.dirname(this.file),{recursive:true});let previous;try{previous=await fs.readFile(this.file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(previous)await fs.writeFile(`${this.file}.${Date.now()}-${randomUUID().slice(0,8)}.bak`,previous,{flag:'wx'});
    const temp=`${this.file}.${randomUUID()}.tmp`;try{await fs.writeFile(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx'});await fs.rename(temp,this.file);}finally{await fs.unlink(temp).catch(()=>{});}this.value=next;return {...next};}
}
module.exports={defaults,validateSettings,checkSettings,SettingsStore,historyLocations,sessionDirectory,wslArgs,toWslPath,windowsSessionPath,wslSessionPath};
