const test=require('node:test'),assert=require('node:assert/strict');
const {stopSession}=require('../src/session-stop.cjs');

test('SSH settled snapshots delayed by persistence cannot stop a newer turn',async()=>{
  const {RemoteDesktop}=require('../src/hosts/desktop.cjs');let release;const events=[];
  const item={saved:{id:'one'},session:{record:{},request:async()=>({isSettled:true})}};
  const desktop=Object.create(RemoteDesktop.prototype);desktop.get=()=>item;desktop.persist=()=>new Promise(resolve=>release=resolve);desktop.send=e=>events.push(e);
  const pending=desktop.request('one','get_state');await new Promise(resolve=>setImmediate(resolve));desktop.emit(item,{type:'agent_start'});release();
  assert.equal((await pending).isSettled,undefined);assert.equal(events.at(-1).isSettled,undefined);
});

test('stop cancels the current harness subagents while foreground abort is still pending, and restores its queue once',async()=>{
  const calls=[];let release;
  const session={request(type,data){calls.push({type,data});
    if(type==='abort_and_restore_queue')return new Promise(resolve=>release=resolve);
    if(type==='get_subagents')return Promise.resolve({subagents:[{id:'a',status:'running'},{id:'b',status:'pending'},{id:'idle',status:'idle'},{id:'done',status:'completed'},{id:'a',status:'running'}]});
    if(type==='cancel_subagent'){if(data.subagentId==='b')release({followUp:[{text:'retain',images:[{data:'image'}]}]});return Promise.resolve({cancelled:true});}
  }};
  const first=stopSession(session,'abort_and_restore_queue'),second=stopSession(session,'abort_and_restore_queue');assert.equal(first,second);
  const result=await first;assert.equal(result.followUp[0].images[0].data,'image');
  assert.deepEqual(calls.filter(c=>c.type==='cancel_subagent').map(c=>c.data.subagentId),['a','b']);
  assert.equal(calls.filter(c=>c.type==='abort_and_restore_queue').length,1);
});

test('a child cancellation error preserves native queue and does not replay the mutation',async()=>{
  const calls=[];const session={async request(type){calls.push(type);if(type==='abort_and_restore_queue')return {steering:[{text:'retain'}]};if(type==='get_subagents')return {subagents:[{id:'child',status:'running'}]};throw Error('transport lost');}};
  const result=await stopSession(session,'abort_and_restore_queue');assert.equal(result.steering[0].text,'retain');assert.match(result.stopError,/transport lost/);assert.equal(calls.filter(t=>t==='cancel_subagent').length,1);
});

test('failed abort never silently succeeds or retries after an uncertain disconnect',async()=>{
  let count=0;const session={async request(type){if(type==='get_subagents')return {subagents:[]};if(type==='get_background_tasks')return {tasks:[]};count++;throw Error('uncertain');}};
  await assert.rejects(stopSession(session,'abort'),/uncertain/);assert.equal(count,1);
});

test('a child admitted during abort is cancelled by the final snapshot without replaying earlier cancellations',async()=>{
  let snapshots=0;const cancelled=[];const session={async request(type,data){
    if(type==='abort_and_restore_queue')return {followUp:[]};
    if(type==='get_subagents')return {subagents:[{id:'earlier',status:'running'},...(++snapshots===2?[{id:'late',status:'pending'}]:[])]};
    if(type==='get_background_tasks')return {tasks:[]};
    cancelled.push(data.subagentId);return {cancelled:true};
  }};
  await stopSession(session,'abort_and_restore_queue');assert.deepEqual(cancelled,['earlier','late']);
});

