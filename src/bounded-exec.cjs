const {execFile}=require('node:child_process');
// execFile's own timeout waits for process close. A stuck WSL relay may keep
// inherited pipes open indefinitely, so enforce the deadline independently.
function boundedExec(file,args,{timeout=45000,execute=execFile,...options}={}){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{
      finish(Error(`命令执行超时（${Math.ceil(timeout/1000)} 秒），请重试`));
      child.kill();child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
    },timeout);
    let child;
    try{child=execute(file,args,{encoding:'utf8',maxBuffer:8*1024*1024,windowsHide:true,...options,timeout:0},(error,stdout,stderr)=>finish(error?Error((stderr||error.message).trim()):null,stdout));}
    catch(error){finish(error);}
  });
}
module.exports={boundedExec};
