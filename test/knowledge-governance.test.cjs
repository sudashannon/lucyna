const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {KnowledgeLibrary}=require('../src/knowledge-library.cjs'),{KnowledgeGovernance}=require('../src/knowledge-governance.cjs');
const {validateAssessment,groups}=require('../src/knowledge-governance-policy.cjs');
const scope='适用范围：RX101 固件 v2，实验室 USB 直连环境。';
const quote='ADB 连接失败时，结束占用 5037 端口的旧进程，再启动 adb server。';
function assessment(documents,kind='duplicate',relation=kind==='scoped'?'different':'same'){
 return {kind,title:'ADB 端口占用处理',reason:'两篇文档描述同一范围内的相同处理方法',scope:{relation,explanation:'对照两侧明确的固件和环境说明'},evidence:documents.map(d=>({document:d.id,quote:d.content.split('\n\n')[2],claim:'先停止占用端口的旧进程',scopeQuote:d.content.split('\n\n')[1]})),recommendation:{action:{duplicate:'merge',conflict:'investigate',scoped:'keep_separate',related:'none',uncertain:'investigate'}[kind],summary:'建议保留两份来源并整理公共步骤',steps:['核对原始操作记录后再决定是否合并'],preserve:['保留固件版本、USB 条件及各文档的特有说明']}};
}
const accepted=()=>({evidenceSound:true,scopeSound:true,classificationSound:true,proposalSound:true,reason:'引用和范围可核对，建议仅提出整理方向',usedTokens:90});
async function fixture(t,{idleMs=0,discoveryBatch=8,comparisonBatch=3}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-governance-')),store=new KnowledgeLibrary(directory),library=store.list()[0].id;
 const a=await store.write({library,relative:'knowledge/adb-a.md',content:'# ADB 连接排查\n\n'+scope+'\n\n'+quote+'\n\n特有记录：使用原装数据线。',expected:'new'}),b=await store.write({library,relative:'knowledge/adb-b.md',content:'# ADB 排查经验\n\n'+scope+'\n\n'+quote+'\n\n特有记录：保留终端输出。',expected:'new'});
 let now=10000000,calls=0,verifications=0,searches=0;const blocked=new Set(),consolidation={config:{model:'fixture'},all:()=>[]},agent={assessKnowledge:async(c,input)=>{calls++;return {...assessment(input.documents),usedTokens:120};},verifyKnowledgeAssessment:async()=>{verifications++;return accepted();}};
 const governance=new KnowledgeGovernance({store,agent,consolidation,maintenance:{blocked:()=>blocked},search:async()=>{searches++;return store.db.prepare('SELECT id FROM documents').all();},clock:()=>now,idleMs,intervalMs:0,discoveryBatch,comparisonBatch});
 const tick=async(delta=1000)=>{now+=delta;await governance.tick();};t.after(async()=>{await governance.stop();store.close();});
 return {store,governance,agent,consolidation,a,b,blocked,tick,advance:n=>now+=n,calls:()=>calls,verifications:()=>verifications,searches:()=>searches,library};
}

