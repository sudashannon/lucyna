const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {SessionTasks,taskCounts}=require('../src/renderer/session-tasks.ts');
const {validateTaskRequest,selectTaskHistory}=require('../src/task-rpc.cjs');
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
const runningJob=(id,startedAt)=>({id,key:`job:${id}`,kind:'job',title:id,startedAt,status:'running',cancellable:true,output:`Running background task ${id}...`});
const waitResult=(timestamp,...jobs)=>({role:'toolResult',toolName:'wait',timestamp,details:{op:'wait',jobs}});
test('reopening a conversation settles saved background cards using the latest recorded result',()=>{
 const a=new SessionTasks(async()=>({}),()=>{});
 a.restore([runningJob('review',1000),runningJob('other',5000),runningJob('cancelled',4000),runningJob('relaunched',1000)]);
 a.restoreHistory([
  {timestamp:new Date(2000).toISOString(),customType:'async-result',details:{jobs:[{jobId:'review',status:'completed',durationMs:1000},{jobId:'relaunched',status:'completed'}]}},
  waitResult(3000,{id:'other',status:'completed',durationMs:500}),
  {role:'toolResult',toolName:'task',timestamp:4000,details:{async:{state:'running',jobId:'relaunched'}}},
  waitResult(7000,{id:'review',status:'completed',durationMs:2700,resultText:'review result'},{id:'cancelled',status:'cancelled'}),
 ]);
 const review=a.items.find(t=>t.id==='review');
 assert.deepEqual([review.status,review.durationMs,review.stale,review.cancellable,review.output],['completed',2700,false,false,'review result']);
 for(const id of ['other','cancelled','relaunched'])assert.equal(a.items.find(t=>t.id===id).status,'unknown');
});
test('live job results win over a delayed snapshot, and a later run may reuse the job ID',async()=>{
 const reply=deferred();let snapshot=reply.promise;
 const a=new SessionTasks(async type=>type==='get_subagents'?{subagents:[]}:snapshot,()=>{});
 a.restore([runningJob('review',1000)]);a.connected=true;
 try{
  const pending=a.refresh();
  a.event({type:'message_end',message:waitResult(4000,{id:'review',status:'completed',durationMs:2500})});
  reply.resolve({tasks:[runningJob('review',1000)]});await pending;
  await a.refresh();
  assert.deepEqual([a.items[0].status,a.items[0].durationMs,a.items[0].output],['completed',2500,'']);
  snapshot=Promise.resolve({tasks:[runningJob('review',5000)]});await a.refresh();
  assert.deepEqual([a.items[0].status,a.items[0].startedAt,a.items[0].durationMs],['running',5000,undefined]);
 }finally{a.disconnect();}
});
test('missing cards recover compacted job results from the current branch only',async()=>{
 const entries=[
  {id:'result',type:'message',parentId:null,message:waitResult(4000,{id:'review',status:'completed',durationMs:2500},{id:'other',status:'completed'})},
  {id:'side',type:'message',parentId:'result',message:waitResult(6000,{id:'review',status:'failed'})},
  {id:'compact',type:'compaction',parentId:'result'},
 ];
 const a=new SessionTasks(async(type,data)=>{
  assert.equal(type,'get_background_task_history');
  assert.deepEqual(data.taskIds,['review']);
  return selectTaskHistory({entries,leafId:'compact'},data.taskIds);
 },()=>{});
 a.restore([runningJob('review',1000)]);a.connected=true;
 await a.reconcileHistory();
 assert.deepEqual(a.items.map(t=>[t.id,t.status,t.durationMs]),[['review','completed',2500]]);
});
test('older OMP capability errors are not repeatedly probed; subagent observation still works',async()=>{
 let probes=0;const a=new SessionTasks(async type=>{if(type==='get_background_tasks'){probes++;throw Error('Unknown command');}return {subagents:[agent()]};},()=>{});
 a.connected=true;await a.refresh();await a.refresh();assert.equal(probes,1);assert.equal(a.background,'unsupported');assert.equal(a.items[0].status,'running');a.disconnect();
});
test('task IPC refuses arbitrary journals, forged RPC ids and non-instance cancellation',()=>{
 assert.throws(()=>validateTaskRequest('get_subagent_messages',{subagentId:'x',sessionFile:'/etc/passwd'}));
 assert.throws(()=>validateTaskRequest('get_background_tasks',{id:'forged'}));
 assert.throws(()=>validateTaskRequest('get_background_task_history',{taskIds:['review'],sessionFile:'/etc/passwd'}));
 assert.throws(()=>validateTaskRequest('cancel_background_task',{taskId:'x',kind:'daemon'}));
 assert.throws(()=>validateTaskRequest('get_subagent_messages',{subagentId:'x',fromByte:-1}));
 assert.equal(validateTaskRequest('cancel_background_task',{taskId:'x',kind:'daemon',startedAt:1}),true);
});
