const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {KnowledgeLibrary}=require('../src/knowledge-library.cjs'),{KnowledgeMaintenance}=require('../src/knowledge-maintenance.cjs');
const {createMaintenanceAccess}=require('../src/knowledge-maintenance-access.cjs');
const old='采样间隔为 10 ms，仅用于 RX101 固件 v2。',updated='采样间隔为 20 ms，仅用于 RX101 固件 v2。';
async function fixture(t,{relative='knowledge/guide.md'}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-maintenance-')),store=new KnowledgeLibrary(directory),library=store.list()[0].id;
 const source=await store.write({library,relative:'source.md',content:'# 实测记录\n\n'+old,expected:'new'}),target=await store.write({library,relative,content:'# 采样指南\n\n'+old+'\n\n[证据](../source.md)',expected:'new'});
 let time=10000000,calls=0;const consolidation={config:{model:'fixture'},all:()=>[]},agent={maintainKnowledge:async()=>{calls++;return {decision:'revise',reason:'新记录明确修订相同固件的采样间隔',patches:[{before:old,after:updated,evidence:[{source:source.id,quote:updated}]}],usedTokens:100};},verifyKnowledgeMaintenance:async()=>({supported:true,scopeUnchanged:true,complete:true,reason:'当前证据与适用范围一致',usedTokens:80})};
 const maintenance=new KnowledgeMaintenance({store,agent,consolidation,register:async()=>{},verify:async()=>({passed:true,retrievable:true}),clock:()=>time,idleMs:0,intervalMs:0});
 t.after(async()=>{await maintenance.stop();store.close();});
 const tick=async()=>{time+=1000;await maintenance.tick();},change=async()=>store.write({document:source.id,content:'# 实测记录\n\n'+updated,expected:store.doc(source.id).revision});
 await tick();return {store,maintenance,agent,consolidation,source,target,tick,change,calls:()=>calls};
}
test('source change produces cited local revision and verified retrieval; repeats are idempotent',async t=>{
 const f=await fixture(t);assert.equal(f.calls(),0);await f.change();await f.tick();const j=f.maintenance.jobs()[0];assert.equal(j.state,'completed');assert.equal(j.checks.passed,true);assert.match(f.store.read(f.target.id).content,/20 ms/);assert.equal(f.store.history(f.target.id).length,2);assert.equal(f.maintenance.settings().usedTokens,180);await f.tick();assert.equal(f.calls(),1);assert.equal(f.maintenance.blocked().size,0);
});
test('missing evidence never calls the model or deletes historical content',async t=>{
 const f=await fixture(t);const d=f.store.read(f.target.id);await f.store.write({document:d.id,content:d.content.replace('../source.md','../missing.md'),expected:d.revision});await f.tick();assert.equal(f.maintenance.jobs()[0].state,'review');assert.equal(f.calls(),0);assert.match(f.store.read(d.id).content,/10 ms/);assert.ok(f.maintenance.freshness(d.id));
});
test('unsupported quote and failed independent review cannot modify content',async t=>{
 for(const mode of ['quote','verifier']){const f=await fixture(t);if(mode==='quote'){const original=f.agent.maintainKnowledge;f.agent.maintainKnowledge=async()=>{const r=await original();r.patches[0].evidence[0].quote='不存在的证据，不能发布';return r;};}else f.agent.verifyKnowledgeMaintenance=async()=>({supported:false,scopeUnchanged:false,complete:false,reason:'不应扩大适用范围'});await f.change();await f.tick();assert.ok(['error','review'].includes(f.maintenance.jobs()[0].state));assert.equal(f.store.history(f.target.id).length,1);}
});
test('specifications require review and a concrete apply action rechecks source versions',async t=>{
 const f=await fixture(t,{relative:'规范/guide.md'});await f.change();await f.tick();let j=f.maintenance.jobs()[0];assert.equal(j.state,'review');assert.equal(f.store.history(f.target.id).length,1);await f.maintenance.action(j.id,'apply');assert.equal(f.maintenance.get(j.id).state,'completed');
});
test('concurrent human edit is preserved',async t=>{
 const f=await fixture(t);f.agent.verifyKnowledgeMaintenance=async()=>{const d=f.store.read(f.target.id);await f.store.write({document:d.id,content:d.content+'\n用户刚补充的约束。',expected:d.revision});return {supported:true,scopeUnchanged:true,complete:true};};await f.change();await f.tick();assert.equal(f.maintenance.jobs()[0].state,'conflict');assert.match(f.store.read(f.target.id).content,/用户刚补充/);assert.match(f.store.read(f.target.id).content,/10 ms/);
});
test('pause cancels in-flight reasoning and remains paused across configuration sync',async t=>{
 const f=await fixture(t);let start;const begun=new Promise(r=>start=r);f.agent.maintainKnowledge=async(c,i,signal)=>{start();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));signal.throwIfAborted();};await f.change();const running=f.tick();await begun;f.maintenance.configure({enabled:false});await running;assert.equal(f.maintenance.settings().status,'paused');assert.equal(f.store.history(f.target.id).length,1);
});
test('index failure keeps persisted write and retries without another revision or model call',async t=>{
 const f=await fixture(t);let fail=true;f.maintenance.verify=async()=>({passed:!fail});await f.change();await f.tick();const j=f.maintenance.jobs()[0];assert.equal(j.state,'error');assert.equal(f.store.history(f.target.id).length,2);fail=false;await f.maintenance.action(j.id,'retry');await f.tick();assert.equal(f.maintenance.get(j.id).state,'completed');assert.equal(f.calls(),1);assert.equal(f.store.history(f.target.id).length,2);
});
test('transitive dependencies are marked stale and processed after upstream repair',async t=>{
 const f=await fixture(t);const c=await f.store.write({library:f.store.list()[0].id,relative:'knowledge/downstream.md',content:'# 下游\n\n'+old+'\n[依据](guide.md)',expected:'new'});await f.tick();await f.change();await f.maintenance.scan();assert.ok(f.maintenance.blocked().has(c.id));await f.tick();await f.tick();assert.equal(f.maintenance.jobs().find(j=>j.document===f.target.id)?.state,'completed');assert.ok(f.maintenance.jobs().some(j=>j.document===c.id));
});
test('rollback creates a new revision and does not silently revalidate old knowledge',async t=>{
 const f=await fixture(t);await f.change();await f.tick();const j=f.maintenance.jobs()[0];await f.maintenance.action(j.id,'rollback');assert.match(f.store.read(f.target.id).content,/10 ms/);assert.equal(f.store.history(f.target.id).length,3);assert.ok(f.maintenance.freshness(f.target.id));await f.tick();assert.equal(f.calls(),1);assert.equal(f.store.history(f.target.id).length,3);assert.equal(f.maintenance.latest()[0].state,'rolled_back');
});
test('machine context excludes unresolved documents while retaining healthy evidence',async t=>{
 const f=await fixture(t);await f.change();await f.maintenance.scan();const rows=[{id:f.store.read(f.target.id).path,title:'旧结论',evidence:{excerpt:old}},{id:f.store.read(f.source.id).path,title:'新证据',evidence:{excerpt:updated}}];const access=createMaintenanceAccess({maintenance:f.maintenance,store:f.store,nativeJSON:async()=>rows});
 const reply=await access.mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'wiki_context',arguments:{query:'采样'}}});assert.ok(!JSON.stringify(reply).includes('10 ms'));assert.ok(JSON.stringify(reply).includes('20 ms'));
 const read=await access.mcp({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'library_read',arguments:{document:f.target.id}}});assert.ok(JSON.stringify(read).includes('needs_review'));
});

