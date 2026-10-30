// Headless entry point for the same AuxiliaryAgent used by the desktop.
// Credentials and tool results arrive only over a private pipe, never argv/env/disk.
const {AuxiliaryAgent}=require('./auxiliary-agent.cjs');
const {validate}=require('./auxiliary-settings.cjs');
const {randomUUID}=require('node:crypto');
const controller=new AbortController(),pending=new Map();
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let buffer='',started=false,finished=false;
function close(){controller.abort();for(const p of pending.values())p.reject(Error('Work host disconnected'));pending.clear();}
async function start(input){
  try{
    const config={...validate(input.config),apiKey:input.config.apiKey||''};
    const result=await new AuxiliaryAgent().iterateWork(config,input.request,(name,args)=>new Promise((resolve,reject)=>{
      const id=randomUUID();pending.set(id,{resolve,reject});send({type:'tool',id,name,args});
    }),usage=>send({type:'usage',...usage}),controller.signal);
    send({type:'done',...result});
  }catch(error){send({type:'failed',error:error.localAgentError?error.message:/^辅助模型/.test(error.message)?error.message:'本地 Work agent 执行失败'});}
  finally{finished=true;close();process.stdin.destroy();}
}
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  buffer+=chunk;if(Buffer.byteLength(buffer)>4*1024*1024){close();process.stdin.destroy();return;}
  let offset;
  while((offset=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,offset);buffer=buffer.slice(offset+1);
    try{
      const input=JSON.parse(line);
      if(!started){started=true;void start(input);}
      else{const p=pending.get(input.id);if(p){pending.delete(input.id);p.resolve(input.result);}}
    }catch{close();process.stdin.destroy();}
  }
});
process.stdin.on('end',()=>{if(!finished)close();});
process.stdin.on('error',close);
process.stdout.on('error',close);
