const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {Workbench}=require('../src/renderer/workbench-store.ts');
const {isCompletedUnread}=require('../src/renderer/session-monitor.ts');
const tick=()=>new Promise(r=>setImmediate(r));

test('completed unread waits for native settlement and reading the conversation, not its monitor',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const s=f.store.active;await s.send('background work');
 f.store.setConversationVisible(false);
 f.emit({type:'prompt_result',clientSessionId:s.id,status:'completed',sessionSettled:false});
 assert.equal(s.unread,false);assert.equal(isCompletedUnread(f.store.view().sessions[0]),false);assert.ok(s.busy);
 f.emit({type:'session_settled',clientSessionId:s.id});
 assert.equal(isCompletedUnread(f.store.view().sessions[0]),true);
 f.store.setConversationVisible(false);f.store.selectSession(s.id);assert.equal(s.unread,true);
 f.store.setConversationVisible(true);assert.equal(s.unread,false);
 f.emit({type:'session_settled',clientSessionId:s.id});assert.equal(s.unread,false);
 await s.send('next run');f.emit({type:'prompt_result',clientSessionId:s.id,status:'completed'});assert.equal(s.unread,false);
 assert.equal(f.calls.filter(c=>c.type==='close'||c.type==='abort_and_restore_queue').length,0);f.store.dispose();
});

test('completed unread excludes running, stopped, failed, disconnected, read and question sessions',()=>{
 const completed={connection:'ready',unread:true,busy:false,questions:0,error:false,run:{outcome:'completed'}};
 assert.equal(isCompletedUnread(completed),true);
 for(const patch of [{busy:true},{connection:'idle'},{connection:'closing'},{unread:false},{questions:1},{error:true},{run:null},{run:{outcome:'aborted'}},{run:{outcome:'error'}}])assert.equal(isCompletedUnread({...completed,...patch}),false,JSON.stringify(patch));
});

test('opening a completed peer clears only that session and preserves running peers and draft identities',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const a=f.store.active;await a.send('A');await f.store.selectWork(f.works[1]);const b=f.store.active;await b.send('B');const keys=[a.draftKey,b.draftKey];
 f.emit({type:'prompt_result',clientSessionId:a.id,status:'completed'});assert.ok(a.unread);
 f.store.setConversationVisible(false);f.store.selectSession(a.id);assert.ok(a.unread);
 f.store.setConversationVisible(true);assert.equal(a.unread,false);assert.ok(b.busy);assert.deepEqual([a.draftKey,b.draftKey],keys);
 assert.equal(f.calls.filter(c=>c.type==='close'||c.type==='abort_and_restore_queue').length,0);f.store.dispose();
});
test('timeline invalidates only at semantic boundaries, not per token or tool output chunk',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const s=f.store.active;await s.send('hello');const before=s.timelineRevision;
 for(let i=0;i<100;i++)f.emit({clientSessionId:s.id,type:'message_update',messageId:'stream',assistantMessageEvent:{type:'text_delta',delta:'x'}});
 assert.equal(s.timelineRevision,before);f.emit({clientSessionId:s.id,type:'message_end',messageId:'stream',message:{role:'assistant',content:[{type:'text',text:'finished'}]}});assert.ok(s.timelineRevision>before);assert.equal(f.store.view().sessions[0].summary,'finished');f.store.dispose();
});
function setup(){
 const values=new Map();global.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
 const works=['a','b'].map(name=>({name,root:'/work/'+name,kind:'work'})),calls=[],states=new Map(),messages=new Map();let emit;
 const api={listWorks:async()=>works,listConnections:async()=>[],readWork:async root=>root+' notes',listHistory:async()=>({sessions:[],managed:[]}),getSettings:async()=>({settings:{runtime:'wsl'}}),onEvent(fn){emit=fn;return()=>{};},
 async start(options){calls.push({type:'start',...options});states.set(options.clientSessionId,{sessionId:options.clientSessionId,sessionFile:options.resume||'C:/'+options.clientSessionId+'.jsonl',model:{name:'native'}});setImmediate(()=>emit({type:'ready',clientSessionId:options.clientSessionId,runtime:'wsl'}));return {runtime:'wsl',agentDir:'C:/agent'};},
 async request(type,data,id){calls.push({type,id,data});if(type==='get_state')return states.get(id);if(type==='get_messages')return {messages:messages.get(id)||[]};if(type==='prompt'){emit({clientSessionId:id,type:'agent_start'});return {};}if(type==='abort_and_restore_queue'){emit({clientSessionId:id,type:'prompt_result',status:'aborted'});return {followUp:[{text:'queued for '+id}]};}return {};},
 async close(id){calls.push({type:'close',id});emit({clientSessionId:id,type:'process_exit',code:0});},respond:async(data,id)=>{calls.push({type:'answer',id,data});}};
 const store=new Workbench(api);store.connect();return {store,api,works,calls,states,messages,emit:e=>emit(e)};
}

