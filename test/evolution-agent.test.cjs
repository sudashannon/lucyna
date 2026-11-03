const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {AuxiliaryAgent}=require('../src/auxiliary-agent.cjs');
const {defaults}=require('../src/auxiliary-settings.cjs');
const {WorkRunner}=require('../src/work-runner.cjs');
const tools=['list_work_files','read_work_file','write_work_file','verify_work'].map(name=>({name,description:name,parameters:{type:'object',properties:{path:{type:'string'}},required:[],additionalProperties:false}}));
const request={objective:'Iterate this Work',acceptance:'Checks pass',targets:['workflow.py'],training:{score:0},tokenBudget:40000,tools};
async function fixture(t,protocol,mode='ok'){
  const calls=[],sockets=new Set();
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push(body);res.setHeader('Content-Type','application/json');
    if(mode==='slow')return;
    if(mode==='header-delay')await new Promise(r=>setTimeout(r,1600));
    if(mode==='delayed')await new Promise(r=>setTimeout(r,100));
    if(mode==='error'){res.statusCode=401;res.end(JSON.stringify({error:{message:'secret-key private prompt'}}));return;}
    const name=mode==='phase-handoff'?(calls.length%2?'read_work_file':'submit_work_evaluation'):mode==='no-tool'?null:mode==='ignored-phase'?(calls.length<=9||calls.length===11?'read_work_file':calls.length===10?'submit_work_evaluation':'report_work_blocker'):mode==='unlimited-discovery'?(calls.length<=8||calls.length===10?'read_work_file':calls.length===9?'submit_work_evaluation':'report_work_blocker'):mode==='bounded-discovery'?(calls.length<=3?'read_work_file':'report_work_blocker'):['prepare','header-delay'].includes(mode)?(calls.length===1?'read_work_file':'submit_work_evaluation'):mode==='blocker'?'report_work_blocker':calls.length===1?'read_work_file':calls.length===2?'write_work_file':calls.length===3?'verify_work':null;
    const args=JSON.stringify(name==='verify_work'?{}:{path:'workflow.py'});
    if(protocol==='responses'){const response={id:'resp_'+calls.length,object:'response',created_at:1,model:'local-test',status:'completed',output:name?[{type:'function_call',id:'fc_'+calls.length,call_id:'call_'+calls.length,name,arguments:args,status:'completed'}]:[{id:'msg_done',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Iteration verified.',annotations:[]}]}],usage:mode==='missing'?undefined:{input_tokens:100,output_tokens:20,total_tokens:120,output_tokens_details:{reasoning_tokens:0}}};if(mode==='encrypted')response.output.unshift({type:'reasoning',id:'rs_'+calls.length,summary:[],encrypted_content:'x'.repeat(60000)});res.end(JSON.stringify(response));}
    else res.end(JSON.stringify({id:'chat_'+calls.length,object:'chat.completion',created:1,model:'local-test',choices:[{index:0,message:name?{role:'assistant',content:null,tool_calls:[{id:'call_'+calls.length,type:'function',function:{name,arguments:args}}]}:{role:'assistant',content:'Iteration verified.'},finish_reason:name?'tool_calls':'stop'}],usage:mode==='missing'?undefined:['bounded-discovery','unlimited-discovery','ignored-phase'].includes(mode)?{prompt_tokens:2500,completion_tokens:500,total_tokens:3000}:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}));
  });server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});
  return {calls,config:{...defaults(),baseURL:'http://127.0.0.1:'+server.address().port+'/v1',model:'local-test',protocol,apiKey:'secret-key'}};
}
for(const protocol of ['chat-completions','responses'])test('local Work tool loop uses existing SDK agent: '+protocol,async t=>{
  const f=await fixture(t,protocol),executed=[],usage=[];
  const result=await new AuxiliaryAgent().iterateWork(f.config,request,async(name,args)=>{executed.push(name);return {content:'VALUE = 1',sha256:'abc',passed:true};},u=>usage.push(u));
  assert.deepEqual(executed,['read_work_file','write_work_file','verify_work']);assert.equal(f.calls.length,4);assert.equal(result.usedTokens,480);assert.equal(usage.length,4);
  for(const call of f.calls){assert.equal(call.model,'local-test');assert.ok(call.tools.length===4);assert.ok(!JSON.stringify(call).includes('secret-key'));if(protocol==='responses')assert.equal(call.store,false);}
});
test('budget preflight, missing usage, authentication and cancellation never fall back to OMP',async t=>{
  const f=await fixture(t,'chat-completions'),agent=new AuxiliaryAgent();
  await assert.rejects(agent.iterateWork(f.config,{...request,tokenBudget:1000},async()=>({}),()=>{}),/预算/);assert.equal(f.calls.length,0);
  const missing=await fixture(t,'chat-completions','missing');await assert.rejects(agent.iterateWork(missing.config,request,async()=>({}),()=>{}),/可靠用量/);assert.equal(missing.calls.length,1);
  const bad=await fixture(t,'chat-completions','error');await assert.rejects(agent.iterateWork(bad.config,request,async()=>({}),()=>{}),e=>/认证/.test(e.message)&&!e.message.includes('secret-key'));
  const slow=await fixture(t,'chat-completions','slow'),controller=new AbortController();const pending=agent.iterateWork(slow.config,request,async()=>({}),()=>{},controller.signal);setTimeout(()=>controller.abort(),150);await assert.rejects(pending,/取消/);
});
test('each tool-loop step has its own timeout instead of sharing the one-shot title deadline',async t=>{
  const f=await fixture(t,'chat-completions','delayed');
  const result=await new AuxiliaryAgent().iterateWork({...f.config,timeoutSeconds:.3},request,async()=>({passed:true}),()=>{});
  assert.equal(f.calls.length,4);assert.equal(result.usedTokens,480);
});
test('desktop supplies private auxiliary settings for evolution; ordinary tasks keep their existing backend',async()=>{
  const sent=[],config={...defaults(),baseURL:'https://example.test/v1',model:'local-test',apiKey:'secret-key'};
  const runner=new WorkRunner({listWorks:async()=>[{root:'/works/a',kind:'gitless'}],auxiliary:async()=>config});
  runner.ensure=runner.oneShot=async()=>{};runner.request=async value=>{sent.push(value);return {};};
  await runner.call('create',{root:'/works/a',mode:'evolution'});
  assert.equal(sent[0].op,'auxiliary-configure');assert.equal(sent[0].auxiliary.config.apiKey,'secret-key');assert.ok(sent[0].auxiliary.script.endsWith('/src/evolution-agent-worker.cjs'));assert.equal(sent[1].op,'create');assert.ok(!JSON.stringify(sent[1]).includes('secret-key'));
  sent.length=0;await runner.call('create',{root:'/works/a',mode:'task'});assert.equal(sent.length,1);assert.equal(sent[0].op,'create');
  await assert.rejects(runner.call('auxiliary-configure',{auxiliary:{}}),/无效/);
});

