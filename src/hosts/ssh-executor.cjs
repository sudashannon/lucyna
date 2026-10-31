const {spawn}=require('node:child_process');
const {validateSsh}=require('./profile.cjs');
function quote(value){if(typeof value!=='string'||/[\0\r\n]/.test(value))throw Error('无效远端参数');return "'"+value.replaceAll("'","'\"'\"'")+"'";}
// OpenSSH joins remote arguments into a shell command. Encode that layer explicitly.
function invocation(input,argv){
  const config=validateSsh(input);
  if(!Array.isArray(argv)||!argv.length)throw Error('缺少远端命令');
  const args=['-T','-a','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=20','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3'];
  for(const [key,flag] of [['port','-p'],['user','-l'],['configFile','-F'],['identityFile','-i']])if(config[key]!==undefined)args.push(flag,String(config[key]));
  args.push('--',config.destination,argv.map(quote).join(' '));
  return config.executor.kind==='wsl-openssh'
    ?{file:'wsl.exe',args:['-d',config.executor.distro,'-u',config.executor.user,'--exec','ssh',...args]}
    :{file:'ssh.exe',args};
}
function runSSH(config,argv,{input='',signal,timeoutMs=60000,maxBytes=2*1024*1024,execute=spawn}={}){
  signal?.throwIfAborted();
  const call=invocation(config,argv);
  return new Promise((resolve,reject)=>{
    const child=execute(call.file,call.args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let done=false,size=0,stderrSize=0;const chunks=[];
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const stop=error=>{child.kill();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();finish(error);};
    const abort=()=>stop(signal.reason||Error('SSH 操作已取消'));
    const timer=setTimeout(()=>stop(Error('SSH 操作超时；重试前将核对远端安装状态')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    child.once('error',()=>finish(Error('无法启动所选 SSH 执行器')));
    child.stdin.on('error',()=>{}); // close supplies the authoritative SSH status
    child.stdout.on('data',b=>{size+=b.length;if(size>maxBytes)return stop(Error('SSH 返回超过限制'));chunks.push(b);});
    child.stderr.on('data',b=>{stderrSize+=b.length;if(stderrSize>maxBytes)stop(Error('SSH 诊断输出超过限制'));});
    child.once('close',code=>finish(code===0?null:Object.assign(Error('SSH 执行失败（退出码 '+code+'）；请检查认证、主机信任与远端环境'),{code:'ssh_failed',exitCode:code}),Buffer.concat(chunks).toString('utf8')));
    child.stdin.end(input);
    if(signal?.aborted)abort();
  });
}
module.exports={quote,invocation,runSSH};