test('text attachments save before prompt, keep ownership across work switches, and restore queue as native local references',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const a=f.store.active;let release;
 f.api.prepareTextAttachments=(id,files)=>{f.calls.push({type:'prepare',id,files});return new Promise(r=>release=()=>r(files.map(file=>({id:file.id,url:'local://paste-lucyna-'+'a'.repeat(32)+'.md'}))));};
 const sent=a.send('read attachment',[],[{id:'text-a',name:'text.md',text:'private content'.repeat(100),mode:'file'}]);
 while(!release)await tick();assert.equal(f.calls.filter(c=>c.type==='prompt').length,0);assert.equal(await a.close(),false);
 await f.store.selectWork(f.works[1]);const b=f.store.active;await b.send('peer');release();assert.equal(await sent,true);
 const prompt=f.calls.find(c=>c.type==='prompt'&&c.id===a.id);assert.ok(prompt.data.message.includes('local://'));assert.ok(!prompt.data.message.includes('private content'));assert.equal(prompt.data.streamingBehavior,'followUp');assert.equal(f.store.active.id,b.id);
 f.api.request=async(type,data,id)=>type==='abort_and_restore_queue'?{followUp:[{text:prompt.data.message}]}:{};
 assert.equal((await a.stop())[0].text,prompt.data.message);f.store.dispose();
});
test('failed attachment storage never prompts; retry keeps same attachment and inline mode bypasses disk',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const a=f.store.active,files=[{id:'text-a',name:'a.md',text:'unchanged\r\n'.repeat(100),mode:'file'}];
 f.api.prepareTextAttachments=async()=>{throw Error('disk failed');};assert.equal(await a.send('body',[],files),false);assert.equal(f.calls.filter(c=>c.type==='prompt').length,0);assert.ok(a.error.includes('disk failed'));assert.equal(a.view.messages.length,0);
 assert.equal(await a.send('body',[],[{...files[0],mode:'inline'}]),true);assert.equal(f.calls.find(c=>c.type==='prompt').data.message,'body\n\n'+files[0].text);f.store.dispose();
});

test('recycled open tab preserves its transcript and draft identity, blocks reconnect, and becomes resumable after restore',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const a=f.store.active;await a.send('keep draft identity');await a.stop();await a.close();const source=a.sessionFile,draftKey=a.draftKey,messages=a.view.messages;
 await f.store.selectWork(f.works[1]);const b=f.store.active;await b.send('peer keeps running');const starts=f.calls.filter(c=>c.type==='start').length;
 f.emit({type:'history_deleted',source,workRoot:f.works[0].root});await assert.rejects(a.start(),/回收站/);assert.equal(f.calls.filter(c=>c.type==='start').length,starts);assert.equal(a.draftKey,draftKey);assert.equal(a.view.messages,messages);assert.ok(b.busy);assert.ok(JSON.parse(localStorage.getItem('omp.openSessions.v1')).sessions.find(s=>s.id===a.id).historyDeleted);
 f.emit({type:'history_restored',source,workRoot:f.works[0].root});await a.start();assert.equal(f.calls.filter(c=>c.type==='start').at(-1).resume,source);assert.ok(b.busy);assert.equal(a.draftKey,draftKey);f.store.dispose();
});
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