test('automatic discovery produces a versioned, cited, independently reviewed proposal without changing documents',async t=>{
 const f=await fixture(t);await f.tick();const j=f.governance.jobs()[0];assert.equal(j.state,'ready');assert.equal(j.assessment.kind,'duplicate');assert.equal(j.review.passed,true);assert.equal(j.assessment.evidence.length,2);assert.ok(j.assessment.evidence.every(e=>e.lineStart===5));assert.equal(f.calls(),1);assert.equal(f.verifications(),1);assert.equal(f.store.history(f.a.id).length,1);assert.equal(f.store.history(f.b.id).length,1);assert.equal(f.governance.settings().usedTokens,210);await f.tick();assert.equal(f.calls(),1);assert.equal(f.searches(),2);assert.equal(f.governance.status().groups.length,1);
});
test('human confirmation, false-positive reason and reopening are version checked and never edit documents',async t=>{
 const f=await fixture(t);await f.tick();let j=f.governance.jobs()[0];await f.governance.action({id:j.id,version:j.version,action:'confirm'});assert.equal(f.governance.get(j.id).state,'confirmed');await assert.rejects(f.governance.action({id:j.id,version:j.version,action:'reopen'}),/已更新/);j=f.governance.get(j.id);await f.governance.action({id:j.id,version:j.version,action:'reopen'});j=f.governance.get(j.id);await assert.rejects(f.governance.action({id:j.id,version:j.version,action:'dismiss'}),/原因/);await f.governance.action({id:j.id,version:j.version,action:'dismiss',note:'两份记录均需独立保留'});assert.equal(f.governance.get(j.id).state,'dismissed');await f.tick();assert.equal(f.calls(),1);assert.equal(f.store.history(f.a.id).length,1);
});
test('different firmware remains separate and cannot be labeled same-scope duplication',async t=>{
 const f=await fixture(t);await f.store.write({document:f.b.id,expected:f.b.revision,content:f.store.read(f.b.id).content.replace('固件 v2','固件 v3')});f.agent.assessKnowledge=async(c,i)=>assessment(i.documents,'scoped');await f.tick();const j=f.governance.jobs()[0];assert.equal(j.state,'ready');assert.equal(j.assessment.recommendation.action,'keep_separate');const documents=f.governance.get(j.id).input.documents,wrong=assessment(documents,'duplicate','different');assert.throws(()=>validateAssessment(wrong,documents),/同一适用范围/);
});
test('same-scope conflicting facts propose investigation, never choose a winner',async t=>{
 const f=await fixture(t);const d=f.store.read(f.b.id);await f.store.write({document:d.id,expected:d.revision,content:d.content.replace(quote,'ADB 连接失败时，不应结束占用 5037 端口的旧进程。')});f.agent.assessKnowledge=async(c,i)=>assessment(i.documents,'conflict');await f.tick();const j=f.governance.jobs()[0];assert.equal(j.assessment.kind,'conflict');assert.equal(j.assessment.recommendation.action,'investigate');assert.equal(j.state,'ready');assert.equal(f.store.history(f.a.id).length,1);
});
test('missing scope, unsupported excerpts and failed independent review cannot become confirmable',async t=>{
 for(const mode of ['scope','quote','review']){const f=await fixture(t);if(mode==='review')f.agent.verifyKnowledgeAssessment=async()=>({...accepted(),scopeSound:false,reason:'原文适用范围不明确'});else f.agent.assessKnowledge=async(c,i)=>{const v=assessment(i.documents);if(mode==='scope')v.evidence[0].scopeQuote='';else v.evidence[0].quote='此原文并没有写过这段内容';return v;};await f.tick();const j=f.governance.jobs()[0];assert.ok(['review','error'].includes(j.state));assert.equal(f.governance.status().jobs[0].canConfirm,false);await assert.rejects(f.governance.action({id:j.id,version:j.version,action:'confirm'}),/尚未通过复核/);}
});
test('unknown scope yields a visible unresolved item instead of a safe-merge label',async t=>{
 const f=await fixture(t);f.agent.assessKnowledge=async(c,i)=>assessment(i.documents,'uncertain','unknown');await f.tick();const j=f.governance.jobs()[0];assert.equal(j.state,'review');assert.equal(j.assessment.recommendation.action,'investigate');
});
test('concurrent document changes invalidate suggestions before verifier completion or human confirmation',async t=>{
 const f=await fixture(t);f.agent.verifyKnowledgeAssessment=async()=>{const d=f.store.read(f.a.id);await f.store.write({document:d.id,content:d.content+'\n人工补充',expected:d.revision});return accepted();};await f.tick();assert.equal(f.governance.jobs()[0].state,'obsolete');assert.match(f.store.read(f.a.id).content,/人工补充/);
 const g=await fixture(t);await g.tick();const j=g.governance.jobs()[0],d=g.store.read(g.b.id);await g.store.write({document:d.id,content:d.content+'\n新增边界',expected:d.revision});await assert.rejects(g.governance.action({id:j.id,version:j.version,action:'confirm'}),/版本或来源/);await g.tick();assert.equal(g.governance.get(j.id).state,'obsolete');assert.equal(g.governance.jobs().length,2);
});
test('stale or unreadable documents are skipped and sources changing after analysis block approval',async t=>{
 const f=await fixture(t);f.blocked.add(f.a.id);await f.tick();assert.equal(f.calls(),0);assert.equal(f.governance.status().coverage.eligible,1);f.blocked.clear();f.governance.configure({scan:true});await f.tick();const j=f.governance.jobs()[0];f.blocked.add(f.a.id);await assert.rejects(f.governance.action({id:j.id,version:j.version,action:'confirm'}),/来源状态/);await f.tick();assert.equal(f.governance.get(j.id).state,'waiting_sources');f.blocked.clear();await f.tick();assert.equal(f.governance.get(j.id).state,'ready');fs.writeFileSync(f.store.read(f.a.id).path,'外部改写');await f.tick();assert.equal(f.governance.get(j.id).state,'waiting_sources');
});
test('pause cancels an in-flight request; persisted choices survive restart',async t=>{
 const f=await fixture(t);let started;const begun=new Promise(r=>started=r);f.agent.assessKnowledge=async(c,i,signal)=>{started();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));signal.throwIfAborted();};const pending=f.tick();await begun;f.governance.configure({enabled:false});await pending;assert.equal(f.governance.settings().state,'paused');assert.equal(f.governance.jobs()[0].state,'queued');await f.governance.stop();const resumed=new KnowledgeGovernance({store:f.store,agent:{assessKnowledge:async()=>{throw Error('must not run');}},consolidation:f.consolidation,search:async()=>[],clock:()=>20000000});await resumed.tick();assert.equal(resumed.settings().state,'paused');await resumed.stop();
});
test('resume after analysis reuses persisted assessment but performs a separate review',async t=>{
 const f=await fixture(t);await f.tick();const j=f.governance.jobs()[0];j.state='verifying';delete j.review;f.governance.save(j);await f.governance.stop();const resumed=new KnowledgeGovernance({store:f.store,agent:f.agent,consolidation:f.consolidation,maintenance:{blocked:()=>new Set()},search:async()=>[],clock:()=>20000000,idleMs:0});await resumed.tick();assert.equal(resumed.get(j.id).state,'ready');assert.equal(f.calls(),1);assert.equal(f.verifications(),2);await resumed.stop();
});
test('discovery batches are fair, idle is respected and search failures are retryable',async t=>{
 const f=await fixture(t,{idleMs:2000,discoveryBatch:1,comparisonBatch:1});await f.tick();assert.equal(f.searches(),0);await f.tick(16000);assert.equal(f.searches(),1);await f.tick(16000);assert.equal(f.searches(),2);assert.equal(f.governance.status().coverage.remaining,0);
 const g=await fixture(t);let fail=true;g.governance.search=async()=>{if(fail)throw Error('offline');return [{id:g.a.id},{id:g.b.id}];};await g.tick();assert.equal(g.governance.status().coverage.remaining,2);assert.equal(g.calls(),0);fail=false;g.governance.configure({scan:true});await g.tick();assert.equal(g.calls(),1);
});
test('connected groups preserve pair-level judgments without inferring all documents equivalent',async()=>{
 const jobs=[{id:'ab',state:'ready',input:{documents:[{id:'a'},{id:'b'}]},assessment:{kind:'duplicate',title:'AB'}},{id:'bc',state:'ready',input:{documents:[{id:'b'},{id:'c'}]},assessment:{kind:'duplicate',title:'BC'}},{id:'ac',state:'ready',input:{documents:[{id:'a'},{id:'c'}]},assessment:{kind:'conflict',title:'AC'}}];const grouped=groups(jobs);assert.equal(grouped.length,2);assert.equal(grouped[0].documents.length,3);assert.deepEqual(grouped[0].records,['ab','bc']);assert.deepEqual(grouped[1].records,['ac']);
});
test('shared provenance is retained without claiming independent corroboration',async t=>{
 const f=await fixture(t),source=await f.store.write({library:f.library,relative:'source.md',content:'# 原始记录\n\n'+scope+'\n\n'+quote,expected:'new'});for(const id of [f.a.id,f.b.id]){const d=f.store.read(id);await f.store.write({document:id,content:d.content+'\n[原始来源](../source.md)',expected:d.revision});}await f.tick();const j=f.governance.jobs().find(j=>j.input.documents.some(d=>d.id===f.a.id)&&j.input.documents.some(d=>d.id===f.b.id));assert.ok(j.input.sharedSources.includes(source.id));const d=f.store.read(source.id);await f.store.write({document:d.id,content:d.content+'\n证据新增限定。',expected:d.revision});await assert.rejects(f.governance.action({id:j.id,version:j.version,action:'confirm'}),/版本或来源/);
});

