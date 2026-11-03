const test = require('node:test');
const assert = require('node:assert/strict');
const { wslUnc } = require('../src/backend.cjs');

test('force-stop addresses only the captured WSL launch token and waits for the writer close event',async()=>{
 const {EventEmitter}=require('node:events'),{OmpSession}=require('../src/backend.cjs');let finishKill,done=false;const calls=[];
 const session=new OmpSession(()=>{},undefined,{executeTermination:(file,args)=>{calls.push({file,args});return new Promise(resolve=>finishKill=resolve);}});
 const child=new EventEmitter();session.child=child;session.processRuntime='wsl';session.sessionToken='12345678-1234-1234-1234-123456789abc';
 const pending=session.terminate().then(()=>done=true);assert.equal(calls[0].file,'wsl.exe');assert.equal(calls[0].args.at(-1),session.sessionToken);assert.ok(calls[0].args.some(x=>x.endsWith('/tools/terminate_wsl.py')));
 finishKill();await Promise.resolve();assert.equal(done,false);child.emit('close');await pending;assert.ok(done);
});

test('force-stop failure never acknowledges that an active writer has exited',async()=>{
 const {EventEmitter}=require('node:events'),{OmpSession}=require('../src/backend.cjs');
 const session=new OmpSession(()=>{},undefined,{executeTermination:async()=>{throw Error('still alive');}});session.child=new EventEmitter();session.processRuntime='wsl';
 await assert.rejects(session.terminate(),/still alive/);assert.ok(session.child);assert.equal(session.child.listenerCount('close'),0);
});
test('maps an allowed WSL work path to a UNC path', () => assert.equal(wslUnc('/home/user/develop/a'), '\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\develop\\a'));
test('rejects traversal and paths outside the work root', () => { for (const value of ['/etc/passwd', '/home/user/develop/../secret', '/home/user/develop', 'C:\\temp']) assert.throws(() => wslUnc(value)); });
test('closing a native session waits for process exit before a new session can start', async () => {
  const { EventEmitter } = require('node:events');
  const { OmpSession } = require('../src/backend.cjs');
  const session = new OmpSession(() => {}), child = new EventEmitter();
  let ended = false, resolved = false;
  child.stdin = {end: () => { ended = true; }};
  session.child = child;
  const closing = session.close().then(() => {resolved = true;});
  await Promise.resolve(); assert.equal(ended, true); assert.equal(resolved, false);
  child.emit('close', 0); await closing; assert.equal(resolved, true);
});

test('work inventory deadline rejects even when a WSL child never closes its pipes',async t=>{
 const {boundedExec}=require('../src/bounded-exec.cjs');let killed=false,destroyed=0,callback;
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=boundedExec('wsl.exe',[],{timeout:45000,execute:(_file,_args,_options,done)=>{
  callback=done;return {kill:()=>{killed=true;},stdout:{destroy:()=>destroyed++},stderr:{destroy:()=>destroyed++}};
 }});
 const rejected=assert.rejects(pending,/执行超时/);t.mock.timers.tick(45000);await rejected;
 assert.ok(killed);assert.equal(destroyed,2);callback(null,'late stale inventory','');
 assert.equal(await boundedExec('wsl.exe',[],{execute:(_f,_a,_o,done)=>{queueMicrotask(()=>done(null,'fresh',''));return {};}}),'fresh');
});