test('background empty sessions are pruned only after draft, image and terminal ownership checks',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const empty=f.store.active;
 const draft=f.store.create(f.works[0]),image=f.store.create(f.works[0]),terminal=f.store.create(f.works[0]);
 const historical=f.store.create(f.works[0]);historical.sessionFile='history.jsonl';
 await f.store.selectWork(f.works[1]);const active=f.store.active;
 f.store.pruneEmpty(new Set([draft.draftKey,image.draftKey]),new Set([terminal.id]));
 assert.ok(!f.store.sessions.has(empty.id));for(const s of [draft,image,terminal,historical,active])assert.ok(f.store.sessions.has(s.id));
 assert.equal(f.calls.filter(c=>c.type==='close').length,0);f.store.dispose();
});
test('slow import has a selectable placeholder immediately and never steals focus back from another work',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);let resolveImport;
 f.store.api.importSession=()=>new Promise(resolve=>{resolveImport=resolve;});
 const entry={path:'/original.jsonl',title:'Slow import'},pending=f.store.resume(entry);await tick();const importing=f.store.active;
 assert.equal(importing.title,'Slow import');assert.equal(importing.connection,'starting');assert.equal(importing.connectionPhase,'正在创建历史副本');
 await f.store.selectWork(f.works[1]);const other=f.store.active;resolveImport({sessionFile:'/copy.jsonl',agentDir:'/profile',runtime:'wsl'});await pending;
 assert.equal(f.store.active,other);assert.equal(importing.connection,'ready');assert.equal(f.calls.filter(c=>c.type==='start').length,1);f.store.dispose();
});
test('failed import retries its placeholder without starting an unimported source',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);f.store.api.importSession=async()=>{throw Error('import offline');};
 const entry={path:'/original.jsonl',title:'retry'};await f.store.resume(entry);const failed=f.store.active;assert.equal(failed.connection,'idle');assert.match(failed.error,/offline/);assert.equal(f.calls.filter(c=>c.type==='start').length,0);
 f.store.api.importSession=async()=>({sessionFile:'/copy.jsonl',agentDir:'/profile',runtime:'wsl'});await f.store.resume(entry);assert.equal(f.store.active,failed);assert.equal(failed.connection,'ready');assert.equal(f.calls.filter(c=>c.type==='start').length,1);f.store.dispose();
});
test('history rendering starts at a bounded tail and keeps its anchor when new output arrives',()=>{
 const {historyStart}=require('../src/renderer/transcript-window.ts');const {restoreMessages}=require('../src/renderer/session-view.ts');
 const raw=[];for(let i=0;i<10000;i++){raw.push({id:'a'+i,role:'assistant',content:[{type:'toolCall',id:'t'+i,name:'bash',arguments:{}}]},{role:'toolResult',toolCallId:'t'+i,content:'result '+i});}
 const messages=restoreMessages(raw);assert.equal(messages.length,20000);assert.equal(messages.at(-1).content,'result 9999');
 const start=historyStart(messages,'');assert.equal(messages.length-start,80);const anchor=messages[start].id;
 assert.equal(historyStart([...messages,{id:'new',role:'user',content:'next'}],anchor),start);
 assert.equal(historyStart(messages,messages[start-80].id),start-80);
});

test('original WSL history opens in place even when a copy with the same provenance is connected',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);
 const original='\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.omp\\agent\\sessions\\work\\old.jsonl';
 const copy=f.store.active;await copy.start();copy.entry={path:original,sessionFile:copy.sessionFile,agentDir:copy.agentDir,runtime:'wsl'};
 f.store.api.importSession=async()=>{throw Error('original must not be copied');};
 await f.store.resume({path:original,sessionFile:original,agentDir:'/home/user/.omp/agent',runtime:'wsl',sourceKind:'native-wsl'});
 const resumed=f.store.active;assert.notEqual(resumed.id,copy.id);assert.equal(resumed.sessionFile,original);assert.equal(copy.connection,'ready');
 assert.equal(f.calls.filter(c=>c.type==='start').at(-1).resume,original);
 assert.equal(f.calls.filter(c=>c.type==='close').length,0);
 await f.store.resume({sessionFile:original,agentDir:'/home/user/.omp/agent',runtime:'wsl'});assert.equal(f.store.active,resumed);assert.equal(f.calls.filter(c=>c.type==='start').length,2);f.store.dispose();
});

test('explicit copies and runtime changes copy once without replacing the source conversation',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);const original=f.store.active;await original.start();const entry={sessionFile:original.sessionFile,agentDir:original.agentDir,runtime:'wsl'};
 const imported=[];let target='wsl';f.store.api.importSession=async source=>{imported.push(source);return{sessionFile:'C:/copy-'+imported.length+'.jsonl',agentDir:'C:/profile',runtime:target};};
 await f.store.resume(entry,{copy:true});const copy=f.store.active;assert.notEqual(copy,original);assert.equal(imported.length,1);assert.equal(original.connection,'ready');
 await f.store.resume({sessionFile:copy.sessionFile,agentDir:copy.agentDir,runtime:'wsl'});assert.equal(f.store.active,copy);assert.equal(imported.length,1);
 target='windows';f.store.api.getSettings=async()=>({settings:{runtime:target}});await f.store.resume(entry);assert.equal(imported.length,2);assert.equal(f.calls.filter(c=>c.type==='start').at(-1).runtime,'windows');assert.equal(original.connection,'ready');f.store.dispose();
});

test('slow settings lookup does not steal focus when original history opens in the background',async()=>{
 const f=setup();await tick();await f.store.selectWork(f.works[0]);let ready;
 f.store.api.getSettings=()=>new Promise(resolve=>{ready=()=>resolve({settings:{runtime:'wsl'}});});
 const pending=f.store.resume({sessionFile:'/original.jsonl',agentDir:'/agent',runtime:'wsl'});await f.store.selectWork(f.works[1]);const selected=f.store.active;ready();await pending;
 assert.equal(f.store.active,selected);assert.ok([...f.store.sessions.values()].some(s=>s.sessionFile==='/original.jsonl'&&s.connection==='ready'));f.store.dispose();
});