test('failed searches rotate behind unattempted documents and stale index rows remain retryable',async t=>{
 const f=await fixture(t,{discoveryBatch:1});const attempted=[];f.governance.search=async query=>{attempted.push(query);throw Error('index busy');};await f.tick();await f.tick(16000);assert.equal(attempted.length,2);assert.notEqual(attempted[0],attempted[1]);assert.equal(f.governance.status().coverage.remaining,2);
 const g=await fixture(t);g.governance.search=async()=>[{id:g.a.id,evidence:{version:'doc-v1:old'}},{id:g.b.id,evidence:{version:'doc-v1:old'}}];await g.tick();assert.equal(g.calls(),0);assert.equal(g.governance.status().coverage.remaining,2);assert.ok(g.governance.status().warnings.some(w=>w.reason.includes('检索结果')));
});

test('upstream evidence changes invalidate confirmation and schedule fresh comparisons without touching text',async t=>{
 const f=await fixture(t),s=await f.store.write({library:f.library,relative:'source.md',content:'# 测试来源\n\n'+scope+'\n\n'+quote,expected:'new'});for(const id of [f.a.id,f.b.id]){const d=f.store.read(id);await f.store.write({document:id,content:d.content+'\n[来源](../source.md)',expected:d.revision});}await f.tick();const old=f.governance.jobs().find(j=>j.input.documents.every(d=>[f.a.id,f.b.id].includes(d.id)));const original=f.store.read(f.a.id);await f.store.write({document:s.id,content:f.store.read(s.id).content+'\n补充来源边界。',expected:s.revision});await f.tick();assert.equal(f.governance.get(old.id).state,'obsolete');assert.ok(f.governance.jobs().some(j=>j.pair===old.pair&&j.id!==old.id));assert.equal(f.store.read(f.a.id).revision,original.revision);
});

test('records reference immutable library snapshots and retain exact old evidence after edits',async t=>{
 const f=await fixture(t);await f.tick();const j=f.governance.jobs()[0],raw=JSON.parse(f.store.db.prepare('SELECT data FROM knowledge_governance_jobs WHERE id=?').get(j.id).data);assert.ok(raw.input.documents.every(d=>d.content===undefined));const frozen=f.governance.get(j.id);assert.ok(frozen.input.documents.every(d=>d.content.includes(quote)));const d=f.store.read(f.a.id);await f.store.write({document:d.id,content:d.content+'\n后续人工改写',expected:d.revision});const old=f.governance.get(j.id).input.documents.find(d=>d.id===f.a.id);assert.equal(old.revision,d.revision);assert.doesNotMatch(old.content,/后续人工改写/);assert.equal(old.contentError,undefined);
});
