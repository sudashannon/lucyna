// Actual SDK, managed SQLite, Stele index and MCP; local fixture provider only.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {startKnowledgeHost}=require('../src/knowledge-host.cjs');
async function main(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-consolidation-native-')),work=path.join(directory,'work');fs.mkdirSync(path.join(work,'notes'),{recursive:true});
 const quote='NATIVE_CONSOLIDATION：同一写入的重试使用相同 operationId。';fs.writeFileSync(path.join(work,'notes/retry.md'),quote);
 let calls=0,now=10000000,instance;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);calls++;assert.ok(!input.tools?.length);assert.equal(input.max_tokens,undefined);assert.ok(raw.includes(quote));res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({facts:[{title:'知识库幂等重试',knowledge:'NATIVE_CONSOLIDATION：保持相同操作 ID 重试。',appliesTo:'同一内容的知识写入；不同内容必须使用新 ID。',quote}]})},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  instance=await startKnowledgeHost({directory:path.join(directory,'knowledge'),consolidationOptions:{clock:()=>now,idleMs:10,cooldownMs:100}});
  const call=async(route,input)=>{const r=await fetch(instance.url+route,{method:input?'POST':'GET',headers:{authorization:'Bearer '+instance.token,'content-type':'application/json'},body:input?JSON.stringify(input):undefined});const result=await r.json();if(!r.ok)throw Error(result.error);return result;};
  await call('/api/consolidation/sync',{works:[{root:'/work/native',directory:work,busy:false}],auxiliary:{baseURL:'http://127.0.0.1:'+server.address().port+'/v1',model:'fixture'}});
  await instance.consolidation.tick();now+=101;await instance.consolidation.tick();
  const status=await call('/api/consolidation/status?root=/work/native');assert.equal(status.status,'completed');assert.equal(status.factCount,1);assert.equal(calls,1);
  const context=await instance.mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'library_read',arguments:{document:status.document.id}}});assert.ok(context.result.content[0].text.includes('NATIVE_CONSOLIDATION'));
  const index=await instance.nativeJSON('/api/wiki/index');assert.ok(JSON.stringify(index).includes('工作经验'));
  now+=101;await instance.consolidation.tick();assert.equal(calls,1);assert.equal(instance.store.history(status.document.id).length,1);
  const health=await call('/api/health');assert.ok(health.capabilities.includes('knowledge-consolidation'));
  console.log(JSON.stringify({passed:true,checks:['real SDK without OMP or token cap','private HTTP default registration','SQLite revision','Stele index','MCP read','repeat deduplication'],directory}));
 }finally{await instance?.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
