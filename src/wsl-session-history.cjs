// Only provenance pointers live in the client profile. OMP owns the journal,
// cwd-derived directory name, attachments and writes in its native WSL store.
// Existing journals in the configured native store are opened in place too.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const {windowsSessionPath,wslSessionPath}=require('./client-settings.cjs');
const {validateNativeSession,readSessionTitle,wslSource}=require('./history.cjs');
class WslSessionHistory {
  constructor(userData){this.directory=path.join(userData,'wsl-session-links');}
  pointer(file){return path.join(this.directory,createHash('sha256').update(wslSessionPath(file)).digest('hex')+'.json');}
  async remember(record){
    if(!record.nativeHistory||!record.sessionFile)return;
    const agentDir=wslSessionPath(record.agentDir),sessionFile=wslSessionPath(record.sessionFile);
    const relative=path.posix.relative(path.posix.join(agentDir,'sessions'),sessionFile);
    if(!relative||relative.startsWith('..')||path.posix.isAbsolute(relative)||!sessionFile.endsWith('.jsonl'))throw new Error('原生会话未保存在所选 WSL OMP 历史目录');
    // Native get_state may precede lazy journal creation. Validate the header
    // when listing/resuming, not by forcing a write to the native journal here.
    const value={version:1,workRoot:record.root,agentDir,sessionFile};
    await fs.mkdir(this.directory,{recursive:true});
    try{await fs.writeFile(this.pointer(sessionFile),JSON.stringify(value)+'\n',{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  }
  async validate(agentDir,sessionFile,root){
    const stored=JSON.parse(await fs.readFile(this.pointer(sessionFile),'utf8'));
    if(stored.version!==1||stored.workRoot!==root||stored.agentDir!==wslSessionPath(agentDir)||stored.sessionFile!==wslSessionPath(sessionFile))throw new Error('此原生会话不属于当前 work 或客户端记录');
    const verified=await validateNativeSession(windowsSessionPath(stored.agentDir),windowsSessionPath(stored.sessionFile),root);
    return {...verified,agentDir:stored.agentDir,runtime:'wsl',sourceKind:'native-wsl'};
  }
  async resolve(agentDir,sessionFile,root,configuredAgentDir){
    const selected=wslSessionPath(agentDir);
    if(selected!==wslSessionPath(configuredAgentDir))return this.validate(agentDir,sessionFile,root);
    // Listing alone never grants a writer access. Recheck lexical containment,
    // real paths and the journal's original cwd immediately before opening it.
    const source=windowsSessionPath(sessionFile);
    if(!wslSource(source,selected))throw Error('请选择已配置 WSL OMP 目录中的原生会话');
    const verified=await validateNativeSession(windowsSessionPath(selected),source,root);
    await this.remember({nativeHistory:true,root,agentDir:selected,sessionFile:verified.sessionFile});
    return {...verified,agentDir:selected,runtime:'wsl',sourceKind:'native-wsl'};
  }
  async list(root){
    let names;try{names=await fs.readdir(this.directory);}catch(e){if(e.code==='ENOENT')return [];throw e;}
    const result=[];
    for(const name of names){
      if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
      try{
        const stored=JSON.parse(await fs.readFile(path.join(this.directory,name),'utf8'));if(stored.workRoot!==root)continue;
        const entry=await this.validate(stored.agentDir,stored.sessionFile,root),stat=await fs.stat(entry.sessionFile);
        result.push({...entry,title:await readSessionTitle(entry.sessionFile)||entry.id,modifiedAt:stat.mtime.toISOString()});
      }catch{/* Missing lazy journals and stale pointers do not change source data. */}
    }
    return result.sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt));
  }
}
module.exports={WslSessionHistory};
