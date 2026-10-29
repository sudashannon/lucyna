const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');
const runtime=require('./runtime-config.cjs');
const {wslSessionPath,toWslPath}=require('./client-settings.cjs');

function hold(command,args,request){return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','pipe']}),timer=setTimeout(()=>{child.kill();reject(Error('会话占用检查超时，未移动文件'));},35000);
  let buffer='',ready=false,closed=false,exitResolve;const exited=new Promise(r=>exitResolve=r);
  const fail=error=>{clearTimeout(timer);if(!ready){reject(error);child.stdin.end();}};
  child.once('error',fail);child.stdin.on('error',error=>fail(error));child.stderr.resume();
  child.once('exit',()=>{closed=true;exitResolve();if(!ready)fail(Error('无法确认会话占用情况，未移动文件'));});
  child.stdout.on('data',chunk=>{
    buffer+=chunk;if(!buffer.includes('\n')||ready)return;
    let message;try{message=JSON.parse(buffer.split('\n')[0]);}catch{return fail(Error('会话占用检查返回无效结果'));}
    if(!message.ready)return fail(Error(message.error||'会话仍被占用'));
    ready=true;clearTimeout(timer);
    resolve({check(){if(closed)throw Error('会话保护进程已退出，未继续移动文件');},async release(){child.stdin.end();await exited;}});
  });
  child.stdin.write(JSON.stringify(request)+'\n');
});}
async function acquireHistoryLease(plan){
  const leases=[];
  try{
    // Windows files can be used from WSL too; check that side whenever the
    // selected conversation is WSL or its Work memo lives in WSL.
    const files=plan.files.map(file=>file.path);
    if(plan.runtime==='wsl'||files.some(file=>runtime.fromWslUnc(file))){
      leases.push(await hold('wsl.exe',[...runtime.wslPrefix,'--exec','python3',toWslPath(path.resolve(__dirname,'../tools/hold_session_lease.py'))],{id:plan.entry.id,files:files.map(wslSessionPath)}));
    }
    const windowsFiles=[];
    const collect=async file=>{let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}if(stat.isSymbolicLink())return;if(stat.isFile())windowsFiles.push(file);else if(stat.isDirectory())for(const name of await fs.readdir(file))await collect(path.join(file,name));if(windowsFiles.length>10000)throw Error('会话附件过多，无法完成占用检查，文件已保留');};
    for(const file of files.filter(file=>!runtime.fromWslUnc(file)))await collect(file);
    if(windowsFiles.length)leases.push(await hold('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,'../tools/hold-session-files.ps1')],{files:windowsFiles}));
    return {check(){for(const lease of leases)lease.check();},async release(){await Promise.all(leases.map(lease=>lease.release()));}};
  }catch(error){await Promise.all(leases.map(lease=>lease.release()));throw error;}
}
module.exports={acquireHistoryLease};
