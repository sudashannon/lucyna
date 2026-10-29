const path=require('node:path');
const {execFile}=require('node:child_process');
const runtime=require('./runtime-config.cjs');
const {toWslPath}=require('./client-settings.cjs');
function renameNoReplace(source,destination){
  const linux=runtime.fromWslUnc(source),target=runtime.fromWslUnc(destination);
  let command,args;
  if(linux&&target){command='wsl.exe';args=[...runtime.wslPrefix,'--exec','python3',toWslPath(path.resolve(__dirname,'../tools/move_history_file.py')),linux,target];}
  else if(process.platform==='win32'){command='powershell.exe';args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,'../tools/move-history-file.ps1'),source,destination];}
  else{command='python3';args=[path.resolve(__dirname,'../tools/move_history_file.py'),source,destination];}
  return new Promise((resolve,reject)=>execFile(command,args,{windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:16384},(error)=>error?reject(Error('文件移动失败（可能被占用或目标已存在），未覆盖目标文件')):resolve()));
}
module.exports={renameNoReplace};
