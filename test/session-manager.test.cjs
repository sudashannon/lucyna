const test=require('node:test'),assert=require('node:assert/strict');
const {SessionManager}=require('../src/session-manager.cjs');

function fixture(){const events=[],native=[];const manager=new SessionManager({send:e=>events.push(e),create:send=>{const session={child:null,ready:true,async start(o){this.options=o;this.child={pid:native.length};return {pid:this.child.pid};},async request(type){this.last=type;return type==='get_state'?{sessionFile:this.options.resume||`C:/sessions/${this.child.pid}.jsonl`}:{ok:true};},messages:async()=>({messages:[]}),sendFrame(data){this.frame=data;},async close(){this.child=null;send({type:'process_exit',code:0});},emit:send};native.push(session);return session;}});const start=(id,resume)=>manager.start(id,run=>run({root:'/work/'+id,agentDir:'C:/agent',settings:{runtime:'wsl'},resume}));return{manager,native,events,start};}

test('recycling reserves a journal against concurrent resume and refuses connected sessions without stopping peers',async()=>{
 const {manager,start}=fixture(),file='C:/sessions/deleted.jsonl';await start('peer');const release=manager.reserveJournal(file,'native-id');
 await assert.rejects(start('selected',file),/回收站/);assert.equal(manager.list().length,1);
 await assert.rejects(manager.start('copy',run=>run({root:'/work/copy',settings:{runtime:'wsl'},resume:'C:/other.jsonl',resumeId:'native-id'})),/回收站/);
 release();await start('selected',file);assert.throws(()=>manager.reserveJournal(file,'native-id'),/仍有连接/);assert.equal(manager.list().length,2);
 await manager.close('selected');manager.reserveJournal(file,'native-id')();assert.equal(manager.list()[0].id,'peer');
});
test('parallel native processes route events, requests, questions and stop by session only',async()=>{
 const {manager,native,events,start}=fixture();await Promise.all([start('a'),start('b')]);
 native[0].emit({type:'message_end',message:{content:'A'}});native[1].emit({type:'message_end',message:{content:'B'}});
 assert.deepEqual(events.filter(e=>e.type==='message_end').map(e=>e.clientSessionId),['a','b']);
 await manager.request('a','abort_and_restore_queue');assert.equal(native[0].last,'abort_and_restore_queue');assert.equal(native[1].last,undefined);
 native[1].emit({type:'extension_ui_request',method:'ask',id:'q'});assert.throws(()=>manager.respond('a',{id:'q'}),/不属于/);manager.respond('b',{id:'q'});assert.equal(native[1].frame.id,'q');
 await manager.close('a');assert.equal(manager.list().length,1);assert.equal(manager.list()[0].id,'b');await manager.closeAll();
});
test('duplicate history writers rejected during asynchronous admission and released only on exit',async()=>{
 const {manager,native,start}=fixture();await start('a','C:/sessions/shared.jsonl');
 await assert.rejects(start('b','c:\\sessions\\shared.jsonl'),/已在另一/);assert.equal(native[1].child,null);
 await assert.rejects(start('a'),/已有/);await manager.close('a');await start('b','C:/sessions/shared.jsonl');assert.equal(manager.list().length,1);
});
test('new native journals acquire ownership when state becomes available',async()=>{
 const {manager,start}=fixture();await start('a');const state=await manager.request('a','get_state');await assert.rejects(start('b',state.sessionFile),/已在另一/);
 await assert.rejects(manager.start('../escape',()=>{}),/无效/);await manager.closeAll();
});

test('resume refuses a native fallback journal before it can be displayed as the selected history',async()=>{
 const {manager,native,start}=fixture();await start('a','C:/sessions/original.jsonl');
 native[0].request=async()=>({sessionFile:'C:/sessions/fallback.jsonl'});
 await assert.rejects(manager.request('a','get_state'),/OMP 未在所选原会话中续聊/);
 assert.equal(manager.get('a').sessionFile,'C:/sessions/original.jsonl');await manager.closeAll();
});

test('an explicit native fork may select its new journal and finalize provenance once',async()=>{
 const {manager,native}=fixture();let finalized=0;manager.onState=async record=>{if(record.forkSource){finalized++;assert.equal(record.forkSource,'C:/packed.jsonl');record.forkSource=undefined;}};
 await manager.start('copy',run=>run({root:'/work/a',agentDir:'C:/agent',settings:{runtime:'wsl'},resume:'C:/packed.jsonl',fork:true,importRoot:'C:/history'}));
 native[0].request=async()=>({sessionFile:'C:/sessions/fork.jsonl'});await manager.request('copy','get_state');await manager.request('copy','get_state');assert.equal(finalized,1);await manager.closeAll();
});

test('legacy copies sharing a native ID are rejected before launch without changing their journals',async()=>{
 const {manager,native}=fixture();
 const open=(id,runtime,resumeId)=>manager.start(id,run=>run({root:'/work/a',agentDir:'C:/agent',settings:{runtime},resume:'C:/'+id+'.jsonl',resumeId}));
 await open('original','wsl','shared-id');await assert.rejects(open('old-copy','wsl','shared-id'),/原件与旧副本可能共享 ID/);assert.equal(native[1].child,null);
 await open('windows','windows','shared-id');await open('independent','wsl','new-id');assert.equal(manager.list().length,3);
 await manager.close('original');await open('old-copy','wsl','shared-id');assert.equal(manager.list().length,3);await manager.closeAll();
});
test('native WSL writer ownership unifies Linux and UNC names while retaining Linux case',async()=>{
 const {manager,start}=fixture();await start('a','/home/user/.omp/agent/sessions/-develop-a/Session.jsonl');
 await assert.rejects(start('b','\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.omp\\agent\\sessions\\-develop-a\\Session.jsonl'),/已在另一/);
 await start('c','/home/user/.omp/agent/sessions/-develop-a/session.jsonl');assert.equal(manager.list().length,2);await manager.closeAll();
});

test('restored and background task labels use bounded native metadata without another model request',async()=>{
 const {manager,native,events,start}=fixture();await start('a');await start('b');
 native[0].messages=async()=>({messages:[{role:'assistant',content:'NOT A TITLE'},{role:'user',content:[{type:'thinking',thinking:'NOT VISIBLE'},{type:'text',text:'修复后台会话 '.repeat(1000)}]},{role:'user',content:'later request'}]});
 const messages=await manager.request('a','get_messages');assert.equal(messages.messages.length,3);
 const metadata=events.find(e=>e.type==='session_metadata');assert.equal(metadata.clientSessionId,'a');assert.equal(metadata.workRoot,'/work/a');assert.ok(metadata.titleHint.startsWith('修复后台会话'));assert.ok(metadata.titleHint.length<=120);assert.ok(!JSON.stringify(metadata).includes('NOT'));
 await manager.request('b','prompt',{message:'检查独立工作区',images:[]});
 const prompt=events.find(e=>e.type==='client_prompt');assert.equal(prompt.clientSessionId,'b');assert.equal(prompt.titleHint,'检查独立工作区');assert.equal(native[0].last,undefined,'history metadata does not trigger another native request');
 await manager.closeAll();
});
