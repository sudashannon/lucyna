const fs=require('node:fs/promises'),assert=require('node:assert/strict');
const {HostConnection}=require('../../src/hosts/connection.cjs');
const {RemoteDesktop}=require('../../src/hosts/desktop.cjs');
const {deployFrozen}=require('../../src/hosts/ssh-frozen.cjs');
const {randomUUID}=require('node:crypto');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const [profile,installed,options]=await Promise.all(process.argv.slice(2).map(async p=>JSON.parse(await fs.readFile(p,'utf8'))));
 let connection=new HostConnection(profile,installed);await connection.connect();
 const fake={registry:{get:async()=>({root:options.root})},connectHost:async()=>({connection})};
 const call=(operation,args={})=>RemoteDesktop.prototype.workspaceCall.call(fake,'fixture-host',options.root,operation,args);
 const read=(action,extra={})=>call('workspace.git',{member:'app',action,options:extra});
 const wait=async(id,member='app')=>{for(let i=0;i<100;i++){const r=await call('workspace.git',{member,action:'operation',options:{operationId:id}});if(['completed','failed','uncertain'].includes(r.status))return r;await delay(100);}throw Error('Git operation timed out');};
 const act=async(action,extra={})=>{const snap=await read('snapshot',extra.file?{file:extra.file}:{}),id=randomUUID();const r=await read(action,{operationId:id,expected:snap.token,...extra});return r.status==='completed'||r.status==='failed'?r:wait(id);};
 try{
  assert.ok(connection.hello.capabilities.includes('workspace.git'));
  const files=await call('workspace.files.list',{directory:''});assert.ok(files.entries.some(e=>e.path==='SESSION.md'));
  assert.ok((await call('workspace.files.read',{reference:'SESSION.md'})).content.includes('Test'));
  await assert.rejects(call('workspace.files.read',{reference:'../../etc/passwd'}));
  assert.equal((await call('workspace.details')).members[0].name,'app');
  assert.ok((await call('workspace.git.read',{member:'app',action:'diff',options:{file:'a.txt'}})).text.includes('+ONE'));
  assert.equal((await act('stage',{file:'a.txt'})).status,'completed');
  const snap=await read('snapshot'),id=randomUUID(),request={operationId:id,expected:snap.token,message:'SSH reviewed commit'};
  await read('commit',request);await connection.disconnect();
  connection=new HostConnection(profile,installed);await connection.connect();
  const committed=await wait(id);assert.equal(committed.status,'completed',JSON.stringify(committed));
  const repeated=await read('commit',request);assert.equal(repeated.result.commit,committed.result.commit);
  assert.equal((await act('push',{remote:'origin',branch:'feature'})).status,'completed');
  assert.equal((await act('fetch',{remote:'origin'})).status,'completed');
  assert.equal((await act('branch-create',{branch:'remote-next'})).status,'completed');
  assert.equal((await act('branch-switch',{branch:'remote-next'})).status,'completed');
  assert.equal((await call('workspace.details')).members[0].registeredBranch,'remote-next');
  assert.equal((await act('worktree-create',{name:'second',branch:'remote-second'})).status,'completed');
  assert.equal((await act('worktree-move',{name:'renamed'})).status,'completed');
  const removedSnap=await call('workspace.git',{member:'renamed',action:'snapshot'}),removeId=randomUUID();
  await call('workspace.git',{member:'renamed',action:'worktree-remove',options:{operationId:removeId,expected:removedSnap.token}});
  assert.equal((await wait(removeId,'renamed')).status,'completed');
  const oldHello=connection.hello;connection.hello={...oldHello,capabilities:[]};await assert.rejects(read('snapshot'),/版本尚不支持/);connection.hello=oldHello;
  await connection.disconnect();
  // Reinstall/update is explicit and verifies daemon identity after activation.
  const same=await deployFrozen(profile,options.bundle,{prefix:options.prefix,upgrade:true});assert.equal(same.installationId,installed.installationId);
  const previousIndex=JSON.parse(await fs.readFile(options.previousBundle,'utf8'));assert.notEqual(previousIndex.release,installed.release,'Upgrade acceptance needs a different --previous-bundle release');
  const previous=await deployFrozen(profile,options.previousBundle,{prefix:options.prefix+'-upgrade'});
  const upgraded=await deployFrozen(profile,options.bundle,{prefix:options.prefix+'-upgrade',upgrade:true});assert.equal(upgraded.installationId,previous.installationId);assert.notEqual(upgraded.release,previous.release);assert.ok(upgraded.hello.capabilities.includes('workspace.git'));
  process.stdout.write(JSON.stringify({passed:true,transport:'OpenSSH / frozen user service',checks:['bounded remote files and escape rejection','real remote diff/stage/commit','lost SSH reply reconnect without duplicate commit','fetch/push with remote verification','branch and Worktree registration lifecycle','removed member operation remains queryable','old capability refusal','old frozen release upgrades with stable installation identity'],commit:committed.result.commit})+'\n');
 }finally{await connection.disconnect();}
})().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
