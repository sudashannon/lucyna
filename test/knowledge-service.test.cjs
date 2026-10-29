const {test}=require('node:test'),assert=require('node:assert/strict');
const {createKnowledgeService}=require('../src/knowledge-service.cjs');
const doc={id:'/fixture/doc.md',path:'/fixture/doc.md',workspace:'fixture',title:'Fixture',type:'knowledge'};
function fixture(handler){const calls=[];const service=createKnowledgeService(async(url,options={})=>{calls.push({url,options});if(url.pathname==='/api/workspaces')return Response.json([{alias:'fixture',path:'/fixture'}]);if(url.pathname==='/api/wiki/index')return Response.json([doc]);return handler(url,options);});return {service,calls};}
test('operation allowlist rejects route injection and preserves versioned candidate requests',async()=>{
  const {service,calls}=fixture(()=>Response.json({status:'adopted'}));await assert.rejects(service('/api/secrets'),/不支持/);await assert.rejects(service('candidateAction',{id:'c',action:'delete',revision:'v1'}),/无效/);await assert.rejects(service('candidateAction',{id:'c',action:'adopt'}),/内容版本/);assert.equal(calls.length,0);
  await service('candidateAction',{id:'c 1',action:'adopt',revision:'version-1',untrusted:'ignored'});const request=calls.at(-1);assert.equal(request.url.pathname,'/api/wiki/candidates/c%201');assert.deepEqual(JSON.parse(request.options.body),{action:'adopt',revision:'version-1'});
});
test('source capture uses multipart and explicit workspace; browser file paths cannot become server file paths',async()=>{
  const {service,calls}=fixture(()=>Response.json({id:'saved'}));await service('sourceCapture',{workspace:'fixture',file:{name:'C:\\fakepath\\note.md',bytes:new Uint8Array([65]),type:'text/markdown'}});const form=calls.at(-1).options.body;assert.equal(form.get('workspace'),'fixture');assert.equal(form.get('file').name,'note.md');assert.equal(await form.get('file').text(),'A');await assert.rejects(service('sourceCapture',{text:'x'}),/知识来源/);
});
test('source snapshots bind exact bytes to evidence version and document writes require a strong ETag',async()=>{
  const {service,calls}=fixture((url,options)=>options.method==='PUT'?Response.json({saved:true}):new Response('# Fixture\n',{headers:{etag:'"abc"'}}));const snapshot=await service('snapshot',{id:doc.id});assert.match(snapshot.version,/^doc-v1:[a-f0-9]{64}$/);assert.equal(snapshot.content,'# Fixture\n');await service('artifactWrite',{id:doc.id,etag:snapshot.etag,content:'# New'});assert.equal(calls.at(-1).options.headers['if-match'],'"abc"');assert.equal(calls.at(-1).options.body,'# New');await assert.rejects(service('artifactWrite',{id:'/etc/passwd',etag:'"abc"',content:'x'}),/已索引/);
});
test('conflicts and incomplete SSE fail explicitly; complete SSE retains citations and progressive deltas',async()=>{
  const conflict=fixture(()=>new Response('changed',{status:409}));await assert.rejects(conflict.service('reviewAction',{id:'r',workspace:'fixture',revision:'old',action:'dismiss'}),/发生变化/);
  const input={workspace:'fixture',componentId:doc.id,change:doc.id,message:'question',requestId:'r'};
  const incomplete=fixture(()=>new Response('data: {"type":"delta","content":"partial"}\n\n'));await assert.rejects(incomplete.service('chat',input),/未完成/);
  const stream='data: {"type":"metadata","references":[{"id":"source","version":"v1"}]}\n\ndata: {"type":"delta","content":"Answer"}\n\ndata: {"type":"done"}\n\n';const full=fixture(()=>new Response(stream)),events=[];const result=await full.service('chat',input,event=>events.push(event));assert.equal(result.answer,'Answer');assert.equal(result.references[0].version,'v1');assert.deepEqual(events.map(e=>e.type),['metadata','delta','done']);
});
test('chat cancellation aborts the owner request and activity cancellation uses native query',async()=>{
  let started;const ready=new Promise(r=>started=r);const service=createKnowledgeService(async(_url,{signal})=>new Promise((_resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(Error('aborted')));}));const run=service('chat',{workspace:'fixture',componentId:doc.id,change:doc.id,message:'q',requestId:'owner'});await ready;await service('chatCancel',{requestId:'owner'});await assert.rejects(run,/已取消/);
  const native=fixture(()=>new Response('',{status:202}));await native.service('activityCancel',{id:'activity'});assert.equal(native.calls.at(-1).url.searchParams.get('cancel'),'activity');
});
test('saved source relative paths resolve through the index before candidate handoff',async()=>{
  const sourceDoc={...doc,id:'/fixture/knowledge/sources/s.md',path:'/fixture/knowledge/sources/s.md'};
  const service=createKnowledgeService(async url=>{
    assert.equal(url.origin,'http://127.0.0.1:19015');
    if(url.pathname==='/api/workspaces')return Response.json([{alias:'fixture',path:'/fixture'}]);
    if(url.pathname==='/api/wiki/index')return Response.json([sourceDoc]);
    return Response.json({source:{path:'knowledge/sources/s.md'},text:'---\ntitle: Source\n---\n\nExact source body'});
  },{origin:'http://127.0.0.1:19015'});
  const result=await service('source',{workspace:'fixture',id:'s'});assert.equal(result.source.path,sourceDoc.path);assert.equal(result.source.componentId,sourceDoc.id);assert.equal(result.text,'Exact source body');
});