test('stop cancels only active background task instances and preserves the native queue',async()=>{
  const calls=[];
  const session={async request(type,data){
    calls.push({type,data});
    if(type==='abort_and_restore_queue')return {followUp:[{text:'keep this queued'}]};
    if(type==='get_subagents')return {subagents:[]};
    if(type==='get_background_tasks')return {tasks:[
      {id:'build',kind:'job',status:'running',startedAt:11},
      {id:'watch',kind:'daemon',status:'starting',startedAt:12},
      {id:'finished',kind:'job',status:'completed',startedAt:13},
      {id:'unknown',kind:'job',status:'unknown',startedAt:14},
      {id:'missing-time',kind:'job',status:'running'}
    ]};
    if(type==='cancel_background_task')return {accepted:true};
    throw Error(`unexpected ${type}`);
  }};
  const result=await stopSession(session,'abort_and_restore_queue');
  assert.equal(result.followUp[0].text,'keep this queued');
  assert.deepEqual(calls.filter(call=>call.type==='cancel_background_task').map(call=>call.data),[
    {taskId:'build',kind:'job',startedAt:11},
    {taskId:'watch',kind:'daemon',startedAt:12}
  ]);
});

test('stop sweeps background tasks admitted during abort and never repeats a task instance',async()=>{
  let snapshots=0;const cancelled=[];
  const session={async request(type,data){
    if(type==='abort_and_restore_queue')return {steering:[]};
    if(type==='get_subagents')return {subagents:[]};
    if(type==='get_background_tasks')return {tasks:[
      {id:'build',kind:'job',status:'running',startedAt:21},
      ...(++snapshots===2?[{id:'late',kind:'job',status:'pending',startedAt:22}]:[])
    ]};
    if(type==='cancel_background_task'){cancelled.push(data);return {accepted:true};}
    throw Error(`unexpected ${type}`);
  }};
  await stopSession(session,'abort_and_restore_queue');
  assert.deepEqual(cancelled,[
    {taskId:'build',kind:'job',startedAt:21},
    {taskId:'late',kind:'job',startedAt:22}
  ]);
});

test('background cancellation failure is reported without losing the restored queue or replaying cancellation',async()=>{
  const calls=[];
  const session={async request(type){
    calls.push(type);
    if(type==='abort_and_restore_queue')return {steering:[{text:'keep this message'}]};
    if(type==='get_subagents')return {subagents:[]};
    if(type==='get_background_tasks')return {tasks:[{id:'build',kind:'job',status:'running',startedAt:31}]};
    if(type==='cancel_background_task')throw Error('task instance changed');
  }};
  const result=await stopSession(session,'abort_and_restore_queue');
  assert.equal(result.steering[0].text,'keep this message');
  assert.match(result.stopError,/task instance changed/);
  assert.equal(calls.filter(type=>type==='cancel_background_task').length,1);
});

test('older OMP clients without background task support keep the stop operation compatible',async()=>{
  const calls=[];
  const session={async request(type){
    calls.push(type);
    if(type==='abort_and_restore_queue')return {followUp:[]};
    if(type==='get_subagents')return {subagents:[]};
    if(type==='get_background_tasks')throw Error('unknown command get_background_tasks');
  }};
  const result=await stopSession(session,'abort_and_restore_queue');
  assert.equal(result.stopError,undefined);
  assert.equal(calls.filter(type=>type==='get_background_tasks').length,1);
});

test('stop skips noncancellable tasks and treats an already-ended task instance as settled',async()=>{
  const calls=[];
  const session={async request(type){
    calls.push(type);
    if(type==='abort_and_restore_queue')return {followUp:[]};
    if(type==='get_subagents')return {subagents:[]};
    if(type==='get_background_tasks')return {tasks:[
      {id:'legacy-daemon',kind:'daemon',status:'running',startedAt:41,cancellable:false},
      {id:'ended-job',kind:'job',status:'running',startedAt:42,cancellable:true}
    ]};
    if(type==='cancel_background_task')throw Error('Task has ended, changed instance, or is outside this session');
  }};
  const result=await stopSession(session,'abort_and_restore_queue');
  assert.equal(result.stopError,undefined);
  assert.equal(calls.filter(type=>type==='cancel_background_task').length,1);
});

test('a transient unavailable background task transport is reported, not treated as unsupported',async()=>{
  const session={async request(type){
    if(type==='abort_and_restore_queue')return {steering:[]};
    if(type==='get_subagents')return {subagents:[]};
    if(type==='get_background_tasks')throw Error('service unavailable: socket closed');
  }};
  const result=await stopSession(session,'abort_and_restore_queue');
  assert.match(result.stopError,/service unavailable/);
});
