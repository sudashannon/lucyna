const {failure,hash}=require('./knowledge-library.cjs');
const {sensitiveDocument}=require('./work-knowledge-policy.cjs');

const TYPES=new Set(['duplicate','conflict','scoped','related','uncertain']);
const terminal=new Set(['confirmed','dismissed','clear','obsolete']);
const text=(value,label,max=2000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw failure('整理建议的'+label+'无效');return value.trim();};
const signature=docs=>hash(JSON.stringify(docs.map(d=>[d.id,d.revision,d.hash,(d.sources||[]).map(s=>[s.key,s.revision]).sort((a,b)=>a[0].localeCompare(b[0]))]).sort((a,b)=>a[0].localeCompare(b[0]))));
const pairKey=docs=>hash(docs.map(d=>d.id).sort().join('\0'));

function validateAssessment(value,documents){
 if(!value||!TYPES.has(value.kind))throw failure('整理判断类型无效');
 const title=text(value.title,'标题',120),reason=text(value.reason,'理由'),scope=value.scope;
 if(!scope||!['same','different','unknown'].includes(scope.relation))throw failure('缺少适用范围判断');
 const relation=scope.relation,explanation=text(scope.explanation,'范围说明');
 if(['duplicate','conflict'].includes(value.kind)&&relation!=='same'||value.kind==='scoped'&&relation!=='different'||relation==='unknown'&&value.kind!=='uncertain'&&value.kind!=='related')throw failure('重复或冲突判断必须先核实同一适用范围');
 if(!Array.isArray(value.evidence)||value.evidence.length<2||value.evidence.length>8)throw failure('需要两侧原文证据');
 const evidence=value.evidence.map(e=>{
  const doc=documents.find(d=>d.id===e.document);if(!doc)throw failure('整理引用不属于本次文档');
  const quote=text(e.quote,'原文摘录',2400),claim=text(e.claim,'观点',1200),scopeQuote=e.scopeQuote||'';
  if(quote.length<8||!doc.content.includes(quote))throw failure('整理引用无法在原文中核对');
  if(typeof scopeQuote!=='string'||scopeQuote.length>2000||scopeQuote&&!doc.content.includes(scopeQuote)||relation!=='unknown'&&scopeQuote.trim().length<8)throw failure('适用范围缺少可核对的原文');
  const start=doc.content.indexOf(quote),lineStart=doc.content.slice(0,start).split('\n').length;
  return {document:doc.id,revision:doc.revision,quote,claim,scopeQuote,lineStart,lineEnd:lineStart+quote.split('\n').length-1};
 });
 if(documents.some(d=>!evidence.some(e=>e.document===d.id)))throw failure('缺少一侧文档的证据');
 const r=value.recommendation,actions={duplicate:'merge',conflict:'investigate',scoped:'keep_separate',related:'none',uncertain:'investigate'};
 if(!r||r.action!==actions[value.kind])throw failure('整理动作与问题判断不一致');
 const summary=text(r.summary,'建议'),steps=r.steps,preserve=r.preserve;
 if(!Array.isArray(steps)||steps.length>6||!Array.isArray(preserve)||preserve.length>8||!steps.length&&value.kind!=='related')throw failure('整理建议缺少具体步骤');
 const recommendation={action:r.action,summary,steps:steps.map(s=>text(s,'步骤',800)),preserve:preserve.map(s=>text(s,'保留项',800))};
 const result={kind:value.kind,title,reason,scope:{relation,explanation},evidence,recommendation};
 if(sensitiveDocument(JSON.stringify(result)))throw failure('整理建议含疑似凭据，未保存');
 return result;
}
function validateReview(value){
 if(!value||['evidenceSound','scopeSound','classificationSound','proposalSound'].some(k=>typeof value[k]!=='boolean'))throw failure('整理复核格式无效');
 const reason=text(value.reason,'复核理由');
 if(sensitiveDocument(reason))throw failure('复核内容含疑似凭据，未保存');
 return {evidenceSound:value.evidenceSound,scopeSound:value.scopeSound,classificationSound:value.classificationSound,proposalSound:value.proposalSound,reason,passed:['evidenceSound','scopeSound','classificationSound','proposalSound'].every(k=>value[k])};
}

// A group means connected comparisons, never a transitive assertion of equivalence.
function groups(jobs){
 const result=[];
 for(const kind of ['duplicate','conflict','scoped','uncertain','related','pending']){
  const rows=jobs.filter(j=>(j.assessment?.kind||'pending')===kind),parent=new Map();
  const find=id=>{if(!parent.has(id))parent.set(id,id);if(parent.get(id)!==id)parent.set(id,find(parent.get(id)));return parent.get(id);};
  for(const j of rows){const ids=j.input.documents.map(d=>d.id);parent.set(find(ids[1]),find(ids[0]));}
  const buckets=new Map();for(const j of rows){const root=find(j.input.documents[0].id);if(!buckets.has(root))buckets.set(root,[]);buckets.get(root).push(j);}
  for(const entries of buckets.values()){const ids=[...new Set(entries.flatMap(j=>j.input.documents.map(d=>d.id)))].sort();result.push({id:kind+':'+hash(ids.join('\0')).slice(0,16),kind,documents:ids,records:entries.map(j=>j.id),title:entries[0].assessment?.title||entries[0].input.documents.map(d=>d.title).join(' / '),pending:entries.filter(j=>!terminal.has(j.state)).length});}
 }
 return result;
}
module.exports={validateAssessment,validateReview,signature,pairKey,groups,terminal};