test('encrypted provider metadata does not consume the text budget estimate',async t=>{
  const f=await fixture(t,'responses','encrypted');
  const result=await new AuxiliaryAgent().iterateWork(f.config,request,async()=>({passed:true}),()=>{});
  assert.equal(f.calls.length,4);assert.equal(result.usedTokens,480);
});
test('successful write and host verification end the loop without a redundant model summary request',async t=>{
  const f=await fixture(t,'chat-completions');
  const result=await new AuxiliaryAgent().iterateWork(f.config,request,async name=>name==='write_work_file'?{written:'workflow.py'}:{passed:true},()=>{});
  assert.equal(f.calls.length,3);assert.equal(result.usedTokens,360);
});

for(const protocol of ['chat-completions','responses'])test('preparation uses its own bounded context and stops only after host validation: '+protocol,async t=>{
 const f=await fixture(t,protocol,'prepare'),names=[];
 const prepTools=['list_work_files','read_work_file','submit_work_evaluation','report_work_blocker'].map(name=>({name,description:name,parameters:{type:'object',properties:{path:{type:'string'}},required:[],additionalProperties:false}}));
 const input={mode:'prepare',work:'example',tokenBudget:40000,tools:prepTools,clarification:'只运行离线检查'};
 const result=await new AuxiliaryAgent().prepareWorkEvolution(f.config,input,async name=>{names.push(name);return name==='submit_work_evaluation'?{ready:true}:{content:'# Work'};},()=>{});
 assert.deepEqual(names,['read_work_file','submit_work_evaluation']);assert.equal(result.usedTokens,240);assert.equal(f.calls.length,2);
 assert.ok(!JSON.stringify(f.calls).includes('write_work_file'));
 const blocked=await fixture(t,protocol,'blocker');await new AuxiliaryAgent().prepareWorkEvolution(blocked.config,input,async()=>({recorded:true}),()=>{});assert.equal(blocked.calls.length,1);
 const prose=await fixture(t,protocol,'no-tool'),fallback=[];await new AuxiliaryAgent().prepareWorkEvolution(prose.config,input,async(name,args)=>{fallback.push({name,args});return {recorded:true};},()=>{});assert.equal(prose.calls.length,1);assert.equal(fallback[0].name,'report_work_blocker');assert.match(fallback[0].args.message,/尚未提交可执行评测.*模型说明（未经试跑）/);
 await assert.rejects(new AuxiliaryAgent().prepareWorkEvolution(f.config,{...input,tools},async()=>({}),()=>{}),/无效/);
});

