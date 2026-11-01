const test=require('node:test'),assert=require('node:assert/strict');
const {validate,createGitService}=require('../src/git-service.cjs');
const {RemoteDesktop}=require('../src/hosts/desktop.cjs');
test('Git write IPC rejects arbitrary commands, arguments and unbounded payloads',()=>{
  const options={operationId:'operation-123',expected:'a'.repeat(64),message:'line one\n\n`literal` $(literal)'};
  assert.doesNotThrow(()=>validate('/work','app','commit',options));
  for(const [action,o]of [['exec',options],['push',{...options,force:true}],['commit',{...options,expected:''}],['stage-selection',{...options,selection:['../../x']}],['commit',{...options,message:'x'.repeat(20001)}]])assert.throws(()=>validate('/work','app',action,o));
});
test('unlisted Work never reaches WSL and lifecycle operations use admission',async()=>{
  let calls=0,admitted=0;
  const service=createGitService({listWorks:async()=>[],execute:()=>{calls++;},lifecycle:async()=>{admitted++;}});
  await assert.rejects(service('/unknown','app','snapshot'),/无效工作根/);assert.equal(calls,0);assert.equal(admitted,0);
});
test('remote workspace calls bind host and root and negotiate each capability',async()=>{
  const calls=[],connection={hello:{capabilities:['workspace.files.read']},request:async(...args)=>{calls.push(args);return{path:'file.txt'};}};
  const desktop={registry:{get:async id=>({root:id==='host-b'?'/other':'/same'})},connectHost:async()=>({connection})};
  const call=RemoteDesktop.prototype.workspaceCall.bind(desktop);
  assert.deepEqual(await call('host-a','/same','workspace.files.read',{reference:'file.txt'}),{path:'file.txt'});
  await assert.rejects(call('host-b','/same','workspace.files.read'),/不属于/);
  await assert.rejects(call('host-a','/same','workspace.git'),/版本尚不支持/);assert.equal(calls.length,1);
  desktop.paused=new Set(['host-a']);await assert.rejects(call('host-a','/same','workspace.files.read'),/已手动断开/);assert.equal(calls.length,1);
});
