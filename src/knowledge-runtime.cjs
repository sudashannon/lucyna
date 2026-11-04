const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class KnowledgeRuntime {
 constructor(directory,{executable=process.execPath,startTimeout=240000}={}){this.directory=path.resolve(directory);this.executable=executable;this.startTimeout=startTimeout;this.pending=null;this.connection=null;}
 async record(){try{const record=JSON.parse(await fsp.readFile(path.join(this.directory,'runtime/connection.json'),'utf8'));if(record.root!==this.directory||!/^http:\/\/127\.0\.0\.1:\d+$/.test(record.url)||!/^[a-f0-9]{64}$/.test(record.token)||!Number.isInteger(record.pid)||record.pid<=0)return null;return record;}catch{return null;}}
 alive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
 async probe(){
  try{const record=await this.record();if(!record)return null;
   const response=await fetch(record.url+'/api/health',{headers:{authorization:'Bearer '+record.token},signal:AbortSignal.timeout(1200)});if(!response.ok)return null;const health=await response.json();if(health.instanceId!==record.instanceId||!health.ready||!health.embeddingReady)return null;return {...record,health};
  }catch{return null;}
 }
 ensure(){if(this.pending)return this.pending;this.pending=this.start().finally(()=>{this.pending=null;});return this.pending;}
 async waitForLiveHost(){const record=await this.record();if(!record||!this.alive(record.pid))return null;const end=Date.now()+this.startTimeout;while(Date.now()<end){const found=await this.probe();if(found)return found;const current=await this.record();if(!current||current.instanceId!==record.instanceId||!this.alive(record.pid))return null;await pause(250);}throw Error('知识服务正在处理任务，请稍后重试');}
 async start(){
  const existing=await this.probe();if(existing)return this.connection=existing;
  const live=await this.waitForLiveHost();if(live)return this.connection=live;
  const runtime=path.join(this.directory,'runtime');await fsp.mkdir(runtime,{recursive:true});const lock=path.join(runtime,'start.lock');let held=false;
  try{await fsp.mkdir(lock);held=true;await fsp.writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,id:randomUUID()}));}catch(error){if(error.code!=='EEXIST')throw error;}
  if(!held){const end=Date.now()+this.startTimeout;while(Date.now()<end){const record=await this.probe();if(record)return this.connection=record;
    try{const owner=JSON.parse(await fsp.readFile(path.join(lock,'owner.json'),'utf8'));try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH'){await fsp.unlink(path.join(lock,'owner.json'));await fsp.rmdir(lock);return this.start();}}}catch(error){if(error.code==='ENOENT'&&!fs.existsSync(lock))return this.start();}
    await pause(200);
   }throw Error('内置知识服务正在由其他窗口启动，请稍后重试');}
  try{
   const again=await this.probe()||await this.waitForLiveHost();if(again)return this.connection=again;
   const log=fs.openSync(path.join(runtime,'host.log'),'a');const env={...process.env,LUCYNA_KNOWLEDGE_HOME:this.directory};delete env.ELECTRON_RUN_AS_NODE;
   // Electron runs a dedicated entry script without opening the renderer profile.
   const electron=!!process.versions.electron||/^electron(?:\.exe)?$/i.test(path.basename(this.executable));
   const args=electron?[...(process.defaultApp||!process.versions.electron?[path.resolve(__dirname,'..')]:[]),'--knowledge-service','--knowledge-data',this.directory]:[path.join(__dirname,'knowledge-host.cjs')];
   await fsp.writeFile(path.join(runtime,'launch.json'),JSON.stringify({command:this.executable,args}),{mode:0o600});
   const child=spawn(this.executable,args,{env,windowsHide:true,detached:true,stdio:['ignore',log,log]});fs.closeSync(log);let spawnError;child.once('error',error=>{spawnError=error;});child.once('exit',(code,signal)=>{spawnError=Error(`内置知识服务启动后退出（${code??signal??'未知'}），请查看知识库诊断`);});child.unref();
   const end=Date.now()+this.startTimeout;while(Date.now()<end){const record=await this.probe();if(record)return this.connection=record;if(spawnError)throw spawnError;await pause(150);}
   throw Error('内置知识服务启动失败，请查看知识库诊断后重试');
  }finally{if(held){await fsp.unlink(path.join(lock,'owner.json')).catch(()=>{});await fsp.rmdir(lock).catch(()=>{});}}
 }
 async fetch(input,options={}){const record=await this.ensure(),incoming=new URL(input),target=new URL(incoming.pathname+incoming.search,record.url);return fetch(target,{...options,redirect:'error',headers:{...Object.fromEntries(new Headers(options.headers)),authorization:'Bearer '+record.token}});}
 async call(route,{method='GET',body}={}){const response=await this.fetch(new URL(route,'http://127.0.0.1'),{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(route==='/api/library/import'?600000:360000)});if(!response.ok){let message;try{message=(await response.json()).error;}catch{}throw Error(message||'内部知识服务请求失败（'+response.status+'）');}return response.json();}
}
module.exports={KnowledgeRuntime};
