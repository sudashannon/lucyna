const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {KnowledgeLibrary}=require('../src/knowledge-library.cjs');
const {KnowledgeConsolidation,snapshot,validateExtraction}=require('../src/knowledge-consolidation.cjs');
const {ConsolidationClient}=require('../src/knowledge-consolidation-client.cjs');
const quote='验证结果：重试必须携带相同的 operationId，避免重复提交。';
const fact={title:'幂等重试',knowledge:'重试使用相同 operationId。',appliesTo:'Lucyna 知识写入接口；仅针对相同内容。',quote};
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-consolidation-')),work=path.join(directory,'work');fs.mkdirSync(path.join(work,'notes'),{recursive:true});fs.writeFileSync(path.join(work,'notes/a.md'),'# 结论\n'+quote);
 const store=new KnowledgeLibrary(path.join(directory,'knowledge'));let now=10000000,calls=0;const agent={consolidateKnowledge:async()=>{calls++;return {facts:[fact],usedTokens:100};}},job=new KnowledgeConsolidation({store,agent,register:async()=>{},clock:()=>now,idleMs:10,cooldownMs:100});
 const config={baseURL:'http://localhost/v1',model:'test',apiKey:'private-test-key'};
 const sync=(busy=false)=>job.sync({works:[{root:'/work/example',directory:work,busy}],auxiliary:config});sync();
 const tick=async(delta=101)=>{now+=delta;await job.tick();};
 t.after(async()=>{await job.stop();store.close();});return {work,store,job,agent,sync,tick,calls:()=>calls,status:()=>job.view('/work/example')};
}
test('default job extracts only L1/L2, persists provenance and deduplicates replays and equivalent sources',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.work,'SESSION.md'),'L0 must not be sent');fs.writeFileSync(path.join(f.work,'SESSION-123.md'),quote);fs.mkdirSync(path.join(f.work,'repos'));fs.writeFileSync(path.join(f.work,'repos/a.md'),'private repo');
 await f.tick();assert.equal(f.status().status,'stabilizing');await f.tick();assert.equal(f.calls(),2);assert.equal(f.status().factCount,1);assert.equal(f.status().sourceCount,2);
 const doc=f.store.read(f.status().document.id);assert.match(doc.content,/notes\/a.md/);assert.match(doc.content,/SESSION-123.md/);assert.doesNotMatch(doc.content,/L0 must not/);assert.equal(doc.provenance.kind,'work-consolidation');
 await f.tick();assert.equal(f.calls(),2);assert.equal(f.store.history(doc.id).length,2);
 assert.ok(!JSON.stringify(f.job.all()).includes('private-test-key'));assert.equal(fs.readFileSync(path.join(f.work,'notes/a.md'),'utf8'),'# 结论\n'+quote);
});
test('source changes replace previous contribution while manual L3 edits stop automatic overwrite',async t=>{
 const f=fixture(t);await f.tick();await f.tick();const id=f.status().document.id;
 fs.appendFileSync(path.join(f.work,'notes/a.md'),'\n修订说明');f.agent.consolidateKnowledge=async()=>({facts:[{...fact,title:'修订结论'}],usedTokens:2});await f.tick();await f.tick();assert.match(f.store.read(id).content,/修订结论/);assert.doesNotMatch(f.store.read(id).content,/## 幂等重试/);
 await f.store.write({document:id,content:'# 人工版本',expected:f.store.read(id).revision});fs.appendFileSync(path.join(f.work,'notes/a.md'),'\n再次修订');await f.tick();await f.tick();assert.equal(f.status().status,'conflict');assert.equal(f.store.read(id).content,'# 人工版本');
});
test('pause aborts in-flight extraction and busy sessions delay dispatch',async t=>{
 const f=fixture(t);f.sync(true);await f.tick();assert.equal(f.status().status,'busy');assert.equal(f.calls(),0);f.sync();await f.tick();
 let started;const waiting=new Promise(r=>started=r);f.agent.consolidateKnowledge=async(config,input,signal)=>{started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {facts:[fact]};};
 const running=f.tick();await waiting;f.job.configure('/work/example',{enabled:false});await running;assert.equal(f.status().status,'paused');assert.equal(f.status().document,null);await f.tick();assert.equal(f.status().document,null);
});
test('changing source during extraction publishes nothing and retries new bytes later',async t=>{
 const f=fixture(t);f.agent.consolidateKnowledge=async()=>{fs.appendFileSync(path.join(f.work,'notes/a.md'),'\nchanged');return {facts:[fact]};};await f.tick();await f.tick();assert.equal(f.status().document,null);assert.equal(f.status().status,'stabilizing');
});
test('uncertain indexing resumes persistent outbox without duplicate writes or another model request',async t=>{
 const f=fixture(t);let failures=1;f.job.register=async()=>{if(failures--)throw Error('index disconnected');};await f.tick();await f.tick();assert.ok(f.job.get('/work/example').pending);assert.equal(f.calls(),1);
 await f.job.stop();const restarted=new KnowledgeConsolidation({store:f.store,agent:f.agent,register:async()=>{},clock:()=>20000000,idleMs:10,cooldownMs:100});t.after(()=>restarted.stop());await restarted.tick();const status=restarted.view('/work/example');assert.equal(status.status,'completed');assert.equal(f.calls(),1);assert.equal(f.store.history(status.document.id).length,1);
});
test('manual edit during index refresh is retained and reported as a conflict',async t=>{
 const f=fixture(t);f.job.register=async()=>{const d=f.store.db.prepare('SELECT * FROM documents').get();await f.store.write({document:d.id,content:'# concurrent human edit',expected:d.revision});};await f.tick();await f.tick();assert.equal(f.status().status,'conflict');const d=f.store.db.prepare('SELECT * FROM documents').get();assert.equal(f.store.read(d.id).content,'# concurrent human edit');
});
test('secret text, symlinked notes and oversized logs are excluded before model dispatch',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.work,'notes/secret.md'),'api_key: sk-'+ 'a'.repeat(40));fs.writeFileSync(path.join(f.work,'SESSION-big.md'),'x'.repeat(120001));const outside=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-outside-'));fs.writeFileSync(path.join(outside,'hidden.md'),'hidden');fs.symlinkSync(outside,path.join(f.work,'notes/link'),'junction');const s=await snapshot(f.work);assert.deepEqual(s.files.map(f=>f.path),['notes/a.md']);assert.equal(s.skipped.length,2);
 await f.tick();await f.tick();assert.equal(f.calls(),1);assert.equal(f.status().skipped.length,2);
});
test('unsupported quotes and credentials in generated knowledge are rejected',()=>{
 assert.throws(()=>validateExtraction({facts:[{...fact,quote:'not in the source'}]},{content:quote}),/引用/);
 assert.throws(()=>validateExtraction({facts:[{...fact,knowledge:'sk-'+ 'a'.repeat(40)}]},{content:quote}),/凭据/);
});
test('failed source is not retried endlessly; a corrected source clears the failure record',async t=>{
 const f=fixture(t);f.agent.consolidateKnowledge=async()=>({facts:[{...fact,quote:'invented quotation'}]});await f.tick();await f.tick();assert.equal(f.status().status,'failed');assert.equal(f.status().document,null);
 f.agent.consolidateKnowledge=async()=>assert.fail('unchanged failed source must wait');await f.tick();
 fs.appendFileSync(path.join(f.work,'notes/a.md'),'\n确认了新的来源版本。');f.agent.consolidateKnowledge=async()=>({facts:[fact],usedTokens:20});await f.tick();await f.tick();await f.tick();assert.equal(f.status().status,'completed');assert.deepEqual(f.job.get('/work/example').failed,{});
});
test('unregistered Work and absent model never dispatch, paused choice survives sync and restart',async t=>{
 const f=fixture(t);f.job.configure('/work/example',{enabled:false});f.sync();await f.tick();assert.equal(f.status().enabled,false);f.job.configure('/work/example',{enabled:true});f.job.config=null;await f.tick();await f.tick();assert.equal(f.status().status,'waiting_agent');assert.equal(f.calls(),0);f.job.sync({works:[],auxiliary:null});assert.equal(f.status().status,'unregistered');await f.tick();assert.equal(f.calls(),0);
});
test('main bridge rejects foreign roots and untrusted paths; old host is reported without restarting it',async()=>{
 const sent=[],runtime={ensure:async()=>({health:{capabilities:['knowledge-consolidation']}}),call:async(...args)=>{sent.push(args);return{};}},client=new ConsolidationClient({knowledge:Object.assign(async()=>{}, {runtime}),listWorks:async()=>[{root:'/work/a'}],wslUnc:()=>'/trusted/path',auxiliary:async()=>({model:'fixture'})});
 await assert.rejects(client.call('consolidationConfigure',{root:'/work/foreign',enabled:true}),/有效/);await assert.rejects(client.call('consolidationStatus',{root:'/work/a',directory:'/arbitrary'}),/无效/);assert.equal(sent.length,0);
 await client.call('consolidationStatus',{root:'/work/a'});assert.equal(sent[0][1].body.works[0].directory,'/trusted/path');runtime.ensure=async()=>({health:{capabilities:[]}});await assert.rejects(client.sync(),/下次服务启动/);
});
