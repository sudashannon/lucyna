const test=require('node:test'),assert=require('node:assert/strict');
const {TerminalSession}=require('../src/terminal.cjs');
const root='/home/user/develop/test';
function fixture(extra={}){
  const events=[],processes=[];
  const terminal=new TerminalSession({listWorks:async()=>[{root,kind:'work'}],send:e=>events.push(e),createPty:()=>{const proc={kills:0,onData(fn){this.data=fn;},onExit(fn){this.exit=fn;},kill(){this.kills++;},write(){},resize(){}};processes.push(proc);return proc;},...extra});
  return {terminal,events,processes};
}
test('cancel during discovery prevents a late shell and does not clear a newer terminal',async()=>{
  let release;const {terminal,processes}=fixture({listWorks:()=>new Promise(resolve=>{release=resolve;})});
  const first=terminal.start(root,{requestId:'first'});const rejected=assert.rejects(first,/已取消/);
  assert.equal(await terminal.close('first'),true);
  terminal.listWorks=async()=>[{root,kind:'work'}];await terminal.start(root,{requestId:'second'});
  release([{root,kind:'work'}]);await rejected;
  assert.equal(processes.length,1);assert.equal(terminal.record.id,'second');
  terminal.dispose();
});
test('stop acknowledges only actual exit and keeps new starts blocked until then',async()=>{
  const {terminal,processes,events}=fixture();await terminal.start(root,{requestId:'owned'});
  let closed=false;const pending=terminal.close('owned').then(()=>{closed=true;});
  await Promise.resolve();assert.equal(closed,false);await assert.rejects(terminal.start(root),/已有/);
  processes[0].exit({exitCode:0});await pending;assert.equal(terminal.record,null);
  assert.equal(events.at(-1).type,'exit');await terminal.start(root,{requestId:'next'});terminal.dispose();
});
test('natural exit clears ownership before notifying the renderer',async()=>{
  let terminal;const f=fixture({send:e=>{if(e.type==='exit')assert.equal(terminal.record,null);}});terminal=f.terminal;
  await terminal.start(root,{requestId:'first'});f.processes[0].exit({exitCode:0});
  assert.equal(await terminal.close('first'),false);await terminal.start(root,{requestId:'second'});
  assert.equal(await terminal.close('first'),false);assert.equal(f.processes[1].kills,0);terminal.dispose();
});
test('spawn and discovery failures release admission for retry',async()=>{
  const {terminal}=fixture({createPty:()=>{throw Error('fixture spawn error');}});
  await assert.rejects(terminal.start(root),/fixture spawn error/);assert.equal(terminal.record,null);
  terminal.listWorks=async()=>[];await assert.rejects(terminal.start(root),/无效工作根/);assert.equal(terminal.record,null);
});
test('close timeout preserves ownership and allows explicit retry',async()=>{
  const {terminal,processes}=fixture({closeTimeoutMs:10});await terminal.start(root,{requestId:'hung'});
  await assert.rejects(terminal.close('hung'),/尚未退出/);assert.equal(terminal.record.id,'hung');
  const retry=terminal.close('hung');assert.equal(processes[0].kills,2);processes[0].exit({exitCode:0});await retry;
});
