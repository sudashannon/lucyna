const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {Workbench}=require('../src/renderer/workbench-store.ts');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){
 const values=new Map();global.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
 const works=['a','b'].map(name=>({name,root:'/work/'+name,kind:'work'})),calls=[],states=new Map(),messages=new Map();let emit;
 const api={listWorks:async()=>works,listConnections:async()=>[],readWork:async root=>root+' notes',listHistory:async()=>({sessions:[],managed:[]}),getSettings:async()=>({settings:{runtime:'wsl'}}),onEvent(fn){emit=fn;return()=>{};},
 async start(options){calls.push({type:'start',...options});states.set(options.clientSessionId,{sessionId:options.clientSessionId,sessionFile:options.resume||'C:/'+options.clientSessionId+'.jsonl',model:{name:'native'}});setImmediate(()=>emit({type:'ready',clientSessionId:options.clientSessionId,runtime:'wsl'}));return {runtime:'wsl',agentDir:'C:/agent'};},
 async request(type,data,id){calls.push({type,id,data});if(type==='get_state')return states.get(id);if(type==='get_messages')return {messages:messages.get(id)||[]};if(type==='prompt'){emit({clientSessionId:id,type:'agent_start'});return {};}if(type==='abort_and_restore_queue'){emit({clientSessionId:id,type:'prompt_result',status:'aborted'});return {followUp:[{text:'queued for '+id}]};}return {};},
 async close(id){calls.push({type:'close',id});emit({clientSessionId:id,type:'process_exit',code:0});},respond:async(data,id)=>{calls.push({type:'answer',id,data});}};
 const store=new Workbench(api);store.connect();return {store,works,calls,states,messages,emit:e=>emit(e)};
}
test('A startup continues after selecting B; native updates and stop stay with their owners',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const a=f.store.active,pending=a.send('A question');await f.store.selectWork(f.works[1]);const b=f.store.active;await pending;await b.send('B question');
 f.emit({type:'message_end',clientSessionId:a.id,messageId:'a-answer',message:{role:'assistant',content:[{type:'text',text:'A only'}]}});
 assert.equal(f.store.active,b);assert.equal(a.view.messages.at(-1).content[0].text,'A only');assert.ok(!JSON.stringify(b.view.messages).includes('A only'));
 await b.stop();assert.ok(a.busy);assert.equal(b.busy,false);assert.deepEqual(f.calls.filter(c=>c.type==='abort_and_restore_queue').map(c=>c.id),[b.id]);
 assert.equal(f.calls.filter(c=>c.type==='close').length,0);f.store.dispose();
});

test('work refresh updates diagnostics of existing sessions without stopping running work',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const active=f.store.active;await active.send('running');const id=active.id,key=active.draftKey;
 f.works[0]={...f.works[0],health:'warning',issues:[{code:'branch_mismatch',severity:'warning',message:'different branch'}]};
 await f.store.loadWorks();assert.equal(f.store.active,active);assert.equal(active.id,id);assert.equal(active.draftKey,key);assert.ok(active.busy);assert.equal(active.work.health,'warning');assert.equal(f.calls.filter(c=>c.type==='close').length,0);f.store.dispose();
});