test('restart between durable write and recorded result resumes without another model call',async t=>{
 const f=await fixture(t);await f.change();await f.tick();const j=f.maintenance.jobs()[0];j.state='applying';delete j.resultRevision;f.maintenance.save(j);await f.maintenance.stop();
 const recovered=new KnowledgeMaintenance({store:f.store,agent:f.agent,consolidation:f.consolidation,register:async()=>{},verify:async()=>({passed:true}),clock:()=>20000000,idleMs:0,intervalMs:0});await recovered.tick();assert.equal(recovered.get(j.id).state,'completed');assert.equal(f.calls(),1);assert.equal(f.store.history(f.target.id).length,2);await recovered.stop();
});

test('source edit during independent review never publishes obsolete evidence',async t=>{
 const f=await fixture(t);f.agent.verifyKnowledgeMaintenance=async()=>{const d=f.store.read(f.source.id);await f.store.write({document:d.id,content:d.content+'\n修订撤回，待重新测试。',expected:d.revision});return {supported:true,scopeUnchanged:true,complete:true};};await f.change();await f.tick();assert.equal(f.maintenance.jobs()[0].state,'conflict');assert.equal(f.store.history(f.target.id).length,1);
});

test('changed evidence invalidates a prepared review before user apply',async t=>{
 const f=await fixture(t);f.maintenance.configure({autoApply:false});await f.change();await f.tick();const j=f.maintenance.jobs()[0],d=f.store.read(f.source.id);await f.store.write({document:d.id,content:d.content+'\n补充说明。',expected:d.revision});await assert.rejects(f.maintenance.action(j.id,'apply'),/来源或目标已变化/);assert.equal(f.store.history(f.target.id).length,1);
});

