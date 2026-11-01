const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {validateSsh,locatorKey}=require('../src/hosts/profile.cjs');
const {quote,invocation,runSSH}=require('../src/hosts/ssh-executor.cjs');
const {buildBundle,digest}=require('../tools/build-host-bundle.cjs');
const {deploy}=require('../src/hosts/ssh-bootstrap.cjs');
const target={destination:'dev-box',executor:{kind:'wsl-openssh',distro:'Ubuntu-22.04',user:'tester'}};
const frame=x=>'LUCYNA_HOST_V1 '+JSON.stringify(x)+'\n';
test('host identity and Linux case prevent path collisions',()=>{
  assert.notEqual(locatorKey({hostId:'a',root:'/work/X'}),locatorKey({hostId:'b',root:'/work/X'}));
  assert.notEqual(locatorKey({hostId:'a',root:'/work/X'}),locatorKey({hostId:'a',root:'/work/x'}));
  assert.throws(()=>locatorKey({hostId:'a',root:'/work/../etc'}));
});
test('SSH rejects option injection and retains the selected executor',()=>{
  for(const destination of ['-oProxyCommand=bad','x;bad','x\nboom','$(boom)',''])assert.throws(()=>validateSsh({...target,destination}));
  assert.throws(()=>validateSsh({...target,identityFile:'C:\\private.key'}));
  const value=invocation(target,['/usr/bin/python3',"a'b $(touch /tmp/unwanted)"]);
  assert.equal(value.file,'wsl.exe');assert.ok(value.args.includes('StrictHostKeyChecking=yes'));
  assert.equal(value.args.at(-1),"'/usr/bin/python3' 'a'\"'\"'b $(touch /tmp/unwanted)'");
  assert.throws(()=>quote('a\nb'));
});
test('bundle is deterministic across builds and includes no machine configuration',async()=>{
  const a=await buildBundle(),b=await buildBundle();assert.deepEqual(a,b);
  assert.deepEqual(Object.keys(a.files).sort(),['artifacts.py','git_workspace.py','host.py','host_runtime.py','install.py','protocol.py','sessions.py','work-details.py','work-inventory.py','workspace.py','workspace_files.py']);
  for(const item of Object.values(a.files))assert.equal(digest(Buffer.from(item.data,'base64')),item.sha256);
});
test('deployment verifies both payload and the live installation identity',async()=>{
  const bundle=await buildBundle(),phases=[];let count=0;
  const installed={ok:true,release:bundle.release,installationId:'remote-id',mode:'connection',entry:'/tmp/host.py',state:'/tmp/state'};
  const execute=async(config,args,options)=>{
    assert.equal(config.destination,'dev-box');
    if(++count===1)return 'shell banner\n'+frame({ok:true,platform:'Linux',arch:'x86_64',python:'/usr/bin/python3'});
    if(count===2){assert.equal(args.at(-1),digest(options.input));assert.equal(JSON.parse(options.input).options.mode,'connection');return frame(installed);}
    return frame({ok:true,id:'deployment-health',data:{protocolVersion:1,release:bundle.release,installationId:'remote-id'}});
  };
  const result=await deploy(target,bundle,{mode:'connection',execute,onProgress:p=>phases.push(p.phase)});
  assert.equal(result.hello.installationId,'remote-id');assert.deepEqual(phases,['probing','installing','verifying','ready']);
  count=0;
  await assert.rejects(()=>deploy(target,bundle,{mode:'connection',execute:async(...args)=>{
    const result=await execute(...args);return count===3?result.replace('remote-id','wrong-host'):result;
  }}),/身份不匹配/);
});
test('missing runtime fails before any install command',async()=>{
  let calls=0;await assert.rejects(()=>deploy(target,awaitableBundle,{execute:async()=>{calls++;return frame({ok:false,code:'runtime_required'});}}),/runtime_required/);assert.equal(calls,1);
});
const awaitableBundle={version:1,release:'a'.repeat(64)};
test('abort and oversized SSH output terminate transport without hanging',async()=>{
  let child;const execute=()=>{child=new EventEmitter();for(const k of ['stdin','stdout','stderr'])child[k]=new PassThrough();child.kill=()=>{child.killed=true;};return child;};
  const controller=new AbortController();
  const pending=runSSH(target,['true'],{execute,signal:controller.signal});controller.abort(Error('cancelled'));
  await assert.rejects(pending,/cancelled/);assert.equal(child.killed,true);
  const large=runSSH(target,['true'],{execute,maxBytes:4});child.stdout.write('12345');await assert.rejects(large,/超过限制/);
});
