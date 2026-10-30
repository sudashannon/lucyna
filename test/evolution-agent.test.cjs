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
    if(mode==='delayed')await new Promise(r=>setTimeout(r,100));
    if(mode==='error'){res.statusCode=401;res.end(JSON.stringify({error:{message:'secret-key private prompt'}}));return;}
    const name=calls.length===1?'read_work_file':calls.length===2?'write_work_file':calls.length===3?'verify_work':null;
    const args=JSON.stringify(name==='verify_work'?{}:{path:'workflow.py'});
    if(protocol==='responses'){const response={id:'resp_'+calls.length,object:'response',created_at:1,model:'local-test',status:'completed',output:name?[{type:'function_call',id:'fc_'+calls.length,call_id:'call_'+calls.length,name,arguments:args,status:'completed'}]:[{id:'msg_done',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Iteration verified.',annotations:[]}]}],usage:mode==='missing'?undefined:{input_tokens:100,output_tokens:20,total_tokens:120,output_tokens_details:{reasoning_tokens:0}}};if(mode==='encrypted')response.output.unshift({type:'reasoning',id:'rs_'+calls.length,summary:[],encrypted_content:'x'.repeat(60000)});res.end(JSON.stringify(response));}
    else res.end(JSON.stringify({id:'chat_'+calls.length,object:'chat.completion',created:1,model:'local-test',choices:[{index:0,message:name?{role:'assistant',content:null,tool_calls:[{id:'call_'+calls.length,type:'function',function:{name,arguments:args}}]}:{role:'assistant',content:'Iteration verified.'},finish_reason:name?'tool_calls':'stop'}],usage:mode==='missing'?undefined:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}));
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
