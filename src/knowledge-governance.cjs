const {randomUUID}=require('node:crypto');
const {failure,hash}=require('./knowledge-library.cjs');
const {inventory,readRevision}=require('./knowledge-maintenance-sources.cjs');
const {sensitiveDocument}=require('./work-knowledge-policy.cjs');
const {validateAssessment,validateReview,signature,pairKey,groups}=require('./knowledge-governance-policy.cjs');

const labels={idle:'等待知识变化',discovering:'查找相关文档',analyzing:'比较观点与范围',verifying:'单独复核判断',waiting_agent:'等待辅助模型',waiting_maintenance:'等待本轮维护完成',paused:'整理检查已暂停',error:'整理检查未完成'};
const finished=new Set(['confirmed','dismissed','clear','obsolete']);
class KnowledgeGovernance{
 constructor({store,agent,maintenance,consolidation,search,clock=Date.now,idleMs=60000,intervalMs=1800000,discoveryBatch=8,comparisonBatch=3}){
  Object.assign(this,{store,agent,maintenance,consolidation,search,clock,idleMs,intervalMs,discoveryBatch,comparisonBatch});this.active=null;this.job=null;this.stopped=false;
  store.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_governance_settings(id INTEGER PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS knowledge_governance_documents(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS knowledge_governance_jobs(id TEXT PRIMARY KEY,pair TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS knowledge_governance_job_state ON knowledge_governance_jobs(json_extract(data,'$.state'));`);
  if(!store.db.prepare('SELECT 1 FROM knowledge_governance_settings').get())this.settings({enabled:true,state:'idle',lastScan:0,nextScan:0,usedTokens:0});
  for(const j of this.jobs())if(['analyzing','verifying'].includes(j.state)){j.state='queued';this.event(j,'recovered','服务恢复，核对原文版本后继续比较');}
 }
 settings(next){if(next)this.store.db.prepare('INSERT INTO knowledge_governance_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(next));return JSON.parse(this.store.db.prepare('SELECT data FROM knowledge_governance_settings WHERE id=1').get().data);}
 state(state,message){this.settings({...this.settings(),state,message:message||labels[state]});}
 jobs(limit=0){const query='SELECT data FROM knowledge_governance_jobs ORDER BY rowid DESC';const rows=limit?this.store.db.prepare(query+' LIMIT ?').all(limit):this.store.db.prepare(query).all();return rows.map(r=>JSON.parse(r.data));}
 get(id){if(typeof id!=='string')throw failure('请选择整理记录');const row=this.store.db.prepare('SELECT data FROM knowledge_governance_jobs WHERE id=?').get(id);if(!row)throw failure('整理记录不存在',404);const j=JSON.parse(row.data);j.input.documents=j.input.documents.map(d=>{const content=readRevision(this.store,d.id,d.revision);return {...d,content,...(hash(content)!==d.hash?{contentError:'原文快照无法校验，请查看当前原文'}:{})};});return j;}
 save(j){j.version=(j.version||0)+1;j.updatedAt=this.clock();
  // The library already owns immutable revisions. Keep references in the queue,
  // so repeated pairs do not duplicate entire documents in every history row.
  const stored={...j,input:{...j.input,documents:j.input.documents.map(({content,contentError,...d})=>d)}};
  this.store.db.prepare('INSERT INTO knowledge_governance_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(j.id,j.pair,j.fingerprint,JSON.stringify(stored));
 }
 event(j,phase,message){j.events=[...(j.events||[]),{at:this.clock(),phase,message}].slice(-60);this.save(j);}
 tracked(id){const row=this.store.db.prepare('SELECT data FROM knowledge_governance_documents WHERE id=?').get(id);return row?JSON.parse(row.data):null;}
 track(id,data){this.store.db.prepare('INSERT INTO knowledge_governance_documents VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(data));}
 charge(tokens){if(Number.isSafeInteger(tokens)&&tokens>=0)this.settings({...this.settings(),usedTokens:this.settings().usedTokens+tokens});}
 status(){const s=this.settings(),rows=this.jobs(200),counts=Object.fromEntries(this.store.db.prepare("SELECT json_extract(data,'$.state') AS state,count(*) AS count FROM knowledge_governance_jobs GROUP BY json_extract(data,'$.state')").all().map(r=>[r.state,r.count])),count=(...states)=>states.reduce((n,state)=>n+(counts[state]||0),0);return {...s,label:labels[s.state],running:!!this.job,model:this.consolidation?.config?.model||'',counts:{queued:count('queued','analyzing','verifying'),ready:count('ready'),review:count('review','error','waiting_sources'),confirmed:count('confirmed')},total:Object.values(counts).reduce((a,b)=>a+b,0),groups:groups(rows),jobs:rows.map(({input,assessment,review,...j})=>({...j,kind:assessment?.kind||'pending',title:assessment?.title||input.documents.map(d=>d.title).join(' / '),reason:j.reason||assessment?.reason,documents:input.documents.map(({content,...d})=>d),canConfirm:j.state==='ready'&&review?.passed===true})),coverage:s.coverage||{documents:0,eligible:0,scanned:0,remaining:0},warnings:s.warnings||[]};}
 configure(input){if(!input||Object.keys(input).some(k=>!['enabled','scan'].includes(k)))throw failure('无效整理设置');const s=this.settings();if(input.enabled!==undefined){if(typeof input.enabled!=='boolean')throw failure('整理开关无效');s.enabled=input.enabled;}if(input.scan)s.nextScan=0;this.settings(s);if(!s.enabled){this.active?.abort();this.state('paused');}else if(!this.active)this.state('idle');return this.status();}
 start(){this.timer=setInterval(()=>void this.tick().catch(()=>{}),15000);this.timer.unref();}
 async stop(){this.stopped=true;clearInterval(this.timer);this.active?.abort();await this.job?.catch(()=>{});}
 async tick(){if(this.stopped||this.job)return;this.job=this.run().finally(()=>{this.job=null;});return this.job;}
 async view(){const v=await inventory(this.store,this.consolidation),blocked=this.maintenance?.blocked()||new Set(),unavailable=new Set(v.warnings.map(w=>w.document));return {...v,eligible:new Map([...v.docs].filter(([id,d])=>d.readable&&!blocked.has(id)&&!(v.references.get(id)||[]).some(s=>s.missing||blocked.has(s.document)||unavailable.has(s.document)||s.baseline&&s.baseline!==s.revision)))};}
 snapshot(d,view){return {id:d.id,revision:d.revision,hash:d.hash,title:d.title,path:d.path,workspace:d.workspace,relative:d.relative,content:d.content,work:d.provenance?.root||null,sources:(view.references.get(d.id)||[]).map(s=>({key:s.key,revision:s.revision,label:s.label}))};}
 async current(j){const v=await this.view();const docs=j.input.documents.map(d=>v.eligible.get(d.id));if(docs.some(d=>!d)||signature(docs.map(d=>this.snapshot(d,v)))!==j.fingerprint)throw failure('原文版本或来源状态已变化，请重新扫描',409);return v;}
 async scan(signal){
  this.state('discovering');const view=await this.view(),all=this.jobs();
  for(const j of all){if(j.state==='obsolete')continue;const docs=j.input.documents.map(d=>view.docs.get(d.id));if(docs.some(d=>!d)||signature(docs.map(d=>this.snapshot(d,view)))!==j.fingerprint){j.state='obsolete';this.event(j,'obsolete','原文出现新版本，此次判断仅作为历史保留');}else if(docs.some(d=>!view.eligible.has(d.id))&&!finished.has(j.state)&&j.state!=='waiting_sources'){j.resumeState=j.state;j.state='waiting_sources';this.event(j,'waiting_sources','文档或上游来源尚未完成维护，暂缓比较与确认');}else if(j.state==='waiting_sources'&&docs.every(d=>view.eligible.has(d.id))){j.state=j.resumeState||'queued';delete j.resumeState;this.event(j,'sources_ready','来源已恢复，继续核对原文');}}
  const pending=[];let scanned=0;
  for(const d of view.eligible.values()){
   const inputSignature=signature([this.snapshot(d,view)]);let t=this.tracked(d.id);if(!t||t.inputSignature!==inputSignature){t={revision:d.revision,inputSignature,observedAt:this.clock(),searchedRevision:null};this.track(d.id,t);}
   if(t.searchedRevision===d.revision)scanned++;else if(this.clock()-t.observedAt>=this.idleMs)pending.push(d);
  }
  pending.sort((a,b)=>(this.tracked(a.id)?.attemptedAt||0)-(this.tracked(b.id)?.attemptedAt||0)||a.id.localeCompare(b.id));
  const errors=[];
  for(const d of pending.slice(0,this.discoveryBatch)){
   signal.throwIfAborted();let rows;this.track(d.id,{...this.tracked(d.id),attemptedAt:this.clock()});
   try{rows=await this.search((d.title+'\n'+d.content.replace(/^---[\s\S]*?---/,'').slice(0,1800)).slice(0,2000),12);}catch{errors.push({document:d.id,title:d.title,reason:'相关文档检索失败，下轮将重试'});continue;}
   signal.throwIfAborted();if(!Array.isArray(rows)){errors.push({document:d.id,title:d.title,reason:'检索未返回有效列表，下轮重试'});continue;}
   const peers=new Map();let staleIndex=false;for(const row of rows){if(typeof (row?.id||row?.path)!=='string')continue;const id=this.store.doc(row.id||row.path)?.id,peer=view.eligible.get(id);if(peer&&row.evidence?.version&&row.evidence.version!=='doc-v1:'+peer.hash){staleIndex=true;continue;}if(peer&&id!==d.id)peers.set(id,peer);if(peers.size===8)break;}
   for(const peer of peers.values()){
    const docs=[d,peer].sort((a,b)=>a.id.localeCompare(b.id)),fp=signature(docs.map(d=>this.snapshot(d,view)));if(this.store.db.prepare('SELECT 1 FROM knowledge_governance_jobs WHERE fingerprint=?').get(fp))continue;
    const inputs=docs.map(doc=>this.snapshot(doc,view)),shared=[...new Set(inputs[0].sources.map(s=>s.key).filter(key=>inputs[1].sources.some(s=>s.key===key)))];
    const j={id:randomUUID(),pair:pairKey(docs),fingerprint:fp,state:'queued',createdAt:this.clock(),events:[],input:{documents:inputs,sharedSources:shared,sameWork:!!inputs[0].work&&inputs[0].work===inputs[1].work}};
    this.event(j,'discovered','检索发现相关文档；相似排序不代表重复或可信度');
   }
   if(staleIndex){errors.push({document:d.id,title:d.title,reason:'部分检索结果尚未更新到当前版本，下轮重试'});continue;}
   this.track(d.id,{...this.tracked(d.id),searchedRevision:d.revision,searchedAt:this.clock()});scanned++;
  }
  const remaining=view.eligible.size-scanned;
  this.settings({...this.settings(),lastScan:this.clock(),nextScan:this.clock()+(remaining?15000:this.intervalMs),coverage:{documents:view.docs.size,eligible:view.eligible.size,scanned,remaining},warnings:[...view.warnings,...[...view.docs.values()].filter(d=>d.readable&&!view.eligible.has(d.id)).map(d=>({document:d.id,title:d.title,reason:'文档或上游来源待核实，暂不比较'})),...errors]});
 }
 async process(j,signal){
  await this.current(j);
  j.input=this.get(j.id).input;if(j.input.documents.some(d=>d.contentError))throw failure('原文快照无法校验，请重新扫描',409);
  if(!j.assessment){j.state='analyzing';j.model=this.consolidation.config.model;this.state('analyzing');this.event(j,'analyzing','内嵌 agent 比较两侧观点、版本、设备和环境');const result=await this.agent.assessKnowledge(this.consolidation.config,j.input,signal);this.charge(result.usedTokens);signal.throwIfAborted();j.assessment=validateAssessment(result,j.input.documents);await this.current(j);this.save(j);}
  j.state='verifying';j.reviewModel=this.consolidation.config.model;this.state('verifying');this.event(j,'verifying','单独请求复核引用、适用范围、分类与建议');
  const review=await this.agent.verifyKnowledgeAssessment(this.consolidation.config,{...j.input,assessment:j.assessment},signal);this.charge(review.usedTokens);signal.throwIfAborted();j.review=validateReview(review);await this.current(j);
  j.state=!j.review.passed||j.assessment.kind==='uncertain'?'review':j.assessment.kind==='related'?'clear':'ready';j.reason=j.review.passed?j.assessment.reason:j.review.reason;this.event(j,j.state,j.state==='ready'?'整理建议已准备好，等待你确认；原文未修改':j.state==='clear'?'仅主题相关，保留独立文档':j.reason);
 }
 async run(){
  if(!this.settings().enabled){this.state('paused');return;}
  if(this.maintenance?.job||this.consolidation?.job||this.isBusy?.()){this.state('waiting_maintenance');return;}
  const controller=new AbortController();this.active=controller;
  try{
   if(this.clock()>=this.settings().nextScan)await this.scan(controller.signal);
   const queue=this.jobs().reverse().filter(j=>j.state==='queued').slice(0,this.comparisonBatch);
   if(queue.length&&!this.consolidation?.config){this.state('waiting_agent');return;}
   for(let j of queue){controller.signal.throwIfAborted();try{await this.process(j,controller.signal);}catch(error){j=this.get(j.id);if(controller.signal.aborted){j.state='queued';this.event(j,'paused','已暂停，保留本次比较进度');throw error;}j.state=error.status===409?'obsolete':'error';j.reason=error.status||/^辅助模型/.test(error.message)?error.message:'整理比较未完成，可重试当前记录';this.event(j,j.state,j.reason);}}
   this.state('idle');
  }catch(error){if(controller.signal.aborted)this.state('paused');else this.state('error',error.status?error.message:'相关文档检查未完成，下轮将重试');}
  finally{this.active=null;}
 }
 async action({id,action,version,note=''}){
  if(this.job)throw failure('整理检查正在运行，请稍后处理',409);
  this.job=this.performAction({id,action,version,note}).finally(()=>{this.job=null;});return this.job;
 }
 async performAction({id,action,version,note}){
  const j=this.get(id);if(j.version!==version)throw failure('整理记录已更新，请刷新后处理',409);
  if(typeof note!=='string'||note.length>2000||sensitiveDocument(note))throw failure('处理说明无效');
  if(j.state==='obsolete')throw failure('旧版本建议已失效，请重新扫描',409);
  await this.current(j);
  if(action==='confirm'){if(j.state!=='ready'||!j.review?.passed)throw failure('此建议尚未通过复核');j.state='confirmed';this.event(j,'confirmed','用户确认此判断与整理方向；尚未合并、删除或迁移文档');}
  else if(action==='dismiss'){if(!['ready','review','error'].includes(j.state))throw failure('当前记录不能标记误报');if(note.trim().length<2)throw failure('请填写保留独立文档或标记误报的原因');j.state='dismissed';this.event(j,'dismissed','用户保留独立文档：'+note.trim());}
  else if(action==='reopen'){if(!['confirmed','dismissed'].includes(j.state))throw failure('当前记录没有可撤销的人工判断');j.state=j.review?.passed&&j.assessment?.kind!=='uncertain'?'ready':'review';this.event(j,'reopened','用户撤销上次确认，返回待处理');}
  else if(action==='retry'){if(!['error','review'].includes(j.state))throw failure('当前记录不需要重试');delete j.assessment;delete j.review;j.state='queued';this.event(j,'retry','已安排重新比较与复核');}
  else throw failure('不支持的整理操作');
  j.note=note.trim();this.save(j);return this.status();
 }
}
module.exports={KnowledgeGovernance};
