const test=require('node:test'),assert=require('node:assert/strict');
const {SessionManager}=require('../src/session-manager.cjs');
function fixture(){const events=[],native=[];const manager=new SessionManager({send:e=>events.push(e),create:send=>{const session={child:null,ready:true,async start(o){this.options=o;this.child={pid:native.length};return {pid:this.child.pid};},async request(type){this.last=type;return type==='get_state'?{sessionFile:this.options.resume||`C:/sessions/${this.child.pid}.jsonl`}:{ok:true};},messages:async()=>({messages:[]}),sendFrame(data){this.frame=data;},async close(){this.child=null;send({type:'process_exit',code:0});},emit:send};native.push(session);return session;}});const start=(id,resume)=>manager.start(id,run=>run({root:'/work/'+id,agentDir:'C:/agent',settings:{runtime:'wsl'},resume}));return{manager,native,events,start};}
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
test('native WSL writer ownership unifies Linux and UNC names while retaining Linux case',async()=>{
 const {manager,start}=fixture();await start('a','/home/user/.omp/agent/sessions/-develop-a/Session.jsonl');
 await assert.rejects(start('b','\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.omp\\agent\\sessions\\-develop-a\\Session.jsonl'),/已在另一/);
 await start('c','/home/user/.omp/agent/sessions/-develop-a/session.jsonl');assert.equal(manager.list().length,2);await manager.closeAll();
});
