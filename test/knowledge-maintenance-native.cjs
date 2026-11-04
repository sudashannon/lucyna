// Real embedded SDK and Stele, with a local deterministic model endpoint.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {startKnowledgeHost}=require('../src/knowledge-host.cjs');
async function main(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-maintenance-native-'));
 const before='采样间隔为 10 ms，仅用于 RX101 固件 v2。',after='采样间隔为 20 ms，仅用于 RX101 固件 v2。';
 let calls=0,now=10000000,host,source;
 const server=http.createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);calls++;assert.ok(!input.tools?.length);assert.equal(input.max_tokens,undefined);const verify=raw.includes('"proposal"')||raw.includes('\\"proposal\\"');const value=verify?{supported:true,scopeUnchanged:true,complete:true,reason:'证据支持同一版本的局部修正'}:{decision:'revise',reason:'实测来源已更正采样间隔',patches:[{before,after,evidence:[{source:source.id,quote:after}]}]};res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message:{role:'assistant',content:JSON.stringify(value)},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}}));}catch(e){res.statusCode=500;res.end(JSON.stringify({error:{message:e.message}}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  host=await startKnowledgeHost({directory,maintenanceOptions:{clock:()=>now,idleMs:0,intervalMs:0}});
  clearInterval(host.maintenance.timer);
  const call=async(route,input)=>{const r=await fetch(host.url+route,{method:input?'POST':'GET',headers:{authorization:'Bearer '+host.token,'content-type':'application/json'},body:input?JSON.stringify(input):undefined});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;};
  await call('/api/consolidation/sync',{works:[],auxiliary:{baseURL:'http://127.0.0.1:'+server.address().port+'/v1',model:'fixture'}});
  const library=host.store.list()[0].id;
  source=await call('/api/library/write',{library,relative:'source.md',content:'# 原始实测记录\n\n'+before,expected:'new'});
  const target=await call('/api/library/write',{library,relative:'knowledge/guide.md',content:'# RX101 采样指南\n\n'+before+'\n\n[实测依据](../source.md)',expected:'new'});
  await host.maintenance.tick();
  await call('/api/library/write',{document:source.id,content:'# 原始实测记录\n\n'+after,expected:source.revision});
  now+=1000;await host.maintenance.scan();
  const guarded=await host.mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'wiki_context',arguments:{query:'RX101 采样'}}});assert.ok(!JSON.stringify(guarded).includes(before));
  await host.maintenance.tick();let job=host.maintenance.jobs()[0];assert.equal(job.state,'completed',JSON.stringify(job));assert.equal(calls,2);assert.equal(job.checks.passed,true);assert.match(host.store.read(target.id).content,/20 ms/);
  assert.equal((await call('/api/library/read?document='+target.id)).maintenance,null);
  now+=1000;await host.maintenance.tick();assert.equal(calls,2);assert.equal(host.store.history(target.id).length,2);
  await call('/api/maintenance/action',{id:job.id,action:'rollback'});assert.match(host.store.read(target.id).content,/10 ms/);assert.ok((await call('/api/library/read?document='+target.id)).maintenance);
  await host.stop();host=await startKnowledgeHost({directory,maintenanceOptions:{clock:()=>now,idleMs:0}});clearInterval(host.maintenance.timer);assert.equal(host.maintenance.get(job.id).state,'rolled_back');assert.ok(host.maintenance.freshness(target.id));
  console.log(JSON.stringify({passed:true,calls,checks:['real SDK proposal and separate verifier','no OMP and no token cap','HTTP source update','stale MCP filtered','real artifact/search/hash verification','idempotent polling','rollback and persisted restart'],directory}));
 }finally{await host?.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
