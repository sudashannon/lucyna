// Desktop acceptance can outlive the terminal that launched it. Keep diagnostics
// on disk and handle only broken output pipes; never hide application exceptions.
const fs=require('node:fs'),path=require('node:path'),{format}=require('node:util');
function installDesktopLog(directory=path.resolve('.runtime','desktop-logs',`${path.basename(process.argv[1]||'desktop')}-${process.pid}`),{target=console,stdout=process.stdout,stderr=process.stderr}={}){
  fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'desktop.log'),closed=new Set(),listeners=[],originals={};
  const record=(level,text)=>fs.appendFileSync(file,`${new Date().toISOString()} [${level}] ${text}\n`,'utf8');
  const failed=(stream,error)=>{
    if(error?.code!=='EPIPE'){record('output-error',error?.stack||String(error));throw error;}
    if(!closed.has(stream)){closed.add(stream);record('output-closed','Output pipe closed (EPIPE); continuing with file logging.');}
  };
  for(const stream of new Set([stdout,stderr])){
    const listener=error=>failed(stream,error);stream.on('error',listener);listeners.push([stream,listener]);
  }
  for(const level of ['log','info','debug','warn','error']){
    originals[level]=target[level];target[level]=(...args)=>{
      const text=format(...args);record(level,text);const stream=['warn','error'].includes(level)?stderr:stdout;
      if(closed.has(stream)||stream.destroyed||stream.writableEnded)return;
      try{stream.write(text+'\n');}catch(error){failed(stream,error);}
    };
  }
  return{file,restore:()=>{for(const [stream,listener]of listeners)stream.removeListener('error',listener);Object.assign(target,originals);}};
}
module.exports={installDesktopLog};
