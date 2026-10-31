const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {HostRegistry,profile}=require('../src/hosts/registry.cjs');
const input={name:'开发机',root:'/work/shared',omp:'/usr/local/bin/omp',ssh:{destination:'dev'}};
test('host profile persistence isolates same-path hosts and preserves installation ownership',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'lh-registry-'));
 try{
  const store=new HostRegistry(folder),a=await store.save(input),b=await store.save({...input,name:'第二台'});
  assert.notEqual(a.id,b.id);assert.equal(a.root,b.root);
  await store.installed(a.id,{installationId:'identity'});
  await store.remember({id:'session',hostId:a.id,ended:false});
  await assert.rejects(store.save({...a,root:'/different'}),/仍有远端会话/);
  await assert.rejects(store.remove(a.id),/结束/);
  await store.save({...a,name:'新名称'});
  assert.equal((await store.get(a.id)).installed.installationId,'identity');
  await assert.rejects(store.installed(a.id,{installationId:'other'}),/身份已变化/);
  const reloaded=new HostRegistry(folder);assert.equal((await reloaded.load()).clientId,(await store.load()).clientId);
  await store.remember({id:'session',hostId:a.id,ended:true});
  await store.save({...a,root:'/different'});assert.equal((await store.get(a.id)).installed,undefined);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});
test('host form never accepts a shell fragment or non-absolute remote path',()=>{
 assert.throws(()=>profile({...input,ssh:{destination:'-oProxyCommand=bad'}}));
 assert.throws(()=>profile({...input,root:'../work'}));
 assert.throws(()=>profile({...input,omp:'/bin/omp\ncommand'}));
 assert.throws(()=>profile({...input,root:'/'}));
});

test('cancelling a pending desktop start cannot create a late remote OMP',async()=>{
 const {RemoteDesktop}=require('../src/hosts/desktop.cjs');
 const remote=new RemoteDesktop({directory:'unused'});let release,entered,requests=0;
 remote.registry.get=async()=>({...input,id:'host'});remote.registry.load=async()=>({clientId:'client',sessions:[]});
 const connecting=new Promise(resolve=>entered=resolve);
 remote.connectHost=()=>{entered();return new Promise(resolve=>release=()=>resolve({connection:{request:()=>requests++}}));};
 const start=remote.start({clientSessionId:'session',hostId:'host',root:input.root});
 await connecting;assert.equal(remote.owns('session'),true);await remote.close('session');release();
 await assert.rejects(start,/取消/);assert.equal(requests,0);assert.equal(remote.active.size,0);
});

test('a confirmed dead remote process can be closed and releases its host configuration',async()=>{
 const {RemoteDesktop}=require('../src/hosts/desktop.cjs');const remote=new RemoteDesktop({directory:'unused'});
 let remembered;const events=[];remote.send=event=>events.push(event);remote.registry.remember=async saved=>remembered={...saved};
 remote.connectHost=async()=>({});const saved={id:'session',hostId:'host',root:input.root,descriptor:{record:{id:'native'}}};
 remote.active.set(saved.id,{saved,session:{polling:false,attach:async()=>{throw Object.assign(Error('exited'),{code:'session_not_live'});}}});
 await remote.close(saved.id);assert.equal(remembered.ended,true);assert.equal(remote.listConnections().length,0);assert.equal(events[0].type,'process_exit');
});

test('desktop records prompt identity before sending and keeps the guard across lost acknowledgements',async()=>{
 const {RemoteDesktop}=require('../src/hosts/desktop.cjs');const remote=new RemoteDesktop({directory:'unused'});
 const saved={id:'session',hostId:'host',root:input.root};let disk,calls=0;
 remote.registry.remember=async record=>disk={...record};
 remote.active.set(saved.id,{saved,session:{request:async(type,data,{operationId})=>{calls++;assert.equal(disk.pendingOperation,operationId);throw Object.assign(Error('lost'),{code:'transport_lost'});}}});
 await assert.rejects(remote.request(saved.id,'prompt',{message:'one prompt'}),/lost/);
 assert.ok(disk.pendingOperation);await assert.rejects(remote.request(saved.id,'prompt',{message:'one prompt'}),/尚未核对/);assert.equal(calls,1);
});

test('remote history collapses process generations to the journal and prefers its live writer',async()=>{
 const {RemoteDesktop}=require('../src/hosts/desktop.cjs');const remote=new RemoteDesktop({directory:'unused'});
 remote.registry.get=async()=>({...input,id:'host'});
 const base={root:input.root,journal:'/host/sessions/one.jsonl',nativeSessionId:'original'};
 remote.connectHost=async()=>({workspace:{root:input.root},connection:{request:async()=>[
  {...base,id:'exited',status:'exited'},{...base,id:'writer',status:'live'},{...base,id:'stale',status:'interrupted'},
  {...base,id:'other-work',root:'/other',status:'live'},
 ]}});
 const history=await remote.history(input.root,'host');assert.equal(history.managed.length,1);assert.equal(history.managed[0].remoteSessionId,'writer');assert.equal(history.managed[0].hostId,'host');
});
