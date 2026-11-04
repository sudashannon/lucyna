// Portable, version-aware knowledge synchronization. The Git worktree is an
// internal staging area; it is never the live knowledge directory.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {execFile}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {hash,safeRelative}=require('./knowledge-library.cjs');
const runtime=require('./runtime-config.cjs');
const {toWslPath}=require('./work-stele.cjs');

const DEFAULT_REMOTE='git@github.com:sudashannon/knowledge_base.git';
const BRANCH='master',PREFIX='lucyna-knowledge',FORMAT=1;
// GitHub's documented public Ed25519 host key; this is not an access credential.
const GITHUB_HOST_KEY='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n';
function git(cwd,args,wsl=false,sshCommand){const executable=wsl?'wsl.exe':'git',argv=wsl?[...runtime.wslPrefix,'--','env','GIT_TERMINAL_PROMPT=0','git','-C',toWslPath(cwd),...args]:['-C',cwd,...args];return new Promise((resolve,reject)=>execFile(executable,argv,{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:4*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never',...(!wsl&&sshCommand&&!process.env.GIT_SSH_COMMAND?{GIT_SSH_COMMAND:sshCommand}:{})}},(e,out)=>{if(!e)return resolve(out.trim());const uncertain=!!(e.killed||e.signal||e.code==='ETIMEDOUT');return reject(Object.assign(Error(uncertain?'Git 操作状态尚未确认；请先核对同步进程和远端':'Git 同步失败，请检查仓库访问权限和网络连接'),{code:e.code,uncertain}));}));}
function validRemote(remote,allowLocal){if(allowLocal&&(path.isAbsolute(remote)||typeof remote==='string'&&/^file:\/\/\/mnt\/[a-z]\//i.test(remote)))return remote;if(typeof remote==='string'&&/^git@[a-z0-9.-]+:[a-z0-9._/-]+(?:\.git)?$/i.test(remote)&&!remote.includes('..'))return remote;let url;try{url=new URL(remote);}catch{throw Error('请输入 HTTPS 或 SSH Git 仓库地址');}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('仓库地址必须是 HTTPS 或 SSH，且不能包含凭据');return url.href.replace(/\/$/,'');}
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const prefix=(a,b)=>a.length<=b.length&&a.every((x,i)=>x.id===b[i].id&&x.hash===b[i].hash);
function validateManifest(data){
 if(!data||data.format!==FORMAT||!Array.isArray(data.documents)||data.documents.length>10000)throw Error('远端知识库清单格式无效');
 const categories=new Set(['知识','规范','计划','提案','任务','报告','设计','图表','资料','待分类']),seen=new Set(),ids=new Set(),revisionIds=new Set();for(const d of data.documents){safeRelative(d.path);const key=d.path.toLocaleLowerCase();if(!uuid(d.id)||ids.has(d.id)||!categories.has(d.path.split('/')[0])||seen.has(key)||!Array.isArray(d.versions)||!d.versions.length||d.versions.length>10000)throw Error('远端知识库清单存在重复路径或无效版本');if(d.provenance!==undefined&&(!d.provenance||typeof d.provenance!=='object'||Array.isArray(d.provenance)||JSON.stringify(d.provenance).length>32768))throw Error('远端知识来源无效');ids.add(d.id);seen.add(key);for(const v of d.versions){if(!v||!uuid(v.id)||revisionIds.has(v.id)||!/^[a-f0-9]{64}$/.test(v.hash)||!Number.isSafeInteger(v.size)||v.size<0||v.size>32*1024*1024||v.created!==undefined&&(typeof v.created!=='string'||Number.isNaN(Date.parse(v.created)))||v.origin!==undefined&&(typeof v.origin!=='string'||v.origin.length>100||/[\x00-\x1f]/.test(v.origin)))throw Error('远端知识库版本无效');revisionIds.add(v.id);}}
 return data;
}
function readObject(root,v){const file=path.join(root,PREFIX,'.history','objects',v.hash);for(const p of [path.join(root,PREFIX),path.join(root,PREFIX,'.history'),path.join(root,PREFIX,'.history','objects'),file])if(fs.lstatSync(p).isSymbolicLink())throw Error('远端知识库包含不安全的链接');const bytes=fs.readFileSync(file);if(bytes.length!==v.size||hash(bytes)!==v.hash)throw Error('远端知识库内容校验失败');return bytes;}
function projection(root,relative){let current=root;for(const part of safeRelative(relative).split('/')){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('同步目录不能包含链接');}return current;}
const yieldHost=()=>new Promise(resolve=>setImmediate(resolve));
async function localSnapshot(store){
 if(!store.isUnified())throw Error('请先完成内部知识库统一');const lib=store.list()[0],docs=store.db.prepare('SELECT * FROM documents WHERE library=? ORDER BY relative').all(lib.id),versions=store.db.prepare('SELECT * FROM revisions WHERE document=? ORDER BY rowid'),items=[];
 let count=0;for(const d of docs){if(++count%32===0)await yieldHost();safeRelative(d.relative);const records=versions.all(d.id).map(v=>{const bytes=fs.readFileSync(store.revisionPath(d.id,v.id));if(hash(bytes)!==v.hash)throw Error('本地历史版本校验失败：'+d.relative);return {id:v.id,hash:v.hash,size:bytes.length,created:v.created,origin:v.origin,bytes};});if(!records.length||records.at(-1).hash!==d.hash)throw Error('本地版本索引无效：'+d.relative);const file=path.join(lib.path,...d.relative.split('/'));if(!fs.existsSync(file)||hash(fs.readFileSync(file))!==d.hash)throw Error('本地文件在 Lucyna 外发生变化：'+d.relative);const origin=store.db.prepare('SELECT provenance FROM document_origins WHERE document=?').get(d.id);items.push({path:d.relative,document:d.id,revision:d.revision,versions:records,...(origin?{provenance:JSON.parse(origin.provenance)}:{})});}
 return {lib,items};
}
class KnowledgeSync {
 constructor(store,{allowLocal=false,onImported=async()=>{}}={}){this.store=store;this.allowLocal=allowLocal;this.onImported=onImported;this.wsl=allowLocal||process.platform!=='win32'?false:null;this.root=path.join(store.root,'sync');this.config=path.join(this.root,'config.json');this.running=null;}
 status(){let config={remote:DEFAULT_REMOTE};try{config=JSON.parse(fs.readFileSync(this.config,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('同步配置无法读取');}return {remote:config.remote,branch:BRANCH,running:!!this.running};}
 async configure(remote){if(this.running)throw Error('知识库同步正在进行');remote=validRemote(remote,this.allowLocal);await fsp.mkdir(this.root,{recursive:true});await fsp.writeFile(this.config,JSON.stringify({remote},null,2)+'\n',{mode:0o600});return this.status();}
 run(){if(this.running)throw Error('知识库同步正在进行');this.running=this.lockedExecute().finally(()=>{this.running=null;});return this.running;}
 async lockedExecute(){await fsp.mkdir(this.root,{recursive:true});const lock=path.join(this.root,'operation.lock'),owner={pid:process.pid,id:randomUUID()};let handle,uncertain=false;try{handle=await fsp.open(lock,'wx',0o600);await handle.writeFile(JSON.stringify(owner));await handle.sync();}catch(e){await handle?.close().catch(()=>{});if(e.code==='EEXIST'){let prior;try{prior=JSON.parse(await fsp.readFile(lock,'utf8'));}catch{}throw Error(prior?.uncertain?'上次 Git 操作状态尚未确认；请先核对同步进程和远端':'另一个知识同步正在运行，或上次同步需要恢复');}throw e;}try{return await this.execute();}catch(e){uncertain=!!e.uncertain;if(uncertain)await fsp.writeFile(lock,JSON.stringify({...owner,uncertain:true})).catch(()=>{});throw e;}finally{await handle.close().catch(()=>{});if(!uncertain)try{const existing=JSON.parse(await fsp.readFile(lock,'utf8'));if(existing.id===owner.id)await fsp.unlink(lock);}catch{}}}
 async chooseGit(){if(this.wsl!==null)return this.wsl;const available=(command,args)=>new Promise(resolve=>execFile(command,args,{windowsHide:true,timeout:15000,encoding:'utf8'},(error,stdout)=>resolve(!error&&/^git version /i.test(stdout.trim()))));if(await available('git',['--version']))return this.wsl=false;if(await available('wsl.exe',[...runtime.wslPrefix,'--exec','git','--version']))return this.wsl=true;throw Error('未找到 Git，请检查本机 Git 安装');}
 async execute(){
  const remote=validRemote(this.status().remote,this.allowLocal),parent=path.join(this.root,'repositories'),name=hash(Buffer.from(remote)).slice(0,24),repo=path.join(parent,name);await fsp.mkdir(parent,{recursive:true});
  const useWsl=await this.chooseGit();let sshCommand;
  if(!useWsl&&/^git@github\.com:/i.test(remote)){const known=path.join(this.root,'github-known-hosts');if(fs.existsSync(known)&&fs.lstatSync(known).isSymbolicLink())throw Error('GitHub 主机密钥文件不能是链接');await fsp.writeFile(known,GITHUB_HOST_KEY);const escaped=known.replaceAll('\\','/').replaceAll("'","'\\''");sshCommand=`ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile='${escaped}' -o ConnectTimeout=10`;}
  const run=(cwd,args)=>git(cwd,args,useWsl,sshCommand);
  if(!fs.existsSync(path.join(repo,'.git'))){if(fs.existsSync(repo))throw Error('同步目录已经存在，请先检查');await run(parent,['clone','--filter=blob:none','--no-checkout','--single-branch','--branch',BRANCH,'--',remote,name]);await run(repo,['sparse-checkout','init','--cone']);await run(repo,['sparse-checkout','set',PREFIX]);await run(repo,['checkout',BRANCH]);}
  if((await run(repo,['remote','get-url','origin']))!==remote)throw Error('同步目录绑定的仓库不一致');
  if(await run(repo,['status','--porcelain','--untracked-files=all']))throw Error('同步目录中有未完成的更改，请先检查');
  await run(repo,['fetch','origin',BRANCH]);await run(repo,['merge','--ff-only','origin/'+BRANCH]);
  const dir=path.join(repo,PREFIX),meta=path.join(dir,'.history'),manifestFile=path.join(meta,'manifest.json');let remoteData={format:FORMAT,documents:[]};
  if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw Error('远端同步目录不能是链接');
  if(fs.existsSync(meta)&&fs.lstatSync(meta).isSymbolicLink())throw Error('远端历史目录不能是链接');
  if(fs.existsSync(dir)&&!fs.existsSync(manifestFile)&&fs.readdirSync(dir).length)throw Error('远端已有同名目录但没有 Lucyna 同步清单，原内容已保留');
  if(fs.existsSync(path.join(meta,'objects'))&&fs.lstatSync(path.join(meta,'objects')).isSymbolicLink())throw Error('远端版本目录不能是链接');
  if(fs.existsSync(manifestFile)){if(fs.lstatSync(manifestFile).isSymbolicLink())throw Error('远端清单不能是链接');const bytes=fs.readFileSync(manifestFile);if(bytes.length>32*1024*1024)throw Error('远端清单过大');remoteData=validateManifest(JSON.parse(bytes.toString('utf8')));}
  const result=await this.store.serial(async()=>{
   const {lib,items}=await localSnapshot(this.store),local=new Map(items.map(d=>[d.path.toLocaleLowerCase(),d])),external=new Map(remoteData.documents.map(d=>[d.path.toLocaleLowerCase(),d])),conflicts=[];
   let checked=0;for(const [key,r] of external){if(++checked%32===0)await yieldHost();const l=local.get(key),visible=projection(dir,r.path),identity=this.store.doc(r.id);if(!fs.existsSync(visible)||hash(fs.readFileSync(visible))!==r.versions.at(-1).hash||identity&&identity.relative!==r.path||l&&(l.document!==r.id||l.path!==r.path||!prefix(l.versions,r.versions)&&!prefix(r.versions,l.versions)))conflicts.push(r.path);}
   for(const [key,l] of local)if(!external.has(key)&&fs.existsSync(projection(dir,l.path)))conflicts.push(l.path);
   if(conflicts.length)return {conflicts,imported:0,exported:0};
   // Validate every incoming object before changing any live document.
   for(const [key,r] of external){const l=local.get(key),start=l?l.versions.length:0;for(const v of r.versions.slice(start)){if(this.store.db.prepare('SELECT 1 FROM revisions WHERE id=?').get(v.id))throw Error('远端版本标识与本地记录冲突：'+r.path);readObject(repo,v);}}
   let imported=0;for(const [key,r] of external){let l=local.get(key);const start=l?l.versions.length:0;for(const v of r.versions.slice(start)){if(imported&&imported%16===0)await yieldHost();const saved=this.store.writeSync({library:lib.id,relative:r.path,...(l?{document:l.document}:{}),bytes:readObject(repo,v),expected:l?l.revision:'new',origin:'sync',syncIdentity:{document:r.id,revision:v.id},...(!l&&r.provenance?{provenance:r.provenance}:{})});if(v.created||v.origin)this.store.db.prepare('UPDATE revisions SET created=?, origin=? WHERE id=?').run(v.created||new Date().toISOString(),v.origin||'sync',saved.revision);l={path:r.path,document:saved.id,revision:saved.revision};imported++;}}
   const snapshot=await localSnapshot(this.store);fs.mkdirSync(path.join(meta,'objects'),{recursive:true});const documents=[];let processed=0;for(const d of snapshot.items){if(++processed%32===0)await yieldHost();const versions=[];for(const v of d.versions){const target=path.join(meta,'objects',v.hash);if(fs.existsSync(target)){if(fs.lstatSync(target).isSymbolicLink()||hash(fs.readFileSync(target))!==v.hash)throw Error('同步对象校验失败');}else fs.writeFileSync(target,v.bytes,{flag:'wx'});versions.push({id:v.id,hash:v.hash,size:v.size,created:v.created,origin:v.origin});}const visible=projection(dir,d.path);fs.mkdirSync(path.dirname(visible),{recursive:true});fs.writeFileSync(visible,d.versions.at(-1).bytes);documents.push({id:d.document,path:d.path,versions,...(d.provenance?{provenance:d.provenance}:{})});}documents.sort((a,b)=>a.path.localeCompare(b.path,'en'));fs.writeFileSync(manifestFile,JSON.stringify({format:FORMAT,documents},null,2)+'\n');return {conflicts:[],imported,exported:documents.length};
  });
  if(result.conflicts.length)return {...result,action:'conflict'};
  if(result.imported)await this.onImported();
  await run(repo,['add','-f','--',PREFIX]);if(await run(repo,['status','--porcelain','--',PREFIX]))await run(repo,['-c','user.name=Lucyna','-c','user.email=lucyna@localhost','commit','-m','Sync Lucyna knowledge','--',PREFIX]);
  await run(repo,['push','origin','HEAD:'+BRANCH]);return {...result,action:'synced'};
 }
}
module.exports={KnowledgeSync,DEFAULT_REMOTE,validateManifest,prefix};
