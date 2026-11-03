const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {WorkCreation,handoffRoot} = require('../src/work-creation.cjs');
const {SessionManager} = require('../src/session-manager.cjs');

const base = '/work', root = base+'/new-work';
const assistant = text => ({role:'assistant',stopReason:'stop',content:[{type:'text',text}]});
test('only an unambiguous final OMP handoff can name a direct child of the Work directory',()=>{
  assert.equal(handoffRoot([assistant('已建好\n/move '+root+'\n随后继续。')],base),root);
  assert.equal(handoffRoot([assistant('`/move '+root+'`')],base),root);
  assert.equal(handoffRoot([assistant('```bash\n/move '+root+'\n```')],base),null);
  assert.equal(handoffRoot([assistant('/move '+root),{role:'user',content:'wait'}],base),null);
  assert.equal(handoffRoot([{...assistant('/move '+root),stopReason:'aborted'}],base),null);
  for(const target of ['/etc','/work/../escape','/work/link/child',root+'\n/move /work/another']){
    assert.throws(()=>handoffRoot([assistant('/move '+target)],base),/唯一有效/);
  }
});

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-work-creation-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const inventory = path.join(temp,'work'), agent = path.join(temp,'agent');
  const id = 'creation-fixture', nativeId = 'native-id';
  const work = {root,name:'new-work',kind:'gitless',rootAvailable:true};
  const original=path.join(agent,'sessions','base','session.jsonl'), moved=path.join(agent,'sessions','work','session.jsonl');
  const nativePath = input => input===base?inventory:input===root?path.join(inventory,'new-work'):input==='/agent'?agent:input;
  const calls=[], events=[];
  let native, works=[], response=[], dropReply=false;
  const service=new WorkCreation({directory:path.join(temp,'state'),base,toNative:nativePath,
    initialize:async()=>fs.mkdir(inventory,{recursive:true}),
    listWorks:async()=>works,verify:async()=>fs.access(path.join(inventory,'new-work','SESSION.md')),
    admit:async(target,run)=>{assert.equal(target,root);return run();}});
  const journal = async(file,cwd)=>{
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,JSON.stringify({type:'session',id:nativeId,cwd})+'\n');
  };
  const manager = new SessionManager({onState:record=>service.remember(record),send:event=>events.push(event),create:send=>{
    native={send,ready:true,child:{},file:original,
      async start(){return {runtime:'wsl'};},
      async messages(){return {messages:response};},
      async request(type,data){
        calls.push({type,data});
        if(type==='get_state')return {isSettled:true,sessionId:nativeId,sessionFile:this.file};
        if(type==='get_available_commands')return {commands:[{name:'work-start',source:'file'}]};
        if(type==='prompt'&&data.message.startsWith('/move ')){
          assert.equal(data.message,'/move '+root);
          await journal(moved,root);await fs.unlink(original);this.file=moved;
          if(dropReply)throw Error('move reply lost');
          return {agentInvoked:false};
        }
        return {agentInvoked:true};
      }};
    return native;
  }});
  const settings={runtime:'wsl',wslAgentDir:'/agent'};
  const start=()=>manager.start(id,async launch=>launch(await service.prepare(id,settings)),{root:base});
  const finish=()=>manager.finishWork(id,service);
  const createRoot=async(withSession=true)=>{
    await fs.mkdir(path.join(inventory,'new-work'));
    await fs.writeFile(path.join(inventory,'new-work','SESSION.md'),'# New work\n');
    if(withSession)await fs.writeFile(path.join(inventory,'new-work','SESSION-'+nativeId+'.md'),'# Creation\n');
    works=[work];
    response=[assistant('已校验工作根。\n/move '+root+'\n再调用 /work-continue。')];
  };
  return {manager,id,work,events,calls,service,settings,inventory,start,finish,createRoot,
    emit:event=>native.send(event),dropReply:()=>{dropReply=true;},writeOriginal:()=>journal(original,base),moved};
}

test('from an empty list, OMP asks for approval and moves the same writer exactly once after validation',async t=>{
  const f=await fixture(t);
  await f.start();
  await assert.rejects(f.manager.request(f.id,'prompt',{message:'ordinary prompt'}),/先发送/);
  await f.manager.request(f.id,'prompt',{message:'/work-start investigate'});
  await f.writeOriginal();
  await f.manager.request(f.id,'get_state');
  f.emit({type:'agent_start'});
  await f.createRoot();
  assert.equal(f.finish(),null);
  f.emit({type:'session_settled'});
  const first=f.finish(), second=f.finish();
  assert.equal(first,second);
  assert.deepEqual(await first,{work:f.work,sessionFile:f.moved});
  assert.equal(f.manager.list()[0].root,root);
  assert.equal(f.manager.get(f.id).nativeId,'native-id');
  assert.equal(f.events.find(event=>event.type==='work_creation_completed').clientSessionId,f.id);
  assert.deepEqual(f.calls.filter(call=>call.type==='prompt').map(call=>call.data.message),['/work-start investigate','/move '+root]);
});

test('a Work already on disk is never adopted as a new root, including incomplete directories',async t=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.inventory,'new-work'),{recursive:true});
  await f.start();
  await f.writeOriginal();
  await fs.rmdir(path.join(f.inventory,'new-work'));
  await f.createRoot();
  await assert.rejects(f.finish(),/不是这次新建/);
  assert.equal(f.calls.some(call=>call.type==='prompt'),false);
});

test('a lost native move reply reopens the relocated journal without replaying the move',async t=>{
  const f=await fixture(t);
  await f.start();
  await f.writeOriginal();
  await f.manager.request(f.id,'get_state');
  await f.createRoot();
  f.dropReply();
  await assert.rejects(f.finish(),/reply lost/);
  const recovered=await f.service.prepare(f.id,f.settings);
  assert.equal(recovered.root,root);
  assert.equal(recovered.resume,f.moved);
  assert.equal(recovered.resumeId,'native-id');
  await f.finish();
  assert.equal(f.calls.filter(call=>call.type==='prompt').length,1);
});

test('a concurrently created Work without this session log cannot be adopted',async t=>{
  const f=await fixture(t);
  await f.start();
  await f.writeOriginal();
  await f.createRoot(false);
  await assert.rejects(f.finish(),/本次建根会话的私有日志/);
  assert.equal(f.calls.some(call=>call.type==='prompt'),false);
});
