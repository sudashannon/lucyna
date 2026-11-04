// A default background job owned by the managed knowledge host, not an OMP session.
const fs=require('node:fs/promises'),path=require('node:path');
const {hash,inside}=require('./knowledge-library.cjs');
const {sensitiveDocument}=require('./work-knowledge-policy.cjs');
const {validate}=require('./auxiliary-settings.cjs');
const IDLE=60000,COOLDOWN=30*60000,MAX_FILE=120000;
const labels={idle:'等待新笔记或日志',stabilizing:'等待资料稳定',busy:'等待 Work 空闲',running:'正在提炼知识',publishing:'正在写入 L3',completed:'已沉淀到 L3',empty:'暂无可沉淀资料',paused:'知识沉淀已暂停',waiting_agent:'等待辅助模型',failed:'沉淀未完成',conflict:'L3 文档有人工修改',unregistered:'Work 已移出当前列表'};
function problem(message){return Object.assign(Error(message),{consolidationSafe:true});}
async function snapshot(directory){
 const root=await fs.realpath(directory),files=[],skipped=[];let seen=0;
 async function visit(relative,depth){
  const folder=path.join(root,relative);let entries;
  try{if((await fs.lstat(folder)).isSymbolicLink())return;entries=await fs.readdir(folder,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
   if(++seen>2000)throw problem('资料清单超过 2000 项，请整理 notes 后重试');
   const name=[relative,entry.name].filter(Boolean).join('/');
   if(entry.isSymbolicLink()||entry.name.startsWith('.'))continue;
   if(relative&&entry.isDirectory()){if(depth<5)await visit(name,depth+1);else skipped.push({path:name,reason:'目录超过 5 层'});continue;}
   if(!entry.isFile()||!(relative?/\.(md|markdown)$/i.test(name):/^SESSION-.+\.md$/.test(name)))continue;
   const file=path.join(root,...name.split('/')),real=await fs.realpath(file);
   if(!inside(root,real))throw problem('资料路径越出 Work，已停止读取');
   const handle=await fs.open(real,'r');let bytes;
   try{const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_FILE){skipped.push({path:name,reason:'超过 120 KB，请拆分笔记或日志'});continue;}
    bytes=Buffer.alloc(MAX_FILE+1);let size=0;for(;;){const r=await handle.read(bytes,size,bytes.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;if(size>MAX_FILE)break;}bytes=bytes.subarray(0,size);
   }finally{await handle.close();}
   if(bytes.length>MAX_FILE){skipped.push({path:name,reason:'读取期间资料超过上限'});continue;}
   let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{skipped.push({path:name,reason:'不是有效 UTF-8 文本'});continue;}
   if(sensitiveDocument(content)){skipped.push({path:name,reason:'含疑似凭据，请脱敏'});continue;}
   files.push({path:name,layer:relative?'L1':'L2',hash:hash(bytes),content});
  }
 }
 await visit('',0);await visit('notes',1);
 return {files,skipped,fingerprint:hash(JSON.stringify(files.map(f=>[f.path,f.hash])))};
}
function validateExtraction(output,source){
 if(!output||!Array.isArray(output.facts)||output.facts.length>12)throw problem('模型未返回有效的知识条目');
 const facts=output.facts.map(f=>{
  for(const [key,max] of [['title',120],['knowledge',5000],['appliesTo',1000],['quote',1600]])if(typeof f[key]!=='string'||!f[key].trim()||f[key].length>max)throw problem('知识条目缺少结论、适用范围或出处');
  if(!source.content.includes(f.quote)||f.quote.trim().length<8)throw problem('知识引用与原文不一致，未入库');
  if(sensitiveDocument(JSON.stringify(f)))throw problem('生成内容含疑似凭据，未入库');
  return {title:f.title.trim(),knowledge:f.knowledge.trim(),appliesTo:f.appliesTo.trim(),quote:f.quote};
 });
 return facts;
}
function render(root,sources){
 const grouped=new Map();
 for(const [relative,source] of Object.entries(sources).sort())for(const fact of source.facts||[]){
  const key=hash(JSON.stringify([fact.title,fact.knowledge,fact.appliesTo].map(s=>s.replace(/\s+/g,' ').trim())));
  if(!grouped.has(key))grouped.set(key,{...fact,evidence:[]});
   grouped.get(key).evidence.push({path:relative,layer:source.layer,hash:source.hash,at:source.at,quote:fact.quote});
 }
 const quote=text=>text.split('\n').map(line=>'> '+line).join('\n');
 return {count:grouped.size,content:`# ${path.posix.basename(root)} · 工作经验\n\n自动提炼自 Work 的 L1 笔记与 L2 日志；结论以所列原文为依据，未额外执行代码或设备验证。来源删除或暂不可读时保留历史结论，请按来源版本和适用范围使用。\n\nWork：\`${root}\`\n\n`+[...grouped.values()].map(f=>`## ${f.title.replace(/[\r\n]/g,' ')}\n\n${f.knowledge}\n\n适用范围：${f.appliesTo}\n\n`+f.evidence.map(e=>`来源：${e.layer} · \`${e.path}\` · 提炼于 ${new Date(e.at).toISOString()} · SHA-256 \`${e.hash}\`\n\n${quote(e.quote)}`).join('\n\n')).join('\n\n')};
}
class KnowledgeConsolidation{
 constructor({store,agent,register,clock=Date.now,read=snapshot,idleMs=IDLE,cooldownMs=COOLDOWN}){
  Object.assign(this,{store,agent,register,clock,read,idleMs,cooldownMs});this.config=null;this.active=null;this.stopped=false;
  store.db.exec('CREATE TABLE IF NOT EXISTS knowledge_consolidation(root TEXT PRIMARY KEY,data TEXT NOT NULL)');
  for(const p of this.all())if(['running','publishing'].includes(p.status)){p.status='idle';p.message='服务已恢复，将核对上次入库结果';this.save(p);}
 }
 all(){return this.store.db.prepare('SELECT data FROM knowledge_consolidation ORDER BY root').all().map(r=>JSON.parse(r.data));}
 get(root){const row=this.store.db.prepare('SELECT data FROM knowledge_consolidation WHERE root=?').get(root);if(!row)throw problem('请选择已登记的 Work');return JSON.parse(row.data);}
 save(p){this.store.db.prepare('INSERT INTO knowledge_consolidation VALUES(?,?) ON CONFLICT(root) DO UPDATE SET data=excluded.data').run(p.root,JSON.stringify(p));}
 status(p,status,message){p.status=status;p.message=message||labels[status];p.updatedAt=this.clock();this.save(p);}
 view(root){const p=this.get(root);return {root,enabled:p.enabled,registered:p.registered,status:p.status,label:labels[p.status],message:p.message,idleSeconds:this.idleMs/1000,cooldownSeconds:this.cooldownMs/1000,updatedAt:p.updatedAt,lastRunAt:p.lastRunAt,nextAt:(p.lastRunAt||0)+this.cooldownMs,usedTokens:p.usedTokens||0,document:p.document||null,sourceCount:Object.keys(p.sources).length,factCount:p.factCount||0,skipped:p.skipped||[],history:p.history||[],currentSource:p.currentSource||''};}
 sync({works,auxiliary}){
  if(!Array.isArray(works)||works.length>1000)throw problem('Work 清单无效');
  const config=auxiliary?{...validate(auxiliary),apiKey:auxiliary.apiKey||''}:null;
  for(const w of works)if(typeof w.root!=='string'||!w.root.startsWith('/')||/[\0\r\n]/.test(w.root)||!path.isAbsolute(w.directory))throw problem('Work 资料位置无效');
  this.config=config?.baseURL&&config?.model?config:null;
  const roots=new Set(works.map(w=>w.root));
  for(const p of this.all())if(!roots.has(p.root)){p.registered=false;this.status(p,'unregistered');if(this.active?.root===p.root)this.active.controller.abort();}
  for(const w of works){let p;try{p=this.get(w.root);}catch{p={root:w.root,enabled:true,sources:{},history:[],status:'idle',stableSince:this.clock()};}
   if(p.directory&&p.directory!==w.directory)throw problem('Work 来源位置改变，请核对后台登记');
   p.directory=w.directory;p.registered=true;p.busy=!!w.busy;p.lastSeen=this.clock();
   if(w.busy){p.stableSince=this.clock();if(this.active?.root===w.root)this.active.controller.abort();}
   this.save(p);
  }
  return {registered:works.length};
 }
 configure(root,{enabled,retry=false}){
  const p=this.get(root);if(enabled!==undefined&&typeof enabled!=='boolean')throw problem('开关格式无效');
  if(enabled!==undefined)p.enabled=enabled;
  if(retry){p.lastRunAt=0;p.failed={};p.stableSince=this.clock();}
  this.status(p,p.enabled?'idle':'paused');
  if(!p.enabled&&this.active?.root===root)this.active.controller.abort();
  return this.view(root);
 }
 start(){this.timer=setInterval(()=>void this.tick().catch(()=>{}),10000);this.timer.unref();}
 keepAlive(){return !!this.active||this.all().some(p=>p.enabled&&p.registered);}
 async stop(){this.stopped=true;clearInterval(this.timer);this.active?.controller.abort();await this.job?.catch(()=>{});this.config=null;}
 async tick(){if(this.stopped||this.job)return;this.job=this.advance().finally(()=>{this.job=null;});return this.job;}
 eligible(p){return p.enabled&&p.registered&&!(p.busy&&this.clock()-p.lastSeen<90000);}
 async publish(p){
  const pending=p.pending;if(!pending)return;
  this.status(p,'publishing');
  const saved=await this.store.write({...pending.write,origin:'automatic-consolidation'});
  // Retain the outbox until indexing also succeeds. Retrying uses identical bytes/op ID.
  await this.register(saved.library);
  if(this.store.doc(saved.id)?.revision!==saved.revision)throw Object.assign(problem('L3 文档在入库期间被修改，已保留最新人工版本'),{status:412});
  p=this.get(p.root);p.sources=pending.sources;p.document={id:saved.id,revision:saved.revision,library:saved.library};p.factCount=pending.count;delete p.pending;
  p.history=[{at:this.clock(),state:'completed',message:`已沉淀 ${p.factCount} 条知识，来源 ${Object.keys(p.sources).length} 份`,document:saved.id},...(p.history||[])].slice(0,20);
  this.status(p,p.enabled?'completed':'paused');
 }
 async advance(){
  if(this.maintenanceBusy?.())return;
  for(let p of this.all().sort((a,b)=>(a.lastRunAt||0)-(b.lastRunAt||0))){
   if(!p.enabled||!p.registered)continue;
   if(!this.eligible(p)){this.status(p,'busy');continue;}
   if(this.clock()-(p.lastRunAt||0)<this.cooldownMs)continue;
   try{
    if(p.pending){p.lastRunAt=this.clock();this.save(p);await this.publish(p);return;}
    const snap=await this.read(p.directory);p=this.get(p.root);if(!this.eligible(p))continue;p.skipped=snap.skipped;
    if(snap.fingerprint!==p.observed){p.observed=snap.fingerprint;p.stableSince=this.clock();this.status(p,'stabilizing');continue;}
    if(this.clock()-p.stableSince<this.idleMs){this.save(p);continue;}
    const changed=snap.files.filter(f=>p.sources[f.path]?.hash!==f.hash&&p.failed?.[f.path]!==f.hash);
    if(!changed.length){this.status(p,p.skipped.length||Object.keys(p.failed||{}).length?'failed':p.document?'completed':snap.files.length?'idle':'empty',p.skipped.length?'部分资料未处理，请查看跳过原因':Object.keys(p.failed||{}).length?'部分资料提炼失败；可重试，或修改原文后自动再处理':undefined);continue;}
    if(!this.config){this.status(p,'waiting_agent','在设置中配置辅助模型后自动继续；无需 OMP 会话');continue;}
    const controller=new AbortController();this.active={root:p.root,controller};p.lastRunAt=this.clock();this.save(p);
    try{
     for(const source of changed.slice(0,3)){
      p=this.get(p.root);if(!this.eligible(p)||controller.signal.aborted)break;
      p.currentSource=source.path;p.currentHash=source.hash;this.status(p,'running');
      const prior=Object.values(p.sources).flatMap(s=>s.facts||[]).map(({title,knowledge,appliesTo})=>({title,knowledge,appliesTo}));
      const result=await this.agent.consolidateKnowledge(this.config,{root:p.root,source,existing:prior.slice(0,40)},controller.signal);
      p=this.get(p.root);p.usedTokens=(p.usedTokens||0)+(result.usedTokens||0);this.save(p);
      const facts=validateExtraction(result,source);
      const current=await this.read(p.directory);
      if(controller.signal.aborted||!this.eligible(this.get(p.root)))break;
      if(current.files.find(f=>f.path===source.path)?.hash!==source.hash){this.status(p,'stabilizing','提炼期间原文已变化，等待稳定后重试');break;}
      if(p.failed)delete p.failed[source.path];
      const sources={...p.sources,[source.path]:{hash:source.hash,layer:source.layer,facts,at:this.clock()}},document=render(p.root,sources);
      if(!document.count&&!p.document){p.sources=sources;this.status(p,'idle','已检查资料，未发现可复用结论');continue;}
      let lib=this.store.isUnified()?this.store.list()[0]:this.store.list().find(l=>l.alias==='work-l3');if(!lib)lib=this.store.create('Work 经验 · L3','work-l3');
      const relative=(this.store.isUnified()?'知识/':'')+'work/'+hash(p.root)+'.md';
      p.pending={sources,count:document.count,write:{library:lib.id,...(p.document?{document:p.document.id}:{relative}),content:document.content,expected:p.document?.revision||'new',operationId:'consolidation-'+hash(p.root+'\0'+source.hash+'\0'+document.content+'\0'+(p.document?.revision||'new')),provenance:{kind:'work-consolidation',root:p.root}}};
      this.save(p);await this.publish(p);
     }
    }finally{this.active=null;}
    return;
   }catch(error){
    p=this.get(p.root);p.lastRunAt=this.clock();
    if(!p.enabled||!p.registered||!this.eligible(p)){this.status(p,!p.enabled?'paused':!p.registered?'unregistered':'busy');continue;}
    if(!p.pending&&p.status==='running'&&p.currentSource&&p.currentHash){p.failed={...p.failed,[p.currentSource]:p.currentHash};}
    const message=error.consolidationSafe||/^辅助模型|请先填写辅助模型/.test(error.message)?error.message:error.status===412||error.status===409?'L3 文档已被修改，自动任务保留原文；请在知识库核对':'资料读取或入库失败，保留已有知识；可稍后重试';
    p.history=[{at:this.clock(),state:'failed',message},...(p.history||[])].slice(0,20);this.status(p,[409,412].includes(error.status)?'conflict':'failed',message);
   }
  }
 }
}
module.exports={KnowledgeConsolidation,snapshot,validateExtraction,render};
