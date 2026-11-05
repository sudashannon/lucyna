const {hash,failure}=require('./knowledge-library.cjs');
const path=require('node:path');
const {sensitiveDocument}=require('./work-knowledge-policy.cjs');

const MAX_DOCUMENT_BYTES=2*1024*1024,MAX_DIAGNOSTIC_CHARS=6000,MAX_CANDIDATES=5,MAX_CONCURRENT=2;
const issueGuidance={
 orphan:'确认本文是否应连接到具体主题文档。只有本次提供的相关文档确实有关系时才建议关联；独立笔记可以保留原状。',
 'orphan-component':'确认本文是否应连接到具体主题文档。只有本次提供的相关文档确实有关系时才建议关联；独立笔记可以保留原状。',
 'dead-link':'核对报告中的链接目标是否已移动、改名或拼写错误。仅当提供的文档与原目标明确匹配时建议替换。',
 duplicate:'比较同名文档的范围、版本与独有内容。同名不等于重复；只给人工核对和保留差异的步骤。',
 'low-link-density':'查看现有链接与元数据约定，说明是否需要正式关联；不要把链接数少本身描述成内容错误。',
 'missing-sections':'结合文档类别和当前正文，提出缺失要点的具体问题或草稿。报告只能陈述正文已有的验证结果，不能补写未执行的测试或通过结论。',
 'low-quality':'核对具体段落和文档用途。短正文或索引信号不足只是线索；区分需要补充的内容与合理的简短笔记。',
 'design-no-plan':'查看关联变更是否确实需要实施计划；结合已提供计划文档提出下一步，不要臆造计划或完成状态。',
 'stale-active':'询问当前进度并给出继续、更新状态或归档的具体选择。不能仅凭文档创建时间断言工作已经过期。',
 'mermaid-syntax':'指出应从哪类图表语法检查开始；不要改写节点、关系或臆造图表语义。',
 'task-artifact-missing':'判断任务是否要求文件产物。建议指出需核对的任务描述、产物和完成记录；不要声称文件已生成。',
 'stale-claim':'按原结论与其证据，给出应核对的版本、范围和原文位置；不要裁定结论真实或过时。',
 'stale-evidence':'识别需要重新核对的证据范围并给出核验问题；证据版本改变不自动推翻结论。',
};
const text=(value,name,max,optional=false)=>{if(optional&&(value===undefined||value===''))return '';if(typeof value!=='string'||!value.trim()||value.length>max)throw failure(`无效的${name}`);return value;};
const normalized=value=>String(value||'').replace(/\\/g,'/').replace(/\s+/g,' ').trim().toLocaleLowerCase();
const normalizedPath=value=>path.posix.normalize(String(value||'').replace(/\\/g,'/'));
function resolveLinkPath(sourcePath,target){
 const source=String(sourcePath||'').replace(/\\/g,'/'),destination=decodeURIComponent(String(target||'')).replace(/\\/g,'/');
 const windowsAbsolute=value=>/^[a-zA-Z]:\//.test(value)||value.startsWith('//');
 if(windowsAbsolute(destination))return normalizedPath(destination);
 if(path.posix.isAbsolute(destination))return path.posix.normalize(destination);
 if(windowsAbsolute(source))return normalizedPath(path.win32.resolve(path.win32.dirname(source),destination));
 return path.posix.normalize(path.posix.resolve(path.posix.dirname(source),destination));
}
const sourceType=document=>{
 const data=document?.frontmatter&&typeof document.frontmatter==='object'?document.frontmatter:{};
 const type=['type','document_type','documentType','category'].map(key=>data[key]).find(value=>typeof value==='string'&&value.trim());
 const tags=Array.isArray(data.tags)?data.tags.filter(value=>typeof value==='string').slice(0,12):[];
 return {componentType:typeof document?.type==='string'?document.type:'',documentType:type||'',tags};
};
function boundedExcerpt(content,terms,limit){
 if(content.length<=limit)return {content,partial:false};
 const words=[...new Set(String(terms||'').toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[])].slice(0,18);
 let best=0,bestScore=0;
 for(const word of words){const found=content.toLocaleLowerCase().indexOf(word);if(found<0)continue;const left=Math.max(0,found-Math.floor(limit*0.35)),start=content.lastIndexOf('\n',left)+1;const score=words.reduce((n,candidate)=>n+(content.toLocaleLowerCase().indexOf(candidate,start)>=0?1:0),0);if(score>bestScore){best=start;bestScore=score;}}
 let start=Math.max(0,best);if(start>0)start=content.indexOf('\n',start);if(start<0)start=best;
 let end=Math.min(content.length,start+limit);if(end<content.length){const boundary=content.lastIndexOf('\n',end);if(boundary>start+limit*0.65)end=boundary;}
 return {content:content.slice(start,end),partial:true};
}
function canonicalCatalog(value){
 const workspaces=Array.isArray(value?.workspaces)?value.workspaces:[],documents=Array.isArray(value?.documents)?value.documents:[];
 const stableDocuments=documents.map(d=>({id:d.id,path:d.path,workspace:d.workspace,title:d.title,type:d.type,updatedAt:d.updatedAt})).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 return {workspaces,documents,signature:hash(Buffer.from(JSON.stringify({workspaces:workspaces.map(w=>({alias:w.alias,path:w.path})).sort((a,b)=>String(a.alias).localeCompare(String(b.alias))),documents:stableDocuments})))};
}

