const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {AuxiliaryAgent}=require('../src/auxiliary-agent.cjs');
const {createNativeReviewEngine}=require('../src/code-review-engine.cjs');
const snapshot={id:'frozen',partial:false,warnings:[],files:[{id:'file1',member:'app',path:'a.js',scope:'turn',patch:'@@ -1 +1 @@\n-old\n+new\n'}]};

test('review uses the real SDK with no tools for both protocols, aborts and never leaks upstream errors',async t=>{
  const calls=[],sockets=new Set();let mode='ok';
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw);calls.push({url:req.url,body});
    if(mode==='slow')return;
    res.setHeader('Content-Type','application/json');
    if(mode==='error'){res.statusCode=403;res.end(JSON.stringify({error:{message:'PRIVATE TOKEN and source-code'}}));return;}
    const output=mode==='json'?'not JSON':'{"findings":[]}';
    if(req.url.endsWith('/responses'))res.end(JSON.stringify({id:'resp_1',object:'response',created_at:1,model:'fixture',status:'completed',output:[{id:'msg_1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:output,annotations:[]}]}],usage:{input_tokens:22,output_tokens:6,total_tokens:28,output_tokens_details:{reasoning_tokens:0}}}));
    else res.end(JSON.stringify({id:'chat_1',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message:{role:'assistant',content:output},finish_reason:mode==='length'?'length':'stop'}],usage:{prompt_tokens:22,completion_tokens:6,total_tokens:28}}));
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  const config={baseURL:'http://127.0.0.1:'+server.address().port+'/v1',model:'fixture',apiKey:'test-only',timeoutSeconds:5};
  const engine=createNativeReviewEngine(new AuxiliaryAgent());
  for(const protocol of ['chat-completions','responses']){
    const result=await engine.review({...config,protocol},snapshot,new AbortController().signal);
    assert.deepEqual(result.findings,[]);assert.equal(result.usage.inputTokens,22);
  }
  assert.ok(calls.every(call=>!call.body.tools));
  assert.ok(calls.every(call=>JSON.stringify(call.body).includes('file1')));
  config.protocol='chat-completions';
  mode='json';await assert.rejects(engine.review(config,snapshot,new AbortController().signal),/JSON/);
  mode='length';await assert.rejects(engine.review(config,snapshot,new AbortController().signal),/上限/);
  mode='error';await assert.rejects(engine.review(config,snapshot,new AbortController().signal),error=>error.message.includes('403')&&!error.message.includes('PRIVATE'));
  mode='slow';await assert.rejects(engine.review(config,snapshot,AbortSignal.timeout(70)),/超时或已取消/);
});
