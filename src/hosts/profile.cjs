const path = require('node:path');
function text(value, label, max=4096) {
  if(typeof value!=='string'||!value||value.length>max||/[\0\r\n]/.test(value))throw Error('无效字段：'+label);
  return value;
}
function linuxPath(value) {
  text(value,'Linux 路径');
  if(!value.startsWith('/')||value.includes('\\')||value.split('/').some(p=>p==='.'||p==='..'))throw Error('需要规范的 Linux 绝对路径');
  return value==='/'?value:value.replace(/\/+$/,'');
}
function validateSsh(value) {
  if(!value||typeof value!=='object')throw Error('需要 SSH 配置');
  const destination=text(value.destination,'SSH 目标',255);
  if(!/^[a-zA-Z0-9_][a-zA-Z0-9_.:@\[\]-]*$/.test(destination))throw Error('SSH 目标必须是别名或主机地址');
  const executor=value.executor||{kind:'windows-openssh'};
  if(!['windows-openssh','wsl-openssh'].includes(executor.kind))throw Error('不支持的 SSH 执行器');
  const result={destination,executor:{kind:executor.kind}};
  if(executor.kind==='wsl-openssh'){
    for(const key of ['distro','user']){
      const v=text(executor[key],key,100);
      if(!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(v))throw Error('无效 WSL '+key);
      result.executor[key]=v;
    }
  }
  if(value.port!==undefined){if(!Number.isInteger(value.port)||value.port<1||value.port>65535)throw Error('无效 SSH 端口');result.port=value.port;}
  if(value.user!==undefined){const user=text(value.user,'SSH 用户',100);if(!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user))throw Error('无效 SSH 用户');result.user=user;}
  for(const key of ['configFile','identityFile'])if(value[key]!==undefined){
    const file=text(value[key],key);
    if(executor.kind==='wsl-openssh')linuxPath(file);
    else if(!path.win32.isAbsolute(file))throw Error(key+' 需要 Windows 绝对路径');
    result[key]=file;
  }
  return result;
}
function locatorKey({hostId,root},flavor='posix') {
  text(hostId,'hostId',100);
  const normalized=flavor==='windows'?path.win32.normalize(text(root,'root')).toLowerCase():linuxPath(root);
  if(flavor!=='posix'&&flavor!=='windows')throw Error('未知路径类型');
  return JSON.stringify([hostId,normalized]);
}
module.exports={validateSsh,linuxPath,locatorKey};
