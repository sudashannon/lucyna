const path=require('node:path'),{randomUUID}=require('node:crypto');
const {hash,failure}=require('./knowledge-library.cjs');
const {inventory,readRevision,links}=require('./knowledge-maintenance-sources.cjs');
const {sensitiveDocument}=require('./work-knowledge-policy.cjs');
const DONE=new Set(['completed','confirmed','obsolete','dismissed','rolled_back']);
const labels={idle:'等待来源变化',scanning:'检查来源与引用',waiting_agent:'等待辅助模型',analyzing:'核对受影响知识',verifying:'独立复核修改',applying:'保存新修订',indexing:'验证索引与检索',paused:'维护已暂停',error:'维护未完成'};
const fingerprint=(doc,sources)=>hash(JSON.stringify([doc.revision,sources.map(s=>[s.key,s.revision,s.blocked||false]) ]));
function validatePlan(plan,input){
 if(!plan||!['revise','valid','review'].includes(plan.decision)||typeof plan.reason!=='string'||!plan.reason.trim()||plan.reason.length>2000||!Array.isArray(plan.patches)||plan.patches.length>8)throw failure('维护建议格式无效，未修改原文');
 let after=input.document.content;const ranges=[];
 if(plan.decision!=='revise'&&plan.patches.length)throw failure('非修订建议不能携带修改');
 if(plan.decision==='revise'&&!plan.patches.length)throw failure('修订建议缺少修改');
 const evidence=[];
 for(const patch of plan.patches){
  if(typeof patch.before!=='string'||patch.before.trim().length<8||patch.before.length>6000||typeof patch.after!=='string'||!patch.after.trim()||patch.after.length>8000||patch.before===patch.after||!Array.isArray(patch.evidence)||!patch.evidence.length)throw failure('维护修改范围无效');
  const start=input.document.content.indexOf(patch.before);
  if(start<0||input.document.content.indexOf(patch.before,start+1)>=0)throw failure('待修改原文不存在或不唯一');
  const end=start+patch.before.length;if(ranges.some(r=>start<r.end&&end>r.start))throw failure('维护修改范围重叠');ranges.push({start,end,after:patch.after});
  for(const ref of patch.evidence){const s=input.sources.find(s=>s.key===ref.source);if(!s||s.missing||s.blocked||typeof ref.quote!=='string'||ref.quote.trim().length<8||ref.quote.length>2000||!s.content.includes(ref.quote))throw failure('维护引用无法在当前来源中核对');evidence.push({source:s.key,label:s.label,revision:s.revision,quote:ref.quote});}
 }
 for(const r of ranges.sort((a,b)=>b.start-a.start))after=after.slice(0,r.start)+r.after+after.slice(r.end);
 if(sensitiveDocument(after))throw failure('维护结果含疑似凭据，未写入');
 return {decision:plan.decision,reason:plan.reason,patches:plan.patches,after,evidence};
}
class KnowledgeMaintenance{
 constructor({store,agent,consolidation,register,verify,clock=Date.now,idleMs=60000,intervalMs=300000}){
  Object.assign(this,{store,agent,consolidation,register,verify,clock,idleMs,intervalMs});this.active=null;this.job=null;this.stopped=false;
  store.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_maintenance_settings(id INTEGER PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS knowledge_maintenance_documents(document TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS knowledge_maintenance_jobs(id TEXT PRIMARY KEY,document TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(document,fingerprint));`);
  if(!store.db.prepare('SELECT 1 FROM knowledge_maintenance_settings').get())this.settings({enabled:true,status:'idle',autoApply:true,lastScan:0,usedTokens:0});
  for(const j of this.jobs())if(['analyzing','verifying','applying','indexing'].includes(j.state)){j.state=j.write?'indexing':'queued';this.event(j,'recovered','服务恢复，重新核对来源和持久写入');}
 }
 settings(value){if(value)this.store.db.prepare('INSERT INTO knowledge_maintenance_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(value));return JSON.parse(this.store.db.prepare('SELECT data FROM knowledge_maintenance_settings WHERE id=1').get().data);}
 state(status,message){this.settings({...this.settings(),status,message:message||labels[status],updatedAt:this.clock()});}
 jobs(){return this.store.db.prepare('SELECT data FROM knowledge_maintenance_jobs ORDER BY rowid DESC').all().map(r=>JSON.parse(r.data));}
 get(id){const r=this.store.db.prepare('SELECT data FROM knowledge_maintenance_jobs WHERE id=?').get(id);if(!r)throw failure('维护记录不存在',404);return JSON.parse(r.data);}
 save(j){j.updatedAt=this.clock();this.store.db.prepare('INSERT INTO knowledge_maintenance_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(j.id,j.document,j.fingerprint,JSON.stringify(j));}
 event(j,phase,message){j.events=[...(j.events||[]),{at:this.clock(),phase,message}].slice(-40);this.save(j);}
 tracked(id){const r=this.store.db.prepare('SELECT data FROM knowledge_maintenance_documents WHERE document=?').get(id);return r?JSON.parse(r.data):null;}
 track(id,value){this.store.db.prepare('INSERT INTO knowledge_maintenance_documents VALUES(?,?) ON CONFLICT(document) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(value));}
 acknowledge(j){this.track(j.document,{revision:this.store.doc(j.document)?.revision,refs:Object.fromEntries(j.input.sources.map(s=>[s.key,s.revision])),verifiedAt:this.clock()});}
 latest(){const seen=new Set();return this.jobs().filter(j=>{if(seen.has(j.document)||j.state==='obsolete')return false;seen.add(j.document);return true;});}
 blocked(){return new Set([...this.latest().filter(j=>!['completed','confirmed'].includes(j.state)).map(j=>j.document),...(this.settings().warnings||[]).map(w=>w.document)]);}
 freshness(identity){if(!identity)return null;const d=this.store.doc(identity);if(!d)return null;const warning=this.settings().warnings?.find(w=>w.document===d.id);if(warning)return {state:'needs_review',message:warning.reason};const job=this.latest().find(j=>j.document===d.id&&!['completed','confirmed'].includes(j.state));return job?{state:'needs_review',job:job.id,message:job.reason||'来源已变化，此文档尚未完成维护验证'}:null;}
 status(){const all=this.jobs(),s=this.settings();return {...s,lastScan:s.scannedAt||s.lastScan,label:labels[s.status],running:!!this.active||!!this.job,model:this.consolidation?.config?.model||'',counts:{pending:all.filter(j=>['queued','analyzing','verifying','indexing','waiting_source'].includes(j.state)).length,review:all.filter(j=>['review','conflict','error','dismissed','rolled_back'].includes(j.state)).length,completed:all.filter(j=>['completed','confirmed'].includes(j.state)).length},jobs:all.slice(0,100).map(({input,plan,write,...j})=>({...j,hasChanges:!!plan?.patches?.length,canApply:j.state==='review'&&!!j.verdict?.supported&&!!j.verdict?.scopeUnchanged&&!!j.verdict?.complete&&!!plan?.patches?.length,canRollback:j.state==='completed'&&!!j.resultRevision&&!!write&&!write.external,checks:j.checks})),coverage:s.coverage||{documents:0,tracked:0,untracked:0}};}
 configure(input){if(Object.keys(input).some(k=>!['enabled','autoApply','scan'].includes(k)))throw failure('无效维护设置');const s=this.settings();for(const k of ['enabled','autoApply'])if(input[k]!==undefined){if(typeof input[k]!=='boolean')throw failure('维护设置必须为开关');s[k]=input[k];}if(input.scan)s.lastScan=0;this.settings(s);if(!s.enabled)this.active?.abort();this.state(s.enabled?'idle':'paused');return this.status();}
 start(){this.timer=setInterval(()=>void this.tick().catch(()=>{}),15000);this.timer.unref();}
 async stop(){this.stopped=true;clearInterval(this.timer);this.active?.abort();await this.job?.catch(()=>{});}
 async tick(){if(this.stopped||this.job)return;this.job=this.run().finally(()=>{this.job=null;});return this.job;}
 async scan(){
  this.state('scanning');const view=await inventory(this.store,this.consolidation),latest=new Map(this.latest().map(j=>[j.document,j])),blocked=new Set([...latest.values()].filter(j=>!['completed','confirmed'].includes(j.state)).map(j=>j.document));let tracked=0;
  for(const warning of view.warnings)blocked.add(warning.document);
  // Traverse reverse references once; long dependency chains are not truncated.
  const dependents=new Map();
  for(const [id,refs] of view.references){const old=this.tracked(id);for(const s of refs){if(s.document){if(!dependents.has(s.document))dependents.set(s.document,[]);dependents.get(s.document).push(id);}if(s.missing||s.canonical||s.baseline&&s.baseline!==s.revision||old?.refs[s.key]&&old.refs[s.key]!==s.revision)blocked.add(id);}}
  const queue=[...blocked];for(let i=0;i<queue.length;i++)for(const id of dependents.get(queue[i])||[])if(!blocked.has(id)){blocked.add(id);queue.push(id);}
   for(const d of view.docs.values()){
    if(!d.readable)continue;const refs=(view.references.get(d.id)||[]).map(s=>({...s,blocked:s.document?blocked.has(s.document):false})),old=this.tracked(d.id);
    const issues=refs.filter(s=>s.missing||s.blocked||s.canonical||s.baseline&&s.baseline!==s.revision||old?.refs[s.key]&&old.refs[s.key]!==s.revision);
    const previous=latest.get(d.id),prior=previous&&!['completed','confirmed'].includes(previous.state)?previous:null;
    if(prior?.state==='rolled_back'&&prior.rollbackRevision===d.revision&&refs.length===prior.input.sources.length&&refs.every(s=>!s.missing&&prior.input.sources.some(p=>p.key===s.key&&p.revision===s.revision&&!!p.blocked===!!s.blocked)))continue;
    // A saved outbox write changes the target revision itself. Resume indexing,
    // rather than interpreting that known revision as a new human edit.
    if(prior?.write&&prior.resultRevision===d.revision&&refs.length===prior.input.sources.length&&refs.every(s=>!s.missing&&prior.input.sources.some(p=>p.key===s.key&&p.revision===s.revision&&!!p.blocked===!!s.blocked)))continue;
    if(prior?.state==='waiting_source'&&prior.input.document.revision!==d.revision&&refs.every(s=>!s.missing&&!s.blocked&&(!s.baseline||s.baseline===s.revision))&&this.consolidation.all().some(p=>p.root===d.provenance?.root&&p.document?.revision===d.revision)){prior.state='indexing';prior.write={external:true};prior.resultRevision=d.revision;prior.plan={reason:'Work 来源已重新沉淀',patches:[{before:prior.input.document.content,after:d.content}],after:d.content};prior.input.sources=refs;this.event(prior,'source_refreshed','L3 已重新沉淀，等待检索验证');continue;}
    if(!issues.length&&!prior){if(!old||old.revision!==d.revision)this.track(d.id,{revision:d.revision,refs:Object.fromEntries(refs.map(s=>[s.key,s.revision]))});continue;}
    if(!issues.length&&(!prior||fingerprint(d,refs)===prior.fingerprint))continue;
    blocked.add(d.id);
    const fp=fingerprint(d,refs);if(this.store.db.prepare('SELECT 1 FROM knowledge_maintenance_jobs WHERE document=? AND fingerprint=?').get(d.id,fp))continue;
    if(prior){prior.state='obsolete';this.event(prior,'obsolete','来源或目标出现新版本，旧建议已失效；已保存修订保留在历史');}
    const inputs=refs.map(s=>({...s,previousRevision:old?.refs[s.key]||s.baseline,previousContent:s.document&&old?.refs[s.key]?readRevision(this.store,s.document,old.refs[s.key]):s.quote||''}));
    const manualConflict=!!prior&&(prior.state==='rolled_back'||prior.input.document.revision!==d.revision&&['ui','mcp','stele','maintenance-rollback'].includes(this.store.db.prepare('SELECT origin FROM revisions WHERE id=?').get(d.revision)?.origin));
    const j={id:randomUUID(),document:d.id,title:d.title,path:d.path,workspace:d.workspace,fingerprint:fp,state:'queued',manualConflict,createdAt:this.clock(),reason:issues.some(s=>s.missing)?'来源缺失或暂不可读':issues.some(s=>s.blocked)?'上游知识尚待核实':'来源版本已变化',input:{document:{id:d.id,revision:d.revision,title:d.title,relative:d.relative,content:d.content,provenance:d.provenance},sources:inputs},events:[]};
    if(Buffer.byteLength(JSON.stringify(j.input))>600000){j.state='review';j.reason='关联资料超过本轮读取范围，需缩小范围后核实';j.input.sources=j.input.sources.map(({content,previousContent,...s})=>({...s,content:'',previousContent:''}));}
    this.event(j,'detected',j.reason);
   }
  for(const [id,refs] of view.references)if(refs.length)tracked++;
  this.settings({...this.settings(),lastScan:this.clock(),scannedAt:this.clock(),coverage:{documents:view.docs.size,tracked,untracked:view.docs.size-tracked},warnings:view.warnings});return view;
 }
 async current(j){const view=await inventory(this.store,this.consolidation),doc=view.docs.get(j.document);if(!doc)throw failure('目标文档已不存在',409);const blocked=this.blocked();blocked.delete(j.document);const refs=(view.references.get(j.document)||[]).map(s=>({...s,blocked:s.document?blocked.has(s.document):false}));if(fingerprint(doc,refs)!==j.fingerprint)throw failure('来源或目标已变化，请重新检查',409);return {doc,refs};}
 async process(j,signal){
  await this.current(j);
  if(j.input.sources.some(s=>s.missing||s.blocked)){j.state='review';this.event(j,'review',j.reason+'；未修改原文');return;}
  if(j.input.sources.some(s=>s.canonical)&&j.input.sources.every(s=>!s.previousRevision||s.previousRevision===s.revision)){
   const {rewriteLinks}=require('./knowledge-layout-links.cjs'),file=j.path.replaceAll('\\','/');
   const mapping=new Map(j.input.sources.filter(s=>s.url&&s.path).map(s=>[path.resolve(path.dirname(j.path),decodeURIComponent(s.url.split(/[?#]/)[0])).replaceAll('\\','/'),s.path.replaceAll('\\','/')]));
   const fixed=await rewriteLinks(j.input.document.content,{old:file,next:file},mapping);
   if(fixed.rewritten){j.plan={decision:'revise',reason:'依据稳定文档身份修复迁移前引用',patches:[{before:j.input.document.content,after:fixed.content,evidence:[]}],after:fixed.content,evidence:[]};j.verdict={supported:true,scopeUnchanged:true,complete:true,reason:'只重写已登记路径映射，正文保持不变'};if(this.settings().autoApply){await this.apply(j,signal);return;}j.state='review';this.event(j,'review','引用修复已准备好，等待采纳');return;}
  }
  if(j.input.document.provenance?.kind==='work-consolidation'){
   const p=this.consolidation.all().find(p=>p.root===j.input.document.provenance.root);
   if(p?.enabled&&p.registered){p.lastRunAt=0;p.observed=null;this.consolidation.save(p);j.state='waiting_source';this.event(j,'waiting_source','等待内嵌 agent 重新沉淀 Work 来源，保留原有贡献归属');}
   else{j.state='review';this.event(j,'review','此 Work 的沉淀已暂停或来源未登记');}return;
  }
  if(!this.consolidation?.config){this.state('waiting_agent','在设置中配置辅助模型后继续；不创建 OMP 会话');return;}
  j.state='analyzing';this.event(j,'analyzing','内嵌 agent 对照新旧来源核对结论');this.state('analyzing');
  const proposed=await this.agent.maintainKnowledge(this.consolidation.config,j.input,signal);this.charge(proposed.usedTokens);
  signal.throwIfAborted();j.plan=validatePlan(proposed,j.input);
  if(JSON.stringify((await links(j.plan.after)).sort())!==JSON.stringify((await links(j.input.document.content)).sort()))throw failure('模型建议改变了引用关系，请人工核对');
  this.save(j);
  if(j.plan.decision==='review'){j.state='review';j.reason=j.plan.reason;this.event(j,'review',j.reason);return;}
  j.state='verifying';this.event(j,'verifying','独立请求复核证据、适用范围和修改范围');this.state('verifying');
  j.verdict=await this.agent.verifyKnowledgeMaintenance(this.consolidation.config,{...j.input,proposal:j.plan},signal);this.charge(j.verdict.usedTokens);signal.throwIfAborted();
  if(j.verdict.supported!==true||j.verdict.scopeUnchanged!==true||j.verdict.complete!==true){j.state='review';j.reason=j.verdict.reason||'独立复核未通过';this.event(j,'review',j.reason);return;}
  await this.current(j);
  if(j.plan.decision==='valid'){j.state='indexing';j.write={external:true};j.resultRevision=j.input.document.revision;this.event(j,'indexing','来源变化但结论仍适用，正在验证检索');await this.finish(j);return;}
  const protectedType=/(?:^|\/)(规范|计划|提案|任务|设计|specs?|plans?|proposals?|tasks?|designs?)(?:\/|$)/i.test(j.input.document.relative)||/^type:\s*["']?(?:规范|计划|提案|任务|设计|spec|plan|proposal|tasks?|design)["']?\s*$/im.test(j.input.document.content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]||'');
  if(!this.settings().autoApply||protectedType||j.manualConflict){j.state='review';j.reason=j.manualConflict?'文档有新的人工修改，请核对后采纳':protectedType?'涉及规范、计划或设计，请核对修改后采纳':'自动修订已关闭，请核对后采纳';this.event(j,'review',j.reason);return;}
  await this.apply(j,signal);
 }
 charge(tokens){if(Number.isSafeInteger(tokens)&&tokens>=0)this.settings({...this.settings(),usedTokens:this.settings().usedTokens+tokens});}
 async apply(j,signal){
  await this.current(j);signal?.throwIfAborted();
  j.write={document:j.document,content:j.plan.after,expected:j.input.document.revision,operationId:'maintenance-'+j.id};j.state='applying';this.state('applying');this.event(j,'applying','证据与独立复核通过，保存局部修订');
  const saved=await this.store.write({...j.write,origin:'automatic-maintenance'});j.resultRevision=saved.revision;j.state='indexing';this.event(j,'indexing','修订已保存，等待索引与检索检查');await this.finish(j);
 }
 async finish(j){
  this.state('indexing');
  const before=await inventory(this.store,this.consolidation),sources=before.references.get(j.document)||[],blocked=this.blocked();
  if(sources.length!==j.input.sources.length||sources.some(s=>s.missing||blocked.has(s.document)||j.input.sources.find(r=>r.key===s.key)?.revision!==s.revision))throw failure('发布前来源已变化，需重新检查',409);
  if(j.write&&!j.write.external){const saved=await this.store.write({...j.write,origin:'automatic-maintenance'});j.resultRevision=saved.revision;}
  if(this.store.doc(j.document)?.revision!==j.resultRevision)throw failure('入库后文档又被修改，保留最新版本',409);
  await this.register(this.store.doc(j.document).library);const current=this.store.read(j.document);
  j.checks=await this.verify(current,j.plan?.patches?.map(p=>p.after)||[]);
  this.save(j);
  if(!j.checks?.passed)throw failure('修订已保存，但检索验证尚未通过；可重试验证',503);
  if(this.store.doc(j.document)?.revision!==j.resultRevision)throw failure('验证期间文档已变化',409);
  // Source changes during indexing keep the saved revision but require another review.
  const view=await inventory(this.store,this.consolidation),refs=view.references.get(j.document)||[];
  if(refs.length!==j.input.sources.length||refs.some(s=>s.missing||this.blocked().has(s.document)||j.input.sources.find(r=>r.key===s.key)?.revision!==s.revision))throw failure('入库期间来源又有变化，需重新检查',409);
  j.state='completed';j.reason=j.plan?.reason||'来源已刷新，检索验证通过';this.acknowledge(j);this.event(j,'completed',j.reason);this.settings({...this.settings(),lastScan:0});
 }
 async action(id,action){
  if(this.active||this.job)throw failure('维护正在运行，请稍后处理记录',409);
  const controller=new AbortController();this.active=controller;
  this.job=this.performAction(id,action,controller.signal).catch(error=>{if(action==='apply'){const j=this.get(id);if(j.state!=='completed'){j.state=[409,412].includes(error.status)?'conflict':'error';j.reason=error.status?error.message:'修订未完成，请重试检查';this.event(j,j.state,j.reason);}}throw error;}).finally(()=>{this.active=null;this.job=null;this.state(this.settings().enabled?'idle':'paused');});return this.job;
 }
 async performAction(id,action,signal){
  const j=this.get(id);
  if(['obsolete','rolled_back','dismissed'].includes(j.state)&&action!=='confirm')throw failure('此记录已结束，请重新检查当前版本',409);
  if(action==='retry'){if(j.write)j.state='indexing';else{await this.current(j);j.state='queued';j.createdAt=this.clock()-this.idleMs;}this.event(j,'retry','已安排重试');this.settings({...this.settings(),lastScan:0});return this.status();}
  if(action==='apply'){if(j.state!=='review'||!j.plan?.patches?.length||!j.verdict?.supported||!j.verdict?.scopeUnchanged||!j.verdict?.complete)throw failure('此记录没有通过复核的修订');await this.apply(j,signal);}
  else if(action==='confirm'){await this.current(j);j.state='confirmed';this.acknowledge(j);this.event(j,'confirmed','用户确认当前原文仍适用');}
  else if(action==='dismiss'){if(DONE.has(j.state))throw failure('此记录已结束');j.state='dismissed';this.event(j,'dismissed','已暂缓处理；检索仍提示待核实');}
  else if(action==='rollback'){
   if(j.state!=='completed'||!j.write||j.write.external)throw failure('此记录没有可回退的自动修改');
   const saved=await this.store.write({document:j.document,content:j.input.document.content,expected:j.resultRevision,operationId:'maintenance-rollback-'+j.id,origin:'maintenance-rollback'});
   j.state='rolled_back';j.rollbackRevision=saved.revision;this.event(j,'rolled_back','已保存回退修订，历史保留；旧结论仍需核实');await this.register(saved.library);
  }else throw failure('不支持的维护操作');return this.status();
 }
 async run(){
  if(this.governanceBusy?.())return;
  if(!this.settings().enabled){this.state('paused');return;}
  try{
   // Recover durable publication before scanning the revision it created.
   for(let j of this.jobs().filter(j=>j.state==='indexing'&&j.write)){
    if(!this.settings().enabled)return;
    try{await this.finish(j);}catch(error){j=this.get(j.id);j.state=[409,412].includes(error.status)?'conflict':'error';j.reason=error.status?error.message:'检索验证未完成，请重试';this.event(j,j.state,j.reason);}
   }
   if(this.clock()-this.settings().lastScan>=this.intervalMs||!this.settings().lastScan)await this.scan();
   if(this.consolidation?.active||this.consolidation?.job){this.state('idle','等待本轮知识沉淀完成');return;}
   const jobs=this.jobs().reverse().filter(j=>['queued','indexing'].includes(j.state)&&this.clock()-j.createdAt>=this.idleMs).slice(0,3);
   for(let j of jobs){if(!this.settings().enabled)break;const controller=new AbortController();this.active=controller;
    try{if(j.write)await this.finish(j);else await this.process(j,controller.signal);}
    catch(error){j=this.get(j.id);if(controller.signal.aborted){j.state=j.write?'indexing':'queued';this.event(j,'paused','维护已暂停，原文及已保存修订保留');break;}j.state=[409,412].includes(error.status)?'conflict':'error';j.reason=error.status||/^辅助模型/.test(error.message)?error.message:'维护未完成，请查看来源后重试';this.event(j,j.state,j.reason);}
    finally{this.active=null;}
   }
   if(this.settings().status!=='waiting_agent')this.state(this.settings().enabled?'idle':'paused');
  }catch(error){this.state('error',error.status?error.message:'知识巡检未完成，已有内容保留，请重试');}
 }
}
module.exports={KnowledgeMaintenance,validatePlan,fingerprint};