test('discovery leaves budget for a concrete outcome instead of browsing until exhausted',async t=>{
 const f=await fixture(t,'chat-completions','bounded-discovery');
 const prepTools=['list_work_files','read_work_file','submit_work_evaluation','report_work_blocker'].map(name=>({name,description:name,parameters:{type:'object',properties:{path:{type:'string'}},required:[],additionalProperties:false}}));
 const result=await new AuxiliaryAgent().prepareWorkEvolution(f.config,{work:'complex',tokenBudget:16000,tools:prepTools},async name=>name==='report_work_blocker'?{recorded:true}:{content:'bounded source evidence'},()=>{});
 assert.equal(result.usedTokens,12000);assert.equal(f.calls.length,4);
 assert.deepEqual(f.calls.at(-1).tools.map(t=>t.function.name),['submit_work_evaluation','report_work_blocker']);
 assert.match(JSON.stringify(f.calls.at(-1).messages),/discovery allowance is spent/);
});

test('unlimited local agent usage has no token cap and a trial checkpoint reopens reading',async t=>{
 const f=await fixture(t,'chat-completions','unlimited-discovery');
 const prepTools=['list_work_files','read_work_file','submit_work_evaluation','report_work_blocker'].map(name=>({name,description:name,parameters:{type:'object',properties:{path:{type:'string'}},required:[],additionalProperties:false}}));
 const result=await new AuxiliaryAgent().prepareWorkEvolution(f.config,{work:'complex',tokenBudget:null,tools:prepTools},async name=>name==='report_work_blocker'?{recorded:true}:name==='submit_work_evaluation'?{ready:false,draft:true,baseline:{training:.5,validation:.5}}:{content:'source evidence'.repeat(2000)},()=>{});
 assert.equal(result.usedTokens,33000);assert.equal(f.calls.length,11);assert.match(JSON.stringify(f.calls[8].messages),/Preparation checkpoint/);assert.equal(f.calls[8].tool_choice,'required');assert.deepEqual(f.calls[8].tools.map(t=>t.function.name),['submit_work_evaluation','report_work_blocker']);assert.equal(f.calls[9].tools.length,4);assert.ok(!JSON.stringify(f.calls).includes('Host budget:'));
 assert.ok(f.calls.every(c=>c.max_tokens===undefined&&c.max_completion_tokens===undefined));
 const iteration=await fixture(t,'responses');const done=await new AuxiliaryAgent().iterateWork(iteration.config,{...request,tokenBudget:null},async name=>name==='write_work_file'?{written:'workflow.py'}:{passed:true},()=>{});
 assert.equal(done.usedTokens,360);
});

