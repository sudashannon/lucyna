const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');
const {sessionKey} = require('./session-manager.cjs');
const {renameNoReplace}=require('./history-move.cjs');

async function fingerprint(file) {
  const stat=await fs.lstat(file);
  if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw Error('不能移除符号链接或特殊文件：'+file);
  return {dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,directory:stat.isDirectory()};
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function exists(file){try{await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function directPath(file){
  const real=await fs.realpath(path.dirname(file));
  if(sessionKey(real)!==sessionKey(path.dirname(file)))throw Error('文件父目录已改变或包含符号链接：'+file);
}

// Objects stay on their original filesystem, outside OMP's journal scan.
// Persist BEFORE renaming; interrupted transactions remain recoverable.
class HistoryTrash {
  constructor(directory,{rename=renameNoReplace}={}){this.file=path.join(directory,'history-trash.json');this.queue=Promise.resolve();this.rename=rename;}
  key(root,source){return createHash('sha256').update(root+'\0'+sessionKey(source)).digest('hex');}
  async read(){try{const value=JSON.parse(await fs.readFile(this.file,'utf8'));if(!Array.isArray(value))throw Error('Invalid history trash');return value;}catch(error){if(error.code==='ENOENT')return [];throw error;}}
  async write(items){await fs.mkdir(path.dirname(this.file),{recursive:true});const temporary=this.file+'.'+randomUUID()+'.tmp',handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(items,null,2),'utf8');await handle.sync();}finally{await handle.close();}await fs.rename(temporary,this.file);}
  serialize(operation){const task=this.queue.then(operation);this.queue=task.catch(()=>{});return task;}
  // Backward compatibility: old metadata-only records are still restorable.
  put(root,source,entry){return this.serialize(async()=>{const key=this.key(root,source);await this.write([...(await this.read()).filter(i=>i.key!==key),{key,root,source,entry,deletedAt:new Date().toISOString()}]);return key;});}
  move(plan,{check=()=>{}}={}){return this.serialize(async()=>{
    check();
    const items=await this.read(),key=this.key(plan.root,plan.source);
    if(items.some(i=>i.key===key))throw Error('该会话已经在回收站中');
    const token=randomUUID(),files=plan.files.map(file=>({...file,trash:path.join(file.trashRoot||path.join(path.dirname(file.path),'.lucyna-trash'),token,path.basename(file.path))}));
    for(const file of files){await directPath(file.path);if(!same(await fingerprint(file.path),file.fingerprint))throw Error('文件已变化，请重新打开删除确认：'+file.path);}
    for(const file of files){
      const trashRoot=path.dirname(path.dirname(file.trash));await fs.mkdir(trashRoot,{recursive:true});await directPath(path.join(trashRoot,'check'));
      await fs.mkdir(path.dirname(file.trash),{recursive:true});await directPath(file.trash);
    }
    const record={version:2,key,root:plan.root,source:plan.source,entry:plan.entry,runtime:plan.runtime,files,warnings:plan.warnings,deletedAt:new Date().toISOString(),state:'moving'};
    items.push(record);await this.write(items);
    try{
      for(const file of files){check();await directPath(file.path);if(!same(await fingerprint(file.path),file.fingerprint))throw Error('文件已变化，请重新打开删除确认：'+file.path);await this.rename(file.path,file.trash);}
      record.state='trashed';await this.write(items);return key;
    }catch(error){
      let restored=true;
      for(const file of [...files].reverse())try{if(await exists(file.trash)){if(await exists(file.path))throw Error('restore conflict');await this.rename(file.trash,file.path);}}catch{restored=false;}
      if(restored)await this.write(items.filter(i=>i!==record));
      else {record.state='partial';await this.write(items);}
      throw Error(error.message+(restored?'（文件已回退）':'（部分文件已移入回收站，请使用恢复；未覆盖任何原文件）'));
    }
  });}
  restore(root,key,{check=()=>{}}={}){return this.serialize(async()=>{
    check();
    const items=await this.read(),record=items.find(i=>i.root===root&&i.key===key);if(!record)return;
    if(record.version===2){
      const moving=[];
      for(const file of record.files){
        await directPath(file.path);await directPath(file.trash);
        if(await exists(file.trash)){
          if(await exists(file.path))throw Error('原位置已存在文件，恢复已取消，不会覆盖：'+file.path);
          if(!same(await fingerprint(file.trash),file.fingerprint))throw Error('回收站文件已变化，请保留并检查：'+file.trash);
          moving.push(file);
        }else if(!await exists(file.path)||!same(await fingerprint(file.path),file.fingerprint))throw Error('恢复记录不完整，请保留回收站文件：'+file.path);
      }
      // Keep the manifest until ALL files are restored; retry handles interruption.
      for(const file of moving){check();if(await exists(file.path))throw Error('原位置已存在文件，未覆盖：'+file.path);await this.rename(file.trash,file.path);}
    }
    await this.write(items.filter(i=>i!==record));
  });}
  async list(root){await this.queue;return (await this.read()).filter(item=>item.root===root);}
}
module.exports={HistoryTrash,fingerprint};
