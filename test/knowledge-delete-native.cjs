// Real private host and Stele with an isolated temporary knowledge library.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {startKnowledgeHost}=require('../src/knowledge-host.cjs');

async function main(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-delete-native-')),originalFetch=global.fetch,checks=[];let host,failRebuild=false;
 global.fetch=(input,options={})=>{
  const url=new URL(typeof input==='string'?input:input.url||String(input));
  if(failRebuild&&url.pathname==='/api/wiki/rebuild'&&options.method==='POST')return Promise.resolve(Response.json({error:'fixture rebuild unavailable'},{status:503}));
  return originalFetch(input,options);
 };
 try{
  host=await startKnowledgeHost({directory});
  for(const task of [host.consolidation,host.maintenance,host.governance])clearInterval(task.timer);
  const call=async(route,input,status=200)=>{
   const response=await fetch(host.url+route,{method:input?'POST':'GET',headers:{authorization:'Bearer '+host.token,'content-type':'application/json'},body:input?JSON.stringify(input):undefined});
   const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
  };
  const library=host.store.list()[0],relative='资料/需要删除的文档.md';
  const target=await call('/api/library/write',{library:library.id,relative,content:'# 同名测试文档\n\n第一份正文，只存在于临时测试库。\n',expected:'new'});
  const sibling=await call('/api/library/write',{library:library.id,relative:'资料/保留文档.md',content:'# 同名测试文档\n\n第二份正文需要保留。\n',expected:'new'});
  let finding=(await call('/api/wiki/reviews')).find(item=>item.issue.componentId===target.path&&item.issue.rule==='duplicate');
  assert.ok(finding?.issue.inputRevision,'native duplicate finding exists');
  const input={id:finding.id,workspace:finding.workspace,revision:finding.issue.inputRevision,documentId:target.id,documentRevision:target.revision,operationId:randomUUID()};
  const updated=await host.store.write({document:target.id,content:host.store.read(target.id).content+'\n确认框打开后的正文更新。\n',expected:target.revision});
  const unchangedFinding=(await call('/api/wiki/reviews')).find(item=>item.id===finding.id);
  assert.equal(unchangedFinding.issue.inputRevision,input.revision,'duplicate input hash does not bind the body');
  await call('/api/reviews/delete',input,409);
  assert.equal(fs.readFileSync(target.path,'utf8'),host.store.read(target.id).content);
  checks.push('managed document revision protects changed body even when the review input hash is unchanged');

  const confirmed={...input,documentRevision:updated.revision,operationId:randomUUID()};
  failRebuild=true;
  const [deleted,repeated]=await Promise.all([call('/api/reviews/delete',confirmed),call('/api/reviews/delete',confirmed)]);
  assert.equal(deleted.deleted,true);assert.equal(repeated.deleted,true);assert.equal(deleted.indexed,false);assert.ok(deleted.warning);
  assert.equal(fs.existsSync(target.path),false);assert.ok(fs.existsSync(host.store.revisionPath(target.id,updated.revision)));
  assert.equal(host.store.db.prepare('SELECT count(*) AS n FROM document_tombstones WHERE document=?').get(target.id).n,1);
  assert.ok((await host.nativeJSON('/api/wiki/index')).some(doc=>doc.id===target.path),'native index intentionally still contains the deleted path');
  assert.equal((await call('/api/wiki/index')).some(doc=>doc.id===target.path),false);
  assert.equal((await call('/api/wiki/reviews')).some(item=>item.issue.componentId===target.path),false);
  assert.ok((await call('/api/wiki/index')).some(doc=>doc.id===sibling.path));
  checks.push('concurrent operation retries delete once and stale native index entries stay hidden after a rebuild failure');

  failRebuild=false;
  const recreated=await call('/api/library/write',{library:library.id,relative,content:'# 同名测试文档\n\n显式新建的另一篇文档。\n',expected:'new'});
  assert.notEqual(recreated.id,target.id);
  assert.ok((await call('/api/wiki/index')).some(doc=>doc.id===recreated.path));
  assert.ok((await call('/api/wiki/reviews')).some(item=>item.issue.componentId===recreated.path));
  const replay=await call('/api/reviews/delete',confirmed);assert.equal(replay.documentId,target.id);assert.equal(replay.deleted,true);
  assert.equal(fs.readFileSync(recreated.path,'utf8'),host.store.read(recreated.id).content);
  assert.ok(host.store.doc(recreated.id));assert.ok(host.store.doc(sibling.id));
  await call('/api/reviews/delete',{...confirmed,documentId:recreated.id,documentRevision:recreated.revision},409);
  checks.push('explicit same-path recreation remains visible and an old delete operation cannot delete its new identity');
  console.log(JSON.stringify({passed:true,checks,directory}));
 }finally{global.fetch=originalFetch;await host?.stop();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