test('long preparation survives the default transport header deadline without changing other requests',async t=>{
 const {Agent,getGlobalDispatcher,setGlobalDispatcher}=require('undici');
 const previous=getGlobalDispatcher(),short=new Agent({headersTimeout:100,bodyTimeout:100});
 setGlobalDispatcher(short);
 try{
  const prepTools=['list_work_files','read_work_file','submit_work_evaluation','report_work_blocker'].map(name=>({name,description:name,parameters:{type:'object',properties:{path:{type:'string'}},required:[],additionalProperties:false}}));
  const execute=async name=>name==='submit_work_evaluation'?{ready:true}:{content:'# Work'};
  const limited=await fixture(t,'chat-completions','header-delay');
  await assert.rejects(new AuxiliaryAgent().prepareWorkEvolution(limited.config,{work:'slow',tokenBudget:40000,tools:prepTools},execute,()=>{}),/UND_ERR_HEADERS_TIMEOUT/);
  const long=await fixture(t,'chat-completions','header-delay');
  const result=await new AuxiliaryAgent().prepareWorkEvolution(long.config,{work:'slow',tokenBudget:null,tools:prepTools},execute,()=>{});
  assert.equal(result.usedTokens,240);assert.equal(long.calls.length,2);
  assert.equal(getGlobalDispatcher(),short);
 }finally{setGlobalDispatcher(previous);await short.destroy();}
});

test('a provider ignoring activeTools cannot bypass the trial phase at host dispatch',async t=>{
 const f=await fixture(t,'chat-completions','ignored-phase'),executed=[],usage=[];
 const prepTools=['list_work_files','read_work_file','submit_work_evaluation','report_work_blocker'].map(name=>({name,description:name,parameters:{type:'object',properties:{path:{type:'string'}},required:[],additionalProperties:false}}));
 const result=await new AuxiliaryAgent().prepareWorkEvolution(f.config,{work:'example',tokenBudget:null,tools:prepTools},async name=>{
  executed.push(name);return name==='submit_work_evaluation'?{ready:false,draft:true}:name==='report_work_blocker'?{recorded:true}:{content:'evidence'};
 },event=>usage.push(event));
 assert.equal(result.usedTokens,36000);
 assert.equal(executed.filter(name=>name==='read_work_file').length,9);
 assert.match(usage[8].errors[0],/工具调用未执行|当前阶段须先提交/);
 assert.equal(f.calls[9].tools.length,2);assert.equal(f.calls[10].tools.length,4);
});

for(const protocol of ['chat-completions','responses'])test('validated draft starts a fresh controls context and retains subsequent feedback: '+protocol,async t=>{
 const f=await fixture(t,protocol,'phase-handoff');
 const prepTools=['list_work_files','read_work_file','submit_work_evaluation','report_work_blocker'].map(name=>({name,description:name,parameters:{type:'object',properties:{path:{type:'string'}},required:[],additionalProperties:false}}));
 let submissions=0,reads=0;
 const result=await new AuxiliaryAgent().prepareWorkEvolution({...f.config,model:'minimax-cn/MiniMax-M3.1-Flash'},{work:'example',tokenBudget:null,tools:prepTools},async name=>{
  if(name==='read_work_file')return {content:++reads===1?'OLD_DISCOVERY_CONTEXT':'NEW_DEPENDENCY_EVIDENCE'};
  return ++submissions===1?{draft:true,ready:false,handoff:{plan:{objective:'EXACT_VALIDATED_GOAL',generated:{'__lucyna_eval__/test.py':'FROZEN_CHECK'}},originalTargets:[{path:'workflow.py',content:'ORIGINAL_TARGET'}],baseline:{training:.5,validation:.5}}}:{ready:true};
 },()=>{});
 assert.equal(result.usedTokens,480);assert.equal(f.calls.length,4);
 const last=JSON.stringify(f.calls.at(-1));
 assert.ok(!last.includes('OLD_DISCOVERY_CONTEXT'));assert.match(last,/EXACT_VALIDATED_GOAL/);assert.match(last,/FROZEN_CHECK/);assert.match(last,/ORIGINAL_TARGET/);assert.match(last,/NEW_DEPENDENCY_EVIDENCE/);
 for(const call of f.calls){
  assert.equal(call.max_tokens,undefined);assert.equal(call.max_completion_tokens,undefined);
  if(protocol==='chat-completions')assert.equal(call.reasoning_effort,'high');
  else{assert.equal(call.reasoning,undefined);assert.equal(call.store,false);}
 }
});