test('model cannot introduce new reference links inside an otherwise valid patch',async t=>{
 const f=await fixture(t),original=f.agent.maintainKnowledge;f.agent.maintainKnowledge=async()=>{const p=await original();p.patches[0].after+=' [新来源](other.md)';return p;};await f.change();await f.tick();assert.equal(f.maintenance.jobs()[0].state,'error');assert.equal(f.store.history(f.target.id).length,1);
});

test('historical dismissals do not keep successfully repaired newer knowledge stale',async t=>{
 const f=await fixture(t);f.maintenance.configure({autoApply:false});await f.change();await f.tick();const j=f.maintenance.jobs()[0];await f.maintenance.action(j.id,'dismiss');const d=f.store.read(f.source.id);await f.store.write({document:d.id,content:d.content+'\n复测确认。',expected:d.revision});f.maintenance.configure({autoApply:true});await f.tick();assert.equal(f.maintenance.latest()[0].state,'completed');assert.equal(f.maintenance.freshness(f.target.id),null);
});

test('registered path migrations repair links deterministically without a model',async t=>{
 const f=await fixture(t),d=f.store.read(f.source.id);f.store.db.prepare('INSERT INTO document_path_aliases VALUES(?,?)').run(d.path,d.id);f.store.db.prepare('UPDATE documents SET relative=? WHERE id=?').run('renamed.md',d.id);fs.renameSync(d.path,path.join(path.dirname(d.path),'renamed.md'));f.consolidation.config=null;await f.tick();assert.equal(f.calls(),0);assert.match(f.store.read(f.target.id).content,/\.\.\/renamed\.md/);assert.equal(f.maintenance.jobs()[0].state,'completed');
});

test('serialized review actions prevent overlapping apply and rollback',async t=>{
 const f=await fixture(t);f.maintenance.configure({autoApply:false});await f.change();await f.tick();const j=f.maintenance.jobs()[0];let release,started;const pending=new Promise(r=>started=r);f.maintenance.verify=async()=>{started();await new Promise(r=>release=r);return {passed:true};};const first=f.maintenance.action(j.id,'apply');await pending;await assert.rejects(f.maintenance.action(j.id,'rollback'),/正在运行/);release();await first;assert.equal(f.store.history(f.target.id).length,2);
});

test('Work aggregate delegates to original consolidation and verifies the refreshed revision',async t=>{
 const f=await fixture(t),work=fs.mkdtempSync(path.join(os.tmpdir(),'maintenance-work-'));fs.mkdirSync(path.join(work,'notes'));fs.writeFileSync(path.join(work,'notes/a.md'),old);const {snapshot}=require('../src/knowledge-consolidation.cjs'),snap=await snapshot(work);
 const doc=await f.store.write({library:f.store.list()[0].id,relative:'work.md',content:'# Work 经验\n\n'+old,expected:'new',provenance:{kind:'work-consolidation',root:'/work/test'}}),p={root:'/work/test',directory:work,registered:true,enabled:true,sources:{'notes/a.md':{hash:snap.files[0].hash,facts:[{quote:old}]}}};f.consolidation.all=()=>[p];f.consolidation.save=()=>{};await f.tick();fs.writeFileSync(path.join(work,'notes/a.md'),updated);await f.tick();let j=f.maintenance.jobs().find(j=>j.document===doc.id);assert.equal(j.state,'waiting_source');assert.equal(f.calls(),0);assert.equal(p.lastRunAt,0);
 const next=await snapshot(work);p.sources['notes/a.md'].hash=next.files[0].hash;await f.store.write({document:doc.id,content:'# Work 经验\n\n'+updated,expected:doc.revision});p.document={id:doc.id,revision:f.store.doc(doc.id).revision};await f.tick();j=f.maintenance.get(j.id);assert.equal(j.state,'completed');assert.match(j.plan.patches[0].before,/10 ms/);assert.match(j.plan.patches[0].after,/20 ms/);
});

test('unregistered external file edits and missing projection never become model evidence',async t=>{
 for(const missing of [false,true]){const f=await fixture(t),d=f.store.read(f.source.id);if(missing)fs.unlinkSync(d.path);else fs.writeFileSync(d.path,'# 外部改写\n未经版本登记的内容。');await f.tick();assert.equal(f.calls(),0);assert.equal(f.maintenance.jobs()[0].state,'review');assert.ok(f.maintenance.freshness(d.id));assert.equal(f.store.history(f.target.id).length,1);}
});
