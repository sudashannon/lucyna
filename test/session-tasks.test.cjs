const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {SessionTasks,taskCounts}=require('../src/renderer/session-tasks.ts');
const {validateTaskRequest}=require('../src/task-rpc.cjs');
const agent=(id='one',extra={})=>({id,agent:'检查构建',sessionFile:`/tmp/${id}.jsonl`,parentToolCallId:'task-call',status:'running',...extra});
const event=(p,status='started')=>({type:'subagent_lifecycle',payload:{...p,status}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('late snapshots cannot revive a completed child or contaminate another conversation',async()=>{
 const reply=deferred(),a=new SessionTasks(type=>type==='get_subagents'?reply.promise:Promise.resolve({tasks:[]}),()=>{}),b=new SessionTasks(async()=>({}),()=>{});
 a.connected=true;const pending=a.refresh();a.event(event(agent()));a.event(event(agent(),'completed'));reply.resolve({subagents:[agent()]});await pending;
 assert.equal(a.items[0].status,'completed');assert.equal(b.items.length,0);a.disconnect();b.disconnect();
});
test('individual stop only addresses the selected child and remains pending until native completion',async()=>{
 const ack=deferred(),calls=[],a=new SessionTasks(async(type,data)=>{calls.push({type,data});return type==='cancel_subagent'?ack.promise:type==='get_subagents'?{subagents:[agent(),agent('two')]}:type==='get_background_tasks'?{tasks:[]}:{};},()=>{});
 a.connected=true;a.event(event(agent()));a.event(event(agent('two')));const cancel=a.cancel(a.items[0].key);await Promise.resolve();
 assert.equal(a.items.find(t=>t.id==='one').status,'stopping');assert.equal(a.items.find(t=>t.id==='two').status,'running');
 assert.deepEqual(calls.filter(c=>c.type.startsWith('cancel')).map(c=>c.data.subagentId),['one']);
 a.event(event(agent(),'aborted'));assert.equal(a.items.find(t=>t.id==='one').status,'stopping');ack.resolve({cancelled:true});await cancel;assert.equal(a.items.find(t=>t.id==='one').status,'aborted');a.disconnect();
});
test('a re-used child id is rejected before cancellation; lost SSH never retries the mutation',async()=>{
 const calls=[],a=new SessionTasks(async(type,data)=>{calls.push(type);if(type==='get_subagents')return {subagents:[agent('one',{parentToolCallId:'new-call'})]};return {};},()=>{});
 a.connected=true;a.event(event(agent()));await a.cancel(a.items[0].key);assert.ok(!calls.includes('cancel_subagent'));assert.ok(a.items[0].error);
 a.disconnect();await a.cancel(a.items[0].key);assert.ok(!calls.includes('cancel_subagent'));
});
test('background task instance, output tail, terminal history and connection state are preserved',async()=>{
 const a=new SessionTasks(async type=>type==='get_subagents'?{subagents:[]}:{tasks:[{id:'job',kind:'job',startedAt:100,title:'build',status:'running',cancellable:true,output:'x'.repeat(100000)}]},()=>{});
 a.connected=true;await a.refresh();assert.equal(a.items[0].output.length,65536);a.disconnect();assert.equal(a.items[0].stale,true);assert.deepEqual(taskCounts(a.items),{running:0,unknown:1,failed:0});
 const b=new SessionTasks(async()=>({}),()=>{});b.restore(a.saved());assert.equal(b.items[0].status,'unknown');assert.equal(b.items[0].cancellable,false);
 b.restoreHistory([{customType:'async-result',details:{jobs:[{jobId:'finished',status:'completed',label:'done'}]}}]);assert.equal(b.items.find(t=>t.id==='finished').status,'completed');b.disconnect();
});
test('older OMP capability errors are not repeatedly probed; subagent observation still works',async()=>{
 let probes=0;const a=new SessionTasks(async type=>{if(type==='get_background_tasks'){probes++;throw Error('Unknown command');}return {subagents:[agent()]};},()=>{});
 a.connected=true;await a.refresh();await a.refresh();assert.equal(probes,1);assert.equal(a.background,'unsupported');assert.equal(a.items[0].status,'running');a.disconnect();
});
test('task IPC refuses arbitrary journals, forged RPC ids and non-instance cancellation',()=>{
 assert.throws(()=>validateTaskRequest('get_subagent_messages',{subagentId:'x',sessionFile:'/etc/passwd'}));
 assert.throws(()=>validateTaskRequest('get_background_tasks',{id:'forged'}));
 assert.throws(()=>validateTaskRequest('cancel_background_task',{taskId:'x',kind:'daemon'}));
 assert.throws(()=>validateTaskRequest('get_subagent_messages',{subagentId:'x',fromByte:-1}));
 assert.equal(validateTaskRequest('cancel_background_task',{taskId:'x',kind:'daemon',startedAt:1}),true);
});
