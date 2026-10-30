const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {AuxiliarySettings,defaults,validate}=require('../src/auxiliary-settings.cjs');
const {AuxiliaryAgent,normalizeTitle}=require('../src/auxiliary-agent.cjs');
const {SessionTitles}=require('../src/session-titles.cjs');
const {SessionManager}=require('../src/session-manager.cjs');
const secure={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('encrypted:'+s),decryptString:b=>{assert.ok(b.toString().startsWith('encrypted:'));return b.toString().slice(10);}};
test('auxiliary settings retain, replace and clear encrypted keys without returning credentials',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-aux-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new AuxiliarySettings(dir,secure);
 assert.equal((await store.get()).hasApiKey,false);
 const input={...defaults(),baseURL:'https://example.test/v1/',model:'test-model',autoTitle:true,apiKey:'research-secret'};
 const saved=await store.save(input);assert.equal(saved.baseURL,'https://example.test/v1');assert.equal(saved.hasApiKey,true);assert.ok(!JSON.stringify(saved).includes('research-secret'));
 assert.ok(!(await fs.readFile(store.file,'utf8')).includes('research-secret'));assert.equal((await store.resolve()).apiKey,'research-secret');
 await store.save({...saved,model:'changed',apiKey:''});assert.equal((await store.resolve()).apiKey,'research-secret');
 await store.save({...saved,apiKey:'replacement'});assert.equal((await store.resolve()).apiKey,'replacement');
 await store.save({...saved,clearApiKey:true});assert.equal((await store.resolve()).apiKey,'');assert.equal((await store.get()).hasApiKey,false);
 const unavailable=new AuxiliarySettings(dir,{isEncryptionAvailable:()=>false});await assert.rejects(unavailable.save({...input}),/系统密钥存储/);
 for(const bad of [{baseURL:'https://key@example.test/v1'},{baseURL:'https://example.test/v1?key=secret'},{protocol:'unknown'},{timeoutSeconds:1000},{autoTitle:true}])assert.throws(()=>validate({...defaults(),...bad}));
});
async function server(t){
 const calls=[],sockets=new Set();let mode='ok';
 const instance=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push({url:req.url,body,auth:req.headers.authorization});
  if(mode==='slow')return;
  res.setHeader('Content-Type','application/json');
  if(mode==='error'){res.statusCode=401;res.end(JSON.stringify({error:{message:'SECRET research-secret private prompt',type:'invalid_api_key'}}));return;}
  if(mode==='upstream'){res.statusCode=502;res.end(JSON.stringify({error:{message:'mondo: Post "http://127.0.0.1:18083/v1/responses": dial tcp 127.0.0.1:18083: connect: connection refused; SECRET research-secret',type:'api_error'}}));return;}
  if(req.url.endsWith('/responses'))res.end(JSON.stringify({id:'resp_research',object:'response',created_at:1,model:'test-model',status:'completed',output:[{id:'msg_research',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'修复 Lucyna 会话命名',annotations:[]}]}],usage:{input_tokens:10,output_tokens:4,total_tokens:14,output_tokens_details:{reasoning_tokens:0}}}));
  else res.end(JSON.stringify({id:'chat_research',object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message:{role:'assistant',content:'修复 Lucyna 会话命名'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}));
 });instance.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>instance.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>instance.close(r));});
 return {calls,baseURL:'http://127.0.0.1:'+instance.address().port+'/v1',mode:v=>mode=v};
}
test('real SDK sends bounded standalone requests for both protocols and redacts API failures',async t=>{
 const s=await server(t),agent=new AuxiliaryAgent();const config={...defaults(),baseURL:s.baseURL,model:'test-model',apiKey:'research-secret'};
 for(const protocol of ['chat-completions','responses']){assert.equal(await agent.title({...config,protocol},'修复标题','分析标题来源'), '修复 Lucyna 会话命名');}
 assert.deepEqual(s.calls.map(c=>c.url),['/v1/chat/completions','/v1/responses']);assert.ok(s.calls.every(c=>c.auth==='Bearer research-secret'&&!c.body.tools));
 s.mode('error');const before=s.calls.length;await assert.rejects(agent.title(config,'private prompt','answer'),e=>e.message.includes('401')&&!/SECRET|research-secret|private prompt/.test(e.message));assert.equal(s.calls.length,before+1);
 s.mode('upstream');await assert.rejects(agent.title(config,'task','answer'),e=>e.message.includes('上游服务连接被拒绝')&&e.message.includes('502')&&!/SECRET|research-secret|127\.0\.0\.1/.test(e.message));
 s.mode('slow');await assert.rejects(agent.title(config,'task','answer',AbortSignal.timeout(50)),/超时或已取消/);
 assert.equal(normalizeTitle('"合适的标题"'),'合适的标题');assert.equal(normalizeTitle('标题\n解释'),'');assert.ok(Buffer.byteLength(normalizeTitle('标题'.repeat(200)))<=180);
});
function fixture(generate){
 const events=[],writes=[],commands=[];const settings={revision:0,resolve:async()=>({autoTitle:true})};let native,record;
 const titles=new SessionTitles({title:generate||(async()=> '自动标题')},settings);
 const manager=new SessionManager({titles,send:e=>events.push(e),create:emit=>native={child:{},ready:true,start:async()=>({}),history:[],messages:async()=>({messages:native.history}),request:async(type,data)=>{
  commands.push(type);
  if(type==='get_state')return {sessionId:'native-id',sessionFile:'C:/research.jsonl',sessionName:native.name||'',isSettled:!record.busy};
  if(type==='set_session_name'){writes.push(data.name);native.name=data.name;return {};}
  return {agentInvoked:true};
 },close:async()=>{native.child=null;emit({type:'process_exit'});},emit}});
 const start=async()=>{await manager.start('test',run=>run({root:'/work/test',settings:{runtime:'wsl'}}));record=manager.get('test');};
 const reply=()=>{native.emit({type:'agent_start'});native.emit({type:'message_end',message:{role:'user',content:'为 Lucyna 添加会话命名'}});native.emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'已定位标题入口'}]}});native.emit({type:'session_settled'});native.emit({type:'prompt_result',status:'completed'});};
 const flush=async()=>{while(manager.titles.tasks.size)await Promise.all([...manager.titles.tasks]);};return {manager,settings,titles,events,writes,commands,start,reply,flush,get native(){return native;}};
}
test('native settlement names once without submitting another OMP prompt; existing names win',async()=>{
 const f=fixture();await f.start();f.reply();await f.flush();assert.deepEqual(f.writes,['自动标题']);assert.ok(f.events.some(e=>e.type==='session_info_update'&&e.title==='自动标题'));
 f.reply();await f.flush();assert.equal(f.writes.length,1);await f.manager.closeAll();
 const named=fixture(()=>assert.fail('named session must not invoke title model'));await named.start();named.native.name='手动名称';named.reply();await named.flush();assert.deepEqual(named.writes,[]);await named.manager.closeAll();
});
test('late title is discarded on rename, close, configuration change or a new prompt',async()=>{
 for(const action of ['rename','close','settings','prompt']){
  let release,started;const began=new Promise(r=>started=r);const f=fixture(async()=>{started();return new Promise(r=>release=r);});await f.start();f.reply();await began;
  if(action==='rename'){f.native.name='用户名称';f.native.emit({type:'session_info_update',title:'用户名称'});}
  if(action==='close')await f.manager.close('test');
  if(action==='settings')f.settings.revision++;
  if(action==='prompt')await f.manager.request('test','prompt',{message:'另一个任务'});
  release('过期标题');await f.flush();assert.deepEqual(f.writes,[],action);await f.manager.closeAll();
 }
});
test('disabled, failed, interrupted and low-signal rounds do not spend auxiliary calls',async()=>{
 const f=fixture(()=>assert.fail('must not generate'));await f.start();f.settings.resolve=async()=>({autoTitle:false});f.reply();await f.flush();assert.deepEqual(f.writes,[]);await f.manager.closeAll();
 for(const outcome of ['error','aborted','low-signal']){const f=fixture(()=>assert.fail('must not generate'));await f.start();f.native.emit({type:'agent_start'});f.native.emit({type:'message_end',message:{role:'user',content:outcome==='low-signal'?'继续':'修复命名'}});f.native.emit({type:'message_end',message:{role:'assistant',stopReason:outcome==='low-signal'?'stop':outcome,content:'内容'}});f.native.emit({type:'prompt_result',status:outcome==='low-signal'?'completed':outcome});f.native.emit({type:'session_settled'});await f.flush();assert.deepEqual(f.writes,[]);await f.manager.closeAll();}
});
test('failed title generation retries only on a later round and stays bounded',async()=>{
 let count=0;const f=fixture(async()=>{count++;throw Error('safe failure');});await f.start();for(let i=0;i<4;i++){f.reply();await f.flush();}assert.equal(count,2);assert.deepEqual(f.writes,[]);assert.equal(f.events.filter(e=>e.type==='auxiliary_title_error').length,2);await f.manager.closeAll();
});
const history=()=>[{role:'user',content:'修复 Lucyna 历史会话命名'},{role:'assistant',content:[{type:'text',text:'已查明 RPC 中的标题生成配置。'}]}];
test('opening unnamed history generates from bounded visible tasks without an OMP prompt',async()=>{
 let input;const f=fixture(async(config,task,answer)=>{input={task,answer};return '修复历史会话命名';});await f.start();
 f.native.history=[{message:{role:'user',content:'修复 Lucyna 历史会话命名'+'首轮描述'.repeat(700)}},{role:'toolResult',content:'private-tool-output'},{role:'user',content:'补充：保留已有 OMP 名称'+'最近描述'.repeat(700)},{role:'assistant',content:[{type:'thinking',thinking:'private-thinking'},{type:'text',text:'已经定位到命名入口。'+'回复说明'.repeat(1000)}]}];
 await f.manager.request('test','get_messages');await f.flush();
 assert.match(input.task,/最初任务：修复 Lucyna/);assert.match(input.task,/最近任务：补充/);assert.ok(input.task.length<2100&&input.answer.length<=1500);assert.ok(!JSON.stringify(input).includes('private-'));
 assert.deepEqual(f.writes,['修复历史会话命名']);assert.ok(!f.commands.includes('prompt'));
 await f.manager.request('test','get_messages');await f.flush();assert.equal(f.writes.length,1);await f.manager.closeAll();
});
test('historical tasks can be named without an assistant reply; existing names and disabled settings win',async()=>{
 for(const variant of ['task-only','named','disabled','empty','low-signal','skill']){
  let count=0;const f=fixture(async()=>{count++;return '历史任务';});await f.start();f.native.history=history();
  if(variant==='task-only')f.native.history=history().slice(0,1);
  if(variant==='named')f.native.name='OMP 已生成名称';
  if(variant==='disabled')f.settings.resolve=async()=>({autoTitle:false});
  if(variant==='empty')f.native.history=[];
  if(variant==='low-signal')f.native.history=[{role:'user',content:'继续'},{role:'assistant',content:'好的'}];
  if(variant==='skill')f.native.history=[{role:'custom',customType:'skill-prompt',attribution:'user',display:true,details:{name:'review',args:'审查历史会话恢复逻辑'}}];
  await f.manager.request('test','get_messages');await f.flush();assert.equal(count,['task-only','skill'].includes(variant)?1:0,variant);assert.ok(!f.commands.includes('prompt'));await f.manager.closeAll();
 }
});
test('busy history waits for settlement and repeated reads do not retry a failed title',async()=>{
 let count=0;const f=fixture(async()=>{count++;throw Error('safe failure');});await f.start();f.native.emit({type:'agent_start'});f.native.history=history();
 await f.manager.request('test','get_messages');await f.flush();assert.equal(count,0);
 f.native.emit({type:'session_settled'});await f.flush();assert.equal(count,1);
 for(let i=0;i<3;i++){await f.manager.request('test','get_messages');await f.flush();}assert.equal(count,1);
 f.settings.revision++;f.titles.refresh(f.manager.get('test'),f.manager);await f.flush();assert.equal(count,2);await f.manager.closeAll();
});
test('configuration save checks already loaded history and replaces a pending obsolete request',async()=>{
 let enabled=false,count=0,release,began;const started=new Promise(r=>began=r),f=fixture(async()=>{count++;if(count===1){began();return new Promise(r=>release=r);}return '新配置生成的标题';});
 await f.start();f.settings.resolve=async()=>({autoTitle:enabled});f.native.history=history();await f.manager.request('test','get_messages');await f.flush();assert.equal(count,0);
 enabled=true;f.settings.revision++;f.titles.refresh(f.manager.get('test'),f.manager);await started;
 f.settings.revision++;f.titles.refresh(f.manager.get('test'),f.manager);release('过期标题');await f.flush();assert.equal(count,2);assert.deepEqual(f.writes,['新配置生成的标题']);await f.manager.closeAll();
});
test('history captured before a new prompt or connection change cannot seed automatic naming',async()=>{
 for(const action of ['prompt','reopen']){
  const f=fixture(()=>assert.fail('stale history must not generate'));await f.start();let release;f.native.messages=()=>new Promise(r=>release=r);const pending=f.manager.request('test','get_messages');
  if(action==='prompt')await f.manager.request('test','prompt',{message:'另外一个任务'});
  else{await f.manager.close('test');await f.start();}
  release({messages:history()});await pending;await f.flush();assert.deepEqual(f.writes,[],action);await f.manager.closeAll();
 }
});
test('restoring many histories bounds auxiliary concurrency and removes cancelled waiters',async()=>{
 const settings={revision:0,resolve:async()=>({autoTitle:true})},gates=[];let active=0,max=0,calls=0;
 const titles=new SessionTitles({title:async()=>{calls++;active++;max=Math.max(max,active);await new Promise(r=>gates.push(r));active--;return '恢复后的标题';}},settings),fixtures=[];
 for(let i=0;i<5;i++){const f=fixture();f.manager.titles=titles;fixtures.push(f);await f.start();f.native.history=history();await f.manager.request('test','get_messages');}
 await new Promise(r=>setImmediate(r));assert.equal(calls,2);await fixtures[2].manager.close('test');
 while(titles.tasks.size){for(const release of gates.splice(0))release();await new Promise(r=>setImmediate(r));}
 assert.equal(max,2);assert.equal(calls,4);assert.deepEqual(fixtures[2].writes,[]);assert.equal(titles.active,0);assert.equal(titles.waiters.length,0);for(const f of fixtures)await f.manager.closeAll();
});
