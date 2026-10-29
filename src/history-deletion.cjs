const fs=require('node:fs/promises'),path=require('node:path');
const {createHash}=require('node:crypto');
const {fingerprint}=require('./history-trash.cjs');
const {sessionKey}=require('./session-manager.cjs');
const {readSourceHeader,belongsToWork}=require('./history.cjs');

async function memoOwner(file){
  const handle=await fs.open(file,'r');
  try{const buffer=Buffer.alloc(8192),{bytesRead}=await handle.read(buffer,0,buffer.length,0),head=buffer.subarray(0,bytesRead).toString('utf8').split('\n').slice(0,20).join('\n');
    return /^\s*(?:[-*]\s*)?(?:本\s*session|session(?:[ _-]?id)?|会话(?:[ _-]?id)?|当前会话)\s*[:：=]\s*`?([A-Za-z0-9_-]{9,128})/im.exec(head)?.[1];
  }finally{await handle.close();}
}

// Only private, root-level Work logs belong to a conversation. SESSION.md,
// notes/, work.json and Stele knowledge are shared and never deletion targets.
async function planDeletion({source,root,workPath,entry,catalog,catalogComplete=true,journalRoot}){
  const header=await readSourceHeader(source);
  if(!belongsToWork(header.cwd,root)||typeof header.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(header.id))throw Error('会话标识或工作目录无效，未删除文件');
  const id=header.id,files=[],warnings=[];
  const add=async(file,kind)=>files.push({path:file,kind,fingerprint:await fingerprint(file),...(kind!=='memo'&&journalRoot?{trashRoot:path.join(journalRoot,'.lucyna-trash')}:{})});
  await add(source,'journal');
  try{await add(source.slice(0,-6),'artifacts');if(!files.at(-1).fingerprint.directory)throw Error('会话附件位置不是目录');}catch(e){if(e.code!=='ENOENT')throw e;}
  // OMP can recover rewritten journals from these backups; move them with it.
  for(const name of (await fs.readdir(path.dirname(source))).sort())if(name.startsWith(path.basename(source)+'.')&&name.endsWith('.bak'))await add(path.join(path.dirname(source),name),'backup');
  const identities=new Map();for(const item of catalog||[]){const file=item.sessionFile||item.path;if(file)identities.set(sessionKey(file),item.id);}
  identities.set(sessionKey(source),id);
  const duplicates=[...identities].filter(([,value])=>value===id).length>1;
  const prefixIds=new Set([...identities.values()].filter(value=>typeof value==='string'&&value.startsWith(id.slice(0,8))));
  let names;try{names=await fs.readdir(workPath);}catch{names=[];warnings.push('无法读取 Work 会话备忘目录，备忘保留。');}
  const matches=names.filter(name=>name===`SESSION-${id}.md`||name===`SESSION-${id.slice(0,8)}.md`).sort();
  for(const name of matches){
    const file=path.join(workPath,name);let declared;
    try{const stat=await fingerprint(file);if(stat.directory)throw Error('不是普通文件');declared=await memoOwner(file);}
    catch{warnings.push(`${name} 保留：不是可安全移动的普通文件。`);continue;}
    let reason='';
    if(!catalogComplete)reason='历史来源未全部读取，无法排除同 ID 会话';
    else if(entry.importedAt&&!entry.independentCopy)reason='旧导入副本未确认独立 ID，备忘可能属于原件';
    else if(duplicates)reason='原件与副本共享会话 ID';
    else if(declared&&declared!==id)reason='备忘声明属于另一会话';
    else if(name!==`SESSION-${id}.md`&&prefixIds.size>1&&declared!==id)reason='短 ID 对应多个会话，备忘未声明完整 ID';
    if(reason){warnings.push(`${name} 保留：${reason}。`);continue;}
    await add(file,'memo');
  }
  if(!matches.length&&!warnings.length)warnings.push('未找到对应的 Work 会话备忘。');
  const plan={root,source,runtime:entry.runtime,entry:{...entry,id,sessionFile:source},files,warnings};
  return {...plan,token:createHash('sha256').update(JSON.stringify({root,source,id,runtime:entry.runtime,files,warnings})).digest('hex')};
}
function publicPlan(plan){return {token:plan.token,files:plan.files.map(f=>({path:f.path,kind:f.kind})),warnings:plan.warnings};}
module.exports={planDeletion,publicPlan};
