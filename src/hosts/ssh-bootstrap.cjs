const {runSSH}=require('./ssh-executor.cjs');
const {linuxPath,validateSsh}=require('./profile.cjs');
const {digest}=require('../../tools/build-host-bundle.cjs');
const PREFIX='LUCYNA_HOST_V1 ';
const PROBE='set -eu; test "$(uname -s)" = Linux || exit 41; command -v python3 >/dev/null || { printf "LUCYNA_HOST_V1 {\\"ok\\":false,\\"code\\":\\"runtime_required\\"}\\n"; exit 0; }; exec python3 -I -c '+"'import sys,json,platform,os; print(\"LUCYNA_HOST_V1 \"+json.dumps({\"ok\":sys.version_info >= (3,10),\"code\":\"runtime_required\",\"python\":sys.executable,\"platform\":platform.system(),\"arch\":platform.machine(),\"uid\":os.getuid()}))'";
// The expected digest is supplied by the trusted desktop, not the remote payload.
const INSTALL='import sys,json,hashlib,base64; raw=sys.stdin.buffer.read(1048577); assert len(raw)<=1048576,"payload too large"; assert hashlib.sha256(raw).hexdigest()==sys.argv[1],"payload digest mismatch"; payload=json.loads(raw); source=base64.b64decode(payload["bundle"]["files"]["install.py"]["data"],validate=True); exec(compile(source,"lucyna-install","exec"),{"__name__":"__main__","BUNDLE":payload["bundle"],"OPTIONS":payload["options"]})';
function result(output){
  const frames=output.split(/\r?\n/).filter(line=>line.startsWith(PREFIX));
  if(frames.length!==1)throw Error('远端安装响应格式无效');
  const value=JSON.parse(frames[0].slice(PREFIX.length));
  if(!value.ok)throw Object.assign(Error('远端准备失败：'+(value.code||'unknown')),{code:value.code});
  return value;
}
async function deploy(input,bundle,{mode='user-service',prefix,signal,onProgress=()=>{},execute=runSSH}={}){
  const config=validateSsh(input);
  if(!['user-service','connection'].includes(mode))throw Error('未知 host 模式');
  if(prefix)linuxPath(prefix);
  if(bundle?.version!==1||!/^[a-f0-9]{64}$/.test(bundle.release))throw Error('无效 host 制品');
  onProgress({phase:'probing'});
  const probe=result(await execute(config,['sh','-c',PROBE],{signal,timeoutMs:30000}));
  if(probe.platform!=='Linux'||!['x86_64','aarch64'].includes(probe.arch))throw Error('首版仅支持 Linux x86_64/aarch64');
  const python=linuxPath(probe.python);
  const payload=Buffer.from(JSON.stringify({bundle,options:{mode,...(prefix?{prefix}:{})}}));
  if(payload.length>1024*1024)throw Error('host 制品超过 1 MiB 限制');
  onProgress({phase:'installing',bytes:payload.length});
  const installed=result(await execute(config,[python,'-I','-c',INSTALL,digest(payload)],{input:payload,signal,timeoutMs:90000}));
  if(installed.release!==bundle.release||!['user-service','connection'].includes(installed.mode)||installed.mode!==mode)throw Error('远端安装身份不匹配');
  linuxPath(installed.entry);linuxPath(installed.state);
  onProgress({phase:'verifying'});
  const request={version:1,id:'deployment-health',op:'hello',args:{protocolVersions:[1]}};
  const output=await execute(config,[python,'-I',installed.entry,mode==='user-service'?'bridge':'stdio','--state',installed.state],{input:JSON.stringify(request)+'\n',signal,timeoutMs:30000});
  const replies=output.split(/\r?\n/).filter(line=>line.startsWith(PREFIX)).map(line=>JSON.parse(line.slice(PREFIX.length)));
  if(replies.length!==1||!replies[0].ok||replies[0].id!==request.id)throw Error('host 握手失败');
  const hello=replies[0].data;
  if(hello.release!==bundle.release||hello.installationId!==installed.installationId||hello.protocolVersion!==1)throw Error('host 握手身份不匹配');
  onProgress({phase:'ready'});
  return {...installed,hello};
}
module.exports={deploy,result,PROBE};
