const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createHash,randomUUID}=require('node:crypto');
const {windowsSessionPath,wslSessionPath}=require('./client-settings.cjs');
const {toWslPath}=require('./work-stele.cjs'),{spawn}=require('node:child_process'),runtimeConfig=require('./runtime-config.cjs');
const LIMIT=4*1024*1024,PREFIX=/^paste-lucyna-[a-f0-9]{32}\.md$/;
const filename=text=>'paste-lucyna-'+createHash('sha256').update(text).digest('hex').slice(0,32)+'.md';
function validateAttachments(files){
  if(!Array.isArray(files)||files.length>8)throw Error('文本附件数量无效，最多 8 份');
  let bytes=0;const ids=new Set();
  return files.map(file=>{
    if(!file||typeof file.id!=='string'||! /^[a-zA-Z0-9-]{1,100}$/.test(file.id)||ids.has(file.id)||typeof file.text!=='string'||!file.text.length)throw Error('文本附件格式无效');
    ids.add(file.id);bytes+=Buffer.byteLength(file.text);if(bytes>LIMIT)throw Error('文本附件合计最多 4 MiB');
    return {id:file.id,text:file.text};
  });
}
// Matches OMP v18.13.3 resolveLocalRoot. Paths come only from the live native
// get_state response. WSL UNC accesses the original Linux files, not a copy.
function attachmentRoots({sessionFile,sessionId,runtime},temp=os.tmpdir()){
  if(typeof sessionFile!=='string'||!sessionFile.endsWith('.jsonl')||!sessionId||!['wsl','windows'].includes(runtime))throw Error('OMP 尚未返回可保存附件的原生会话');
  const nativeFile=runtime==='wsl'?wslSessionPath(sessionFile):sessionFile;
  const flavor=runtime==='wsl'?path.posix:path.win32;
  if(!flavor.isAbsolute(nativeFile))throw Error('原生会话路径无效');
  const canonical=flavor.join(nativeFile.slice(0,-6),'local');
  const safe=String(sessionId).replace(/[^a-zA-Z0-9_.-]/g,'_');
  const local=runtime==='windows'&&canonical.length>=180?path.win32.join(temp,'omp-local',safe&&safe!=='.'&&safe!=='..'?safe:'session'):canonical;
  return {canonical:windowsSessionPath(canonical),local:windowsSessionPath(local)};
}
async function directory(dir){
  await fs.mkdir(path.dirname(path.dirname(dir)),{recursive:true});
  for(const candidate of [path.dirname(dir),dir]){await fs.mkdir(candidate).catch(e=>{if(e.code!=='EEXIST')throw e;});const stat=await fs.lstat(candidate);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('附件目录不是普通目录，已保留原文');}
}
async function immutableWrite(dir,name,text){
  await directory(dir);const dest=path.join(dir,name);
  const existing=async()=>{const stat=await fs.lstat(dest);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>LIMIT||await fs.readFile(dest,'utf8')!==text)throw Error('同名文本附件内容不一致，请保留草稿并检查会话附件');};
  try{await existing();return;}catch(e){if(e.code!=='ENOENT')throw e;}
  const tmp=path.join(dir,'.lucyna-paste-'+randomUUID()+'.tmp');
  try{await fs.writeFile(tmp,text,{encoding:'utf8',flag:'wx',mode:0o600});try{await fs.link(tmp,dest);}catch(e){if(e.code!=='EEXIST')throw e;await existing();}}
  finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function writeTextAttachments(state,files){
  const validated=validateAttachments(files),roots=attachmentRoots(state),saved=[];
  // WSL's Windows file bridge does not implement hard links. Publish atomically
  // inside Linux rather than falling back to a partially visible Windows copy.
  if(state.runtime==='wsl')return new Promise((resolve,reject)=>{
    const child=spawn('wsl.exe',[...runtimeConfig.wslPrefix,'--','/usr/bin/python3',toWslPath(path.resolve(__dirname,'../tools/write_text_attachments.py'))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('保存 WSL 文本附件超时，草稿已保留'));},30000);
    child.stdout.on('data',data=>{stdout+=data;if(stdout.length>65536)child.kill();});child.stderr.on('data',data=>{stderr=(stderr+data).slice(-3000);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});child.stdin.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('保存 WSL 文本附件失败：'+stderr.trim()));try{resolve(JSON.parse(stdout));}catch{reject(Error('WSL 文本附件返回数据无效，草稿已保留'));}});
    child.stdin.end(JSON.stringify({sessionFile:wslSessionPath(state.sessionFile),files:validated}));
  });
  for(const file of validated){
    const name=filename(file.text);
    // Keep a durable copy beside the journal even when native Windows requires
    // its short temporary root. It can be rehydrated after a temp cleanup.
    await immutableWrite(roots.canonical,name,file.text);
    if(roots.local!==roots.canonical)await immutableWrite(roots.local,name,file.text);
    saved.push({id:file.id,url:'local://'+name,name,bytes:Buffer.byteLength(file.text),lines:file.text.split(/\r\n|\r|\n/).length});
  }
  return saved;
}
async function restoreTextAttachments(state){
  const roots=attachmentRoots(state);if(roots.local===roots.canonical)return;
  let entries;try{entries=await fs.readdir(roots.canonical);}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const candidate of [path.dirname(roots.canonical),roots.canonical]){const stat=await fs.lstat(candidate);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('会话附件目录不是普通目录，已保留原文');}
  for(const name of entries.filter(n=>PREFIX.test(n))){
    const source=path.join(roots.canonical,name),stat=await fs.lstat(source);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>LIMIT)throw Error('会话文本附件无法恢复，请检查原始附件');
    const text=await fs.readFile(source,'utf8');if(filename(text)!==name)throw Error('会话文本附件校验失败，已保留原始文件');
    await immutableWrite(roots.local,name,text);
  }
}
module.exports={validateAttachments,attachmentRoots,writeTextAttachments,restoreTextAttachments};
