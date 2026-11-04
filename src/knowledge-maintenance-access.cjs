// Retrieval protection is separate from content rewriting: readers see a warning,
// machine context excludes unresolved documents, and stale document Q&A is blocked.
function createMaintenanceAccess({maintenance,store,nativeJSON,native}){
 const status=id=>maintenance.freshness(id);
 const clean=rows=>(Array.isArray(rows)?rows:[]).filter(row=>!status(row.id||row.path));
 async function search(query,topK=30){const rows=await nativeJSON('/api/wiki/search-semantic',{method:'POST',headers:{'content-type':'application/json'},bytes:JSON.stringify({query,topK})});return clean(rows);}
 async function mcp(message){
  const name=message.params?.name,args=message.params?.arguments||{};
  if(!maintenance.blocked().size)return null;
  const result=value=>({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]}});
  if(['wiki_context','wiki_search'].includes(name)){
   if(typeof args.query!=='string'||!args.query.trim()||args.query.length>2000)return {jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:'请输入有效知识查询'}]}};
   return result({notice:'正在维护的知识已排除；这里只返回当前可用文档证据。',documents:await search(args.query,50)});
  }
  const issue=status(args.document||args.id||args.path);
  if(issue&&['wiki_read','wiki_component','library_read'].includes(name))return result({maintenance:issue,notice:'此文档来源已变化，不能作为已核实结论使用。',document:store.doc(args.document||args.id||args.path)?.id});
  if(['wiki_overview','wiki_claim_search','wiki_claim_get','wiki_claims','wiki_neighbors'].includes(name))return result('知识维护期间暂停生成跨文档综述；请使用 wiki_search 查找当前可用证据。');
  return null;
 }
 async function verify(document,patches){
  const artifact=await native('/api/artifact?'+new URLSearchParams({path:document.path,workspace:document.workspace}));
  const content=artifact.ok?await artifact.text():'';
  const query=(patches[0]||document.content.match(/^#\s+(.+)$/m)?.[1]||document.relative).replace(/[#`\[\]*\n]/g,' ').trim().slice(0,160);
  const rows=await nativeJSON('/api/wiki/search-semantic',{method:'POST',headers:{'content-type':'application/json'},bytes:JSON.stringify({query,topK:50})});
  const hit=Array.isArray(rows)&&rows.find(row=>row.id===document.path||row.path===document.path||row.id===document.id);
  const version=hit?.evidence?.version;
  return {passed:content===document.content&&!!hit&&version==='doc-v1:'+document.hash,artifactMatches:content===document.content,retrievable:!!hit,query,observedVersion:version||null,expectedRevision:document.revision,checkedAt:Date.now()};
 }
 return {mcp,status,search,verify};
}
module.exports={createMaintenanceAccess};