test('refresh clears only obsolete validation errors and keeps the existing conversation',async()=>{
 const f=setup();f.works[0]={...f.works[0],kind:'invalid',error:'old validation error'};await tick();await f.store.selectWork(f.works[0]);const active=f.store.active;assert.equal(active.error,'old validation error');
 f.works[0]={...f.works[0],kind:'work',error:undefined,health:'warning'};await f.store.loadWorks();await tick();assert.equal(f.store.active,active);assert.equal(active.error,'');assert.equal(active.work.kind,'work');assert.ok(f.store.view().document);assert.ok(f.store.view().history);assert.equal(f.calls.filter(c=>c.type==='close').length,0);f.store.dispose();
});
test('same work new sessions retain original run, unread status and pending questions',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const a=f.store.active;await a.send('A');await f.store.newSession();const b=f.store.active;assert.notEqual(a.id,b.id);assert.notEqual(a.draftKey,b.draftKey);assert.ok(a.busy);
 f.emit({type:'extension_ui_request',clientSessionId:a.id,method:'ask',id:'question-a'});assert.equal(a.questions.length,1);assert.equal(b.questions.length,0);assert.ok(a.unread);
 f.store.selectSession(a.id);assert.equal(a.unread,false);await a.answer({value:'yes'});assert.equal(f.calls.find(c=>c.type==='answer').id,a.id);assert.equal(a.questions.length,0);f.store.dispose();
});
test('history selection reuses existing connection; stopped connection resumes same journal',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const a=f.store.active;await a.start();await f.store.newSession();await f.store.resume({sessionFile:a.sessionFile,agentDir:a.agentDir,runtime:'wsl'});assert.equal(f.store.active,a);assert.equal(f.calls.filter(c=>c.type==='start').length,1);
 await a.close();await f.store.resume({sessionFile:a.sessionFile,agentDir:a.agentDir,runtime:'wsl'});assert.equal(f.calls.filter(c=>c.type==='start').at(-1).resume,a.sessionFile);assert.equal(f.calls.filter(c=>c.type==='start').at(-1).runtime,'wsl');f.store.dispose();
});
test('immediate history resume waits for a closing native writer without touching peers',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const a=f.store.active;await a.start();const journal=a.sessionFile;
 let finish;f.store.api.close=id=>new Promise(resolve=>{finish=()=>{f.emit({type:'process_exit',clientSessionId:id,code:0});resolve();};});
 const closing=a.close();const resuming=f.store.resume({sessionFile:journal,agentDir:a.agentDir,runtime:'wsl'});await tick();assert.equal(f.calls.filter(c=>c.type==='start').length,1);
 finish();await closing;await resuming;assert.equal(f.calls.filter(c=>c.type==='start').length,2);assert.equal(a.sessionFile,journal);assert.equal(a.connection,'ready');f.store.dispose();
});

test('renderer reattaches a running native writer without paging or closing it, then hydrates after settlement',async()=>{
 const f=setup(),id='reattach-running';
 f.states.set(id,{sessionFile:'C:/running.jsonl',isStreaming:true,isSettled:false});
 f.store.api.listConnections=async()=>[{id,root:f.works[0].root,agentDir:'C:/agent',runtime:'wsl',ready:true,busy:true}];
 await tick();const s=f.store.sessions.get(id);assert.equal(s.connection,'ready');assert.ok(s.busy);assert.ok(s.historyPending);
 assert.equal(f.calls.filter(c=>c.type==='get_messages'||c.type==='close').length,0);
 f.states.set(id,{sessionFile:'C:/running.jsonl',isStreaming:false,isSettled:true});f.messages.set(id,[{role:'assistant',content:[{type:'text',text:'finished while attached'}]}]);
 f.emit({type:'session_settled',clientSessionId:id});await tick();
 assert.equal(s.busy,false);assert.equal(s.historyPending,false);assert.equal(s.view.messages.at(-1).content[0].text,'finished while attached');assert.equal(f.calls.filter(c=>c.type==='close').length,0);f.store.dispose();
});

test('native state clears a stale busy snapshot when task finished during renderer reload',async()=>{
 const f=setup(),id='reattach-settled';f.states.set(id,{sessionFile:'C:/settled.jsonl',isStreaming:false,isSettled:true});
 f.store.api.listConnections=async()=>[{id,root:f.works[0].root,agentDir:'C:/agent',runtime:'wsl',ready:true,busy:true}];
 await tick();const s=f.store.sessions.get(id);assert.equal(s.busy,false);assert.equal(s.connection,'ready');assert.equal(s.historyPending,false);assert.equal(f.calls.filter(c=>c.type==='get_messages').length,1);assert.equal(f.calls.filter(c=>c.type==='close').length,0);f.store.dispose();
});

test('transient history error on renderer reattach leaves native process open and retries after settlement',async()=>{
 const f=setup(),id='reattach-race';f.states.set(id,{sessionFile:'C:/race.jsonl',isSettled:true});
 f.store.api.listConnections=async()=>[{id,root:f.works[0].root,agentDir:'C:/agent',runtime:'wsl',ready:true,busy:false}];
 const request=f.store.api.request;let refused=true;f.store.api.request=async(...args)=>{if(args[0]==='get_messages'&&refused)throw Error('Cannot page messages while the session is changing');return request(...args);};
 await tick();const s=f.store.sessions.get(id);assert.equal(s.connection,'ready');assert.ok(s.historyPending);assert.equal(f.calls.filter(c=>c.type==='close').length,0);
 refused=false;f.emit({type:'session_settled',clientSessionId:id});await tick();assert.equal(s.historyPending,false);assert.equal(f.calls.filter(c=>c.type==='close').length,0);f.store.dispose();
});