class KnowledgeReviewAdvice{
 constructor({store,agent,config,getReviews,getCatalog,readDocument,search,isBlocked=()=>null,clock=Date.now,maxConcurrent=MAX_CONCURRENT}={}){
  if(!store?.db||typeof getReviews!=='function'||typeof getCatalog!=='function'||typeof readDocument!=='function'||typeof search!=='function')throw Error('待核实处理建议服务缺少可信读取接口');
  Object.assign(this,{store,agent,config,getReviews,getCatalog,readDocument,search,isBlocked,clock,maxConcurrent});
  this.jobs=new Map();this.jobDocuments=new Map();this.controllers=new Map();this.retiringDocuments=new Set();this.requests=new Set();this.stopController=new AbortController();this.stopped=false;
  store.db.exec('CREATE TABLE IF NOT EXISTS knowledge_review_advice(review_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
 }
 async loadFinding(input,signal){
  if(this.stopped)throw failure('知识服务正在停止，请稍后重试',503);
  const id=text(input?.id,'待核实记录标识',1024),workspace=text(input?.workspace,'知识来源',256),revision=text(input?.revision,'检查版本',1024);
  if(input?.generate!==undefined&&typeof input.generate!=='boolean'||input?.refresh!==undefined&&typeof input.refresh!=='boolean')throw failure('建议生成选项无效');
  signal?.throwIfAborted();const findings=await this.getReviews(signal);signal?.throwIfAborted();const finding=findings.find(item=>item.id===id);
  if(!finding)throw failure('这条待核实记录已不存在，请刷新列表',404);
  if(finding.workspace!==workspace||finding.issue?.inputRevision!==revision||!revision)throw failure('这条待核实记录的版本已变化，请刷新列表后重新核对',409);
  const catalog=canonicalCatalog(await this.getCatalog(signal));signal?.throwIfAborted();const document=catalog.documents.find(doc=>doc.id===finding.issue?.componentId&&doc.workspace===finding.workspace);
  if(!document||document.type==='session')throw failure('待核实文档当前未被索引，请刷新列表后重试',409);
  const snapshot=await this.readDocument(document,signal);signal?.throwIfAborted();
  if(typeof snapshot?.content!=='string')throw failure('暂时无法读取待核实文档原文，请检查来源后重试');
  const bytes=Buffer.from(snapshot.content);
  if(bytes.length>MAX_DOCUMENT_BYTES)throw failure('待核实文档超过读取上限，请先拆分文档再生成建议',413);
  if(sensitiveDocument(snapshot.content))throw failure('原文包含疑似敏感凭据。请先脱敏再生成模型建议');
  const issue={...finding.issue,detail:String(finding.issue.detail||'').slice(0,MAX_DIAGNOSTIC_CHARS),target:String(finding.issue.target||'').slice(0,1024)};
  const version=hash(bytes);
  return {id,workspace,revision,finding:{...finding,issue},catalog,document,content:snapshot.content,version};
 }
 cacheRow(id){const row=this.store.db.prepare('SELECT data FROM knowledge_review_advice WHERE review_id=?').get(id);if(!row)return null;try{return JSON.parse(row.data);}catch{this.store.db.prepare('DELETE FROM knowledge_review_advice WHERE review_id=?').run(id);return null;}}
 async cacheMatches(row,base,config,signal){
  const configSignature=hash(Buffer.from(JSON.stringify({protocol:config?.protocol,baseURL:config?.baseURL,model:config?.model})));
  if(!row||row.reviewId!==base.id||row.workspace!==base.workspace||row.inputRevision!==base.revision||row.documentId!==base.document.id||row.documentVersion!==base.version||row.rule!==base.finding.issue.rule||row.catalogSignature!==base.catalog.signature||row.model!==config?.model||row.configSignature!==configSignature)return false;
  for(const ref of row.sourceVersions||[]){signal?.throwIfAborted();const doc=base.catalog.documents.find(item=>item.id===ref.id&&item.workspace===ref.workspace);if(!doc)return false;try{if(!!this.isBlocked(doc.id)!==!!ref.blocked)return false;const snapshot=await this.readDocument(doc,signal);signal?.throwIfAborted();if(typeof snapshot?.content!=='string'||Buffer.byteLength(snapshot.content)>MAX_DOCUMENT_BYTES||hash(Buffer.from(snapshot.content))!==ref.version)return false;}catch(error){if(signal?.aborted)throw error;return false;}}
  return true;
 }
 response(row,cached){return {...row.advice,reviewId:row.reviewId,workspace:row.workspace,inputRevision:row.inputRevision,documentId:row.documentId,documentVersion:row.documentVersion,rule:row.rule,generatedAt:row.generatedAt,model:row.model,cached};}
 async retireDocument(documentId,action){
  this.retiringDocuments.add(documentId);
  const pending=[];for(const [key,id] of this.jobDocuments)if(id===documentId){this.controllers.get(key)?.abort();const task=this.jobs.get(key);if(task)pending.push(task);}
  await Promise.allSettled(pending);
  try{const result=await action();if(result?.deleted){for(const row of this.store.db.prepare('SELECT review_id,data FROM knowledge_review_advice').all()){let value;try{value=JSON.parse(row.data);}catch{}if(value?.documentId===documentId)this.store.db.prepare('DELETE FROM knowledge_review_advice WHERE review_id=?').run(row.review_id);}}return result;}
  finally{this.retiringDocuments.delete(documentId);}
 }
 get(input,requestSignal){
  if(this.stopped) return Promise.reject(failure('知识服务正在停止，请稍后重试',503));
  const signals=[this.stopController.signal];if(requestSignal)signals.push(requestSignal);const signal=AbortSignal.any(signals);
  const task=this.getCurrent(input,signal);this.requests.add(task);
  return task.finally(()=>this.requests.delete(task));
 }
 async getCurrent(input,requestSignal){
  const base=await this.loadFinding(input,requestSignal);requestSignal.throwIfAborted();const config=this.config();
  if(this.retiringDocuments.has(base.document.id))throw failure('此文档正在删除，请刷新待核实列表后重试',409);
  if(!input.generate){const row=this.cacheRow(base.id);if(await this.cacheMatches(row,base,config,requestSignal)){requestSignal.throwIfAborted();return this.response(row,true);}requestSignal.throwIfAborted();return null;}
  const key=[base.id,base.workspace,base.revision,base.version,base.catalog.signature].join('\0');
  if(!input.refresh){const row=this.cacheRow(base.id);if(await this.cacheMatches(row,base,config,requestSignal)){requestSignal.throwIfAborted();return this.response(row,true);}}
  requestSignal.throwIfAborted();if(this.stopped)throw failure('知识服务正在停止，请稍后重试',503);
  if(this.jobs.has(key))return this.jobs.get(key);
  if(this.jobs.size>=this.maxConcurrent)throw failure('当前有多条处理建议正在生成，请稍后重试',429);
  if(!config?.baseURL||!config?.model)throw failure('请先在设置中配置辅助模型 API 地址和模型名称，再生成处理建议');
  if(typeof this.agent?.adviseKnowledgeReview!=='function')throw failure('当前辅助模型不支持生成待核实处理建议');
  const controller=new AbortController();this.controllers.set(key,controller);this.jobDocuments.set(key,base.document.id);
  const signal=AbortSignal.any([requestSignal,controller.signal]);
  const job=this.generate(base,input,config,signal).finally(()=>{this.controllers.delete(key);this.jobDocuments.delete(key);this.jobs.delete(key);});
  this.jobs.set(key,job);return job;
 }
 async contextFor(base){
  const {finding,document,catalog,content}=base,issue=finding.issue,rule=issue.rule,title=document.title||'',type=sourceType(document);
  const inputText=[title,issue.detail,issue.target||'',content.slice(0,6000)].join('\n');
  const matches=new Map(),add=(doc,relation,rank)=>{if(!doc||doc.id===document.id||doc.type==='session')return;const old=matches.get(doc.id);if(!old||rank<old.rank)matches.set(doc.id,{doc,relation,rank});};
  const byId=new Map(catalog.documents.map(doc=>[doc.id,doc])),byPath=new Map(catalog.documents.map(doc=>[normalizedPath(doc.path),doc]));
  const target=issue.target&&byId.get(issue.target)||issue.target&&byPath.get(normalizedPath(issue.target));if(target)add(target,'检查目标',0);
  for(const match of content.matchAll(/\[[^\]]{1,240}\]\(([^)\s]{1,2000})(?:\s+[^)]*)?\)/g)){
   const href=match[1].split(/[?#]/)[0];if(!href||(/^[a-z][a-z0-9+.-]*:/i.test(href)&&!path.win32.isAbsolute(href))||href.startsWith('//')||href.startsWith('#'))continue;
   let linked;try{linked=resolveLinkPath(document.path,href);}catch{continue;}
   const found=byPath.get(normalizedPath(linked));if(found)add(found,'原文链接',0);
  }
  if(rule==='duplicate')for(const peer of catalog.documents)if(peer.id!==document.id&&peer.title&&normalized(peer.title)===normalized(title))add(peer,'同名文档',1);
  let query=[title,rule,issue.target||'',issue.detail||''].filter(Boolean).join(' ').replace(/(?:[a-zA-Z]:)?[\\/][^\s]+/g,' ').slice(0,1000);
  let searchResults=[],searchFailed=false;
  try{const result=await this.search(query,8,base.signal);searchResults=Array.isArray(result)?result:[];}catch(error){if(base.signal?.aborted)throw error;searchFailed=true;}
  for(const result of searchResults){const doc=byId.get(result.id)||byPath.get(normalizedPath(result.path||result.id));if(doc)add(doc,'相关主题检索',2);}
  const selected=[...matches.values()].sort((a,b)=>a.rank-b.rank||String(a.doc.title).localeCompare(String(b.doc.title))).slice(0,MAX_CANDIDATES);
  const documents=[],sources=[],notes=['相关文档仅来自当前索引中的显式链接、同名检查或语义检索前 8 条；未审阅整个知识库。'];
  if(searchFailed)notes.push('相关主题检索未能完成，建议未检查完整的可用关联文档。');
  if([...matches.values()].length>selected.length)notes.push(`相关文档超过本次读取上限，只读取了 ${selected.length} 份。`);
  for(const candidate of selected){
   const related=candidate.doc;let snapshot;
   try{snapshot=await this.readDocument(related,base.signal);}catch(error){if(base.signal?.aborted)throw error;notes.push(`无法读取相关文档“${related.title}”，本次建议不覆盖其内容。`);continue;}
   if(typeof snapshot?.content!=='string')continue;
   if(Buffer.byteLength(snapshot.content)>MAX_DOCUMENT_BYTES){notes.push(`相关文档“${related.title}”超过读取上限，本次建议不覆盖其内容。`);continue;}
   const version=hash(Buffer.from(snapshot.content)),blocked=!!this.isBlocked(related.id),sensitive=sensitiveDocument(snapshot.content);
   const excerpt=boundedExcerpt(snapshot.content,inputText,2400),isPartial=excerpt.partial||blocked;
   const entry={id:related.id,title:related.title,path:related.path,workspace:related.workspace,version,content:blocked||sensitive?'':excerpt.content,partial:isPartial,blocked,reason:blocked?'此文档仍待知识维护核实':sensitive?'检测到疑似敏感信息，正文未发送给模型':'',relation:candidate.relation,type:sourceType(related)};
   documents.push(entry);
   sources.push({id:related.id,workspace:related.workspace,version,blocked,sensitive});
   if(sensitive)notes.push(`相关文档“${related.title}”含疑似敏感信息，已跳过正文。`);
  }
  if(documents.length<selected.length)notes.push('部分已索引相关文档暂不可读取，本次内容覆盖不完整。');
  const excerpt=boundedExcerpt(content,[title,issue.detail,issue.target].filter(Boolean).join(' '),12000);
  if(excerpt.partial)notes.push('待核实正文经过截取，建议只覆盖本次展示的段落。');
  if(documents.some(doc=>doc.partial&&!doc.blocked))notes.push('部分相关文档只向模型提供了片段。');
  if(documents.some(doc=>doc.blocked))notes.push('有相关文档仍待知识维护核实，未作为建议依据。');
  if(documents.some(doc=>doc.sensitive))notes.push('有相关文档含疑似敏感信息，已跳过正文。');
  const main={id:document.id,title:document.title,path:document.path,workspace:document.workspace,version:base.version,content:excerpt.content,partial:excerpt.partial,type};
  const coverage='partial';
  const input={finding:{id:finding.id,workspace:finding.workspace,revision:issue.inputRevision,issue:{rule,detail:issue.detail||'',target:issue.target||''},guidance:issueGuidance[rule]||'结合原文逐项核对这一问题。指出具体下一步和无法从现有资料确认的问题。'},document:main,context:{coverage,documents,notes}};
  return {input,sources,notes,coverage};
 }
 validateAdvice(raw,input,context){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw failure('辅助模型返回的处理建议格式无效，请重新生成');
  const boundedList=(key,maxCount)=>{const values=raw[key]===undefined?[]:raw[key];if(!Array.isArray(values)||values.length>maxCount||values.some(value=>typeof value!=='string'||!value.trim()||value.length>300))throw failure('辅助模型返回的处理建议格式无效，请重新生成');return [...new Set(values.map(value=>value.trim()))];};
  const summary=text(raw.summary,'处理意见',1200),steps=boundedList('steps',6);if(!steps.length)throw failure('辅助模型没有提供可执行的核对步骤，请重新生成');
  const suggestedText=typeof raw.suggestedText==='string'?raw.suggestedText:'';if(suggestedText.length>8000)throw failure('辅助模型草稿超过显示上限，请重新生成');
  const questions=boundedList('questions',5),limitations=[...new Set([...boundedList('limitations',3),...context.notes])].slice(0,8);
  const lookup=new Map([[input.document.id,{...input.document,content:input.document.content,blocked:false}]]);
  for(const doc of context.input.context.documents)if(!doc.blocked&&doc.content)lookup.set(doc.id,doc);
  const refs=raw.references===undefined?[]:raw.references;if(!Array.isArray(refs)||refs.length>5)throw failure('辅助模型返回的依据超出上限，请重新生成');
  const references=[],seen=new Set();
  for(const ref of refs){
   if(!ref||typeof ref!=='object'||typeof ref.id!=='string'||typeof ref.quote!=='string')throw failure('辅助模型返回的依据格式无效，请重新生成');
   const doc=lookup.get(ref.id),quote=ref.quote.trim();
   if(!doc||quote.length<8||quote.length>800||!doc.content.includes(quote))throw failure('辅助模型引用了本次原文中无法核对的依据，请重新生成');
   if(seen.has(ref.id+'\0'+quote))continue;seen.add(ref.id+'\0'+quote);
   references.push({id:doc.id,title:doc.title,path:doc.path,workspace:doc.workspace,version:doc.version,quote,partial:!!doc.partial});
  }
  const displayed=[summary,...steps,...questions,...limitations,suggestedText].join('\n');
  if(sensitiveDocument(displayed))throw failure('辅助模型输出含疑似敏感信息，未展示建议；请重新生成');
  for(const match of displayed.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)){
   const target=match[1];if(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target))throw failure('辅助模型提供了未经索引确认的链接，请重新生成');
   let linked;try{const local=target.split(/[?#]/)[0];linked=input.document.id===local?local:resolveLinkPath(input.document.path,local);}catch{throw failure('辅助模型提供了无法核对的文档链接，请重新生成');}
   const supplied=[input.document,...context.input.context.documents.filter(doc=>!doc.blocked&&doc.content)];
   if(!supplied.some(doc=>doc.id===target||normalizedPath(doc.path)===normalizedPath(linked)))throw failure('辅助模型提供了未经索引确认的链接，请重新生成');
  }
  return {summary,steps,...(suggestedText.trim()?{suggestedText:suggestedText.trim()}:{}),questions,references,limitations};
 }
 async ensureCurrent(base,context,signal){
  signal.throwIfAborted();const findings=await this.getReviews(signal);signal.throwIfAborted();const finding=findings.find(item=>item.id===base.id);
  if(!finding||finding.workspace!==base.workspace||finding.issue?.inputRevision!==base.revision)throw failure('生成期间待核实记录已变化；建议未保存，请刷新列表后重试',409);
  const catalog=canonicalCatalog(await this.getCatalog(signal));signal.throwIfAborted();if(catalog.signature!==base.catalog.signature)throw failure('生成期间知识索引已变化；建议未保存，请刷新列表后重试',409);
  const current=await this.readDocument(base.document,signal);signal.throwIfAborted();if(hash(Buffer.from(current.content))!==base.version)throw failure('生成期间原文已变化；建议未保存，请刷新列表后重试',409);
  for(const ref of context.sources){const doc=catalog.documents.find(value=>value.id===ref.id&&value.workspace===ref.workspace);if(!doc)throw failure('生成期间相关文档已离开索引；建议未保存，请重新生成',409);if(!!this.isBlocked(doc.id)!==!!ref.blocked)throw failure('生成期间相关文档的核实状态已变化；建议未保存，请重新生成',409);const snapshot=await this.readDocument(doc,signal);signal.throwIfAborted();if(typeof snapshot?.content!=='string'||Buffer.byteLength(snapshot.content)>MAX_DOCUMENT_BYTES||hash(Buffer.from(snapshot.content))!==ref.version)throw failure('生成期间相关文档已变化；建议未保存，请重新生成',409);}
 }
 async generate(base,input,config,signal){
  base.signal=signal;
  const context=await this.contextFor(base);signal.throwIfAborted();
  const raw=await this.agent.adviseKnowledgeReview(config,context.input,signal);
  signal.throwIfAborted();
  const advice=this.validateAdvice(raw,context.input,context);
  await this.ensureCurrent(base,context,signal);signal.throwIfAborted();
  if(this.retiringDocuments.has(base.document.id))throw failure('此文档正在删除，建议未保存',409);
  const row={reviewId:base.id,workspace:base.workspace,inputRevision:base.revision,documentId:base.document.id,documentVersion:base.version,rule:base.finding.issue.rule,catalogSignature:base.catalog.signature,configSignature:hash(Buffer.from(JSON.stringify({protocol:config.protocol,baseURL:config.baseURL,model:config.model}))),sourceVersions:context.sources.map(({id,workspace,version,blocked})=>({id,workspace,version,blocked})),generatedAt:this.clock(),model:config.model,advice};
  this.store.db.prepare('INSERT INTO knowledge_review_advice VALUES(?,?) ON CONFLICT(review_id) DO UPDATE SET data=excluded.data').run(base.id,JSON.stringify(row));
  return this.response(row,false);
 }
 async stop(){this.stopped=true;this.stopController.abort();for(const controller of this.controllers.values())controller.abort();await Promise.allSettled([...this.requests,...this.jobs.values()]);this.jobs.clear();this.jobDocuments.clear();this.controllers.clear();this.requests.clear();}
}

module.exports={KnowledgeReviewAdvice,boundedExcerpt,issueGuidance};
