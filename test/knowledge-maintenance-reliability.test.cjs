const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {KnowledgeLibrary}=require('../src/knowledge-library.cjs');
const {KnowledgeScheduler}=require('../src/knowledge-scheduler.cjs');
const {KnowledgeMaintenance}=require('../src/knowledge-maintenance.cjs');
const {KnowledgeConsolidation}=require('../src/knowledge-consolidation.cjs');
const {KnowledgeGovernance}=require('../src/knowledge-governance.cjs');
const {inventory,readRevision,SOURCE_POLICY}=require('../src/knowledge-maintenance-sources.cjs');
const {segments,excerpt}=require('../src/knowledge-text-segments.cjs');
const {publishConnection}=require('../src/knowledge-connection.cjs');
const {links}=require('../src/knowledge-markdown-links.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const accepted=()=>({supported:true,scopeUnchanged:true,complete:true,reason:'原文证据支持局部修订',usedTokens:1});
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-reliability-')),store=new KnowledgeLibrary(directory),library=store.list()[0].id;t.after(()=>store.close());return {store,library,directory,write:(relative,content,extra={})=>store.write({library,relative,content,expected:'new',...extra})};}

test('FIFO grants waiting maintenance and governance a turn before a repeated producer',async()=>{
 const q=new KnowledgeScheduler(),gate=deferred(),events=[];let active=0,max=0;
 const run=(name,wait)=>q.run(name,async()=>{max=Math.max(max,++active);events.push(name);if(wait)await wait;active--;});
 const first=run('consolidation',gate.promise);await Promise.resolve();const maintenance=run('maintenance'),governance=run('governance');
 assert.equal(q.status('governance').position,2);gate.resolve();await first;const next=run('consolidation');await Promise.all([maintenance,governance,next]);assert.deepEqual(events,['consolidation','maintenance','governance','consolidation']);assert.equal(max,1);q.close();
});

test('Windows sharing violations retry the connection rename without replacing a valid record on failure',async t=>{
 const f=fixture(t),file=path.join(f.directory,'connection.json');fs.writeFileSync(file,JSON.stringify({pid:1}));let attempts=0;
 await publishConnection(file,{pid:2},{pause:async()=>{},rename:async(a,b)=>{if(++attempts<3)throw Object.assign(Error('sharing violation'),{code:'EPERM'});await fs.promises.rename(a,b);}});assert.equal(attempts,3);assert.equal(JSON.parse(fs.readFileSync(file)).pid,2);
 await assert.rejects(publishConnection(file,{pid:3},{pause:async()=>{},rename:async()=>{throw Object.assign(Error('still locked'),{code:'EACCES'});}}),/still locked/);assert.equal(JSON.parse(fs.readFileSync(file)).pid,2);assert.equal(fs.readdirSync(f.directory).some(s=>s.endsWith('.tmp')),false);
});

test('governance identifies a partial long-document comparison and retains full revision evidence positions',async t=>{
 const f=fixture(t),scope='适用范围：RX101 固件 v2，实验室 USB 环境。',quote='ADB 无法连接时，先检查端口占用再重启服务。';for(const name of ['a','b'])await f.write(name+'.md','# ADB\n\n'+scope+'\n\n'+quote+'\n\n'+'其他硬件与固件限制。\n'.repeat(8000));
 const g=new KnowledgeGovernance({store:f.store,consolidation:{config:{model:'fixture'},all:()=>[]},maintenance:{blocked:()=>new Set()},search:async()=>f.store.db.prepare('SELECT id FROM documents').all(),clock:()=>100000,idleMs:0,agent:{assessKnowledge:async(c,input)=>{assert.ok(input.documents.every(d=>d.partial&&Buffer.byteLength(d.content)<60000));return {kind:'duplicate',title:'相同端口步骤',reason:'两个片段相同',scope:{relation:'same',explanation:'相同固件与环境'},evidence:input.documents.map(d=>({document:d.id,quote,scopeQuote:scope,claim:'先检查端口'})),recommendation:{action:'merge',summary:'仅建议整理这个共同步骤',steps:['核实全文其他约束'],preserve:['保留完整原文与来源']}};},verifyKnowledgeAssessment:async()=>({evidenceSound:true,scopeSound:true,classificationSound:true,proposalSound:true,reason:'仅对片段提出建议'})}});
 await g.tick();const j=g.jobs()[0];assert.equal(j.state,'ready');assert.equal(j.partialComparison,true);assert.ok(j.assessment.recommendation.preserve.some(s=>s.includes('片段')));assert.ok(j.assessment.evidence.every(e=>e.lineStart===5));await g.stop();
});

test('shutdown aborts current extraction without starting another Work or draining queued model jobs',async t=>{
 const f=fixture(t),q=new KnowledgeScheduler(),started=deferred();let calls=0;
 const c=new KnowledgeConsolidation({store:f.store,register:async()=>{},clock:()=>10000000,idleMs:0,cooldownMs:0,read:async()=>({fingerprint:'stable',skipped:[],files:[{path:'notes/a.md',hash:'h',content:'已确认当前设备和固件的测量结果。',layer:'L1'}]}),agent:{consolidateKnowledge:async(config,input,signal)=>{calls++;started.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));signal.throwIfAborted();}}});c.scheduler=q;
 c.sync({works:['a','b'].map(x=>({root:'/work/'+x,directory:path.join(f.directory,x)})),auxiliary:{baseURL:'http://127.0.0.1:1',model:'fixture'}});for(const p of c.all()){p.observed='stable';p.stableSince=0;c.save(p);}
 const active=c.tick();await started.promise;const queued=q.run('maintenance',()=>{throw Error('must not run');});q.close();await c.stop();await Promise.all([active,queued]);assert.equal(calls,1);assert.equal(c.all().some(p=>p.status==='running'),false);
});

test('real service ticks share the queue without treating waiting jobs as active owners',async t=>{
 const f=fixture(t),q=new KnowledgeScheduler(),gate=deferred(),events=[],consolidation={config:null,all:()=>[]};
 const m=new KnowledgeMaintenance({store:f.store,consolidation,agent:{},register:async()=>{},verify:async()=>({passed:true}),clock:()=>100000,idleMs:0,intervalMs:0});
 const g=new KnowledgeGovernance({store:f.store,consolidation,maintenance:m,agent:{},search:async()=>[],clock:()=>100000,idleMs:0});m.scheduler=g.scheduler=q;const ms=m.scan.bind(m),gs=g.scan.bind(g);m.scan=async()=>{events.push('maintenance');return ms();};g.scan=async signal=>{events.push('governance');return gs(signal);};
 consolidation.job=q.run('consolidation',()=>gate.promise);m.configure({enabled:true,scan:true});g.configure({enabled:true,scan:true});const a=m.job,b=g.job;assert.ok(a&&b);assert.match(m.status().message,/L3/);assert.match(g.status().message,/队列/);gate.resolve();await Promise.all([consolidation.job,a,b]);assert.deepEqual(events,['maintenance','governance']);q.close();await Promise.all([m.stop(),g.stop()]);
});

test('long documents remain readable and warnings distinguish external edits and missing files',async t=>{
 const f=fixture(t),long=await f.write('long.md','# 长说明\n'+('保留设备与版本条件。\n'.repeat(6000))),edited=await f.write('edited.md','# 原文'),missing=await f.write('missing.md','# 原文');
 fs.writeFileSync(edited.path,'外部改写');fs.unlinkSync(missing.path);const v=await inventory(f.store,{all:()=>[]});assert.ok(v.docs.get(long.id).readable);assert.ok(v.docs.get(long.id).segmented);assert.equal(readRevision(f.store,long.id,long.revision),f.store.read(long.id).content);assert.equal(v.warnings.find(w=>w.document===edited.id).code,'projection_changed');assert.equal(v.warnings.find(w=>w.document===missing.id).code,'file_missing');assert.equal(v.warnings.length,2);
});

test('inventory yields between batches so a large library cannot monopolize service health checks',async t=>{
 const f=fixture(t);for(let i=0;i<32;i++)await f.write(i+'.md','# 库内资料 '+i);let yielded=false,readsAfterYield=0;const original=f.store.read.bind(f.store);f.store.read=id=>{if(yielded)readsAfterYield++;return original(id);};setImmediate(()=>{yielded=true;});await inventory(f.store,{all:()=>[]});assert.ok(readsAfterYield>=16);
});

test('long Markdown parsing runs off-thread, preserves reference semantics and does not expose mutable cached results',async()=>{
 const content='# 大文档\n'+('说明与限制。\n'.repeat(40000))+'\n[真正引用][ref]\n\n> [证据中的链接](quoted.md)\n\n```md\n[代码中的示例](example.md)\n```\n\n[ref]: actual.md';let serviced=false;const timer=setTimeout(()=>{serviced=true;},0),result=await links(content,{excludeQuotes:true});clearTimeout(timer);assert.equal(serviced,true);assert.deepEqual(result,['actual.md']);result.push('mutated');assert.deepEqual(await links(content,{excludeQuotes:true}),['actual.md']);assert.deepEqual((await links(content)).sort(),['actual.md','quoted.md']);
});

test('relative references recover from registered original paths, never basename guesses',async t=>{
 const f=fixture(t),source=await f.write('知识/source.md','# 精确来源'),target=await f.write('报告/guide.md','# 指南\n[来源](source.md)\n[未登记](else/source.md)');
 const original=path.join(f.directory,'original');for(const [file,d] of [['source.md',source],['guide.md',target]])f.store.db.prepare('INSERT INTO document_path_aliases VALUES(?,?)').run(path.join(original,file),d.id);
 const v=await inventory(f.store,{all:()=>[]}),refs=v.references.get(target.id);assert.equal(refs[0].document,source.id);assert.equal(refs[0].canonical,true);assert.equal(refs[1].issue,'unregistered_link');
});

test('relative links inside quoted Work evidence are not treated as library dependencies',async t=>{
 const f=fixture(t),d=await f.write('work.md','# 工作经验\n\n> 引用 [日志](not-a-library-file.md)\n\n[正文引用](also-missing.md)',{provenance:{kind:'work-consolidation',root:'/work/test'}}),v=await inventory(f.store,{all:()=>[{root:'/work/test',registered:false,sources:{}}]});assert.equal(v.references.get(d.id).length,1);assert.equal(v.references.get(d.id)[0].url,'also-missing.md');
});

test('segment slices preserve all Unicode bytes and partial excerpts explicitly retain their limits',()=>{
 const content=('设备🙂约束与版本\n'.repeat(15000)),parts=segments(content);assert.equal(parts.map(p=>p.content).join(''),content);assert.ok(parts.every(p=>Buffer.byteLength(p.content)<=60000&&!p.content.includes('\ufffd')));const e=excerpt(content,'设备');assert.equal(e.partial,true);assert.ok(Buffer.byteLength(e.content)<60000);assert.ok(e.ranges.length);
});

test('long target resumes between segments and writes once only after every separate verification',async t=>{
 const f=fixture(t),before='采样间隔是 10 ms，仅用于 RX101 固件 v2。',after=before.replace('10','20'),source=await f.write('source.md','# 来源\n'+before),target=await f.write('guide.md','# RX101 固件 v2\n'+('不变内容和历史条件。\n'.repeat(5000))+before+'\n[依据](source.md)');let calls=0;
 const options={store:f.store,consolidation:{config:{model:'fixture'},all:()=>[]},clock:()=>100000,idleMs:0,intervalMs:0,register:async()=>{},verify:async()=>({passed:true}),agent:{maintainKnowledge:async(c,i)=>{calls++;assert.ok(Buffer.byteLength(JSON.stringify(i))<600000);return {decision:i.document.content.includes(before)?'revise':'valid',reason:'核对当前分段',patches:i.document.content.includes(before)?[{before,after,evidence:[{source:source.id,quote:after}]}]:[],usedTokens:1};},verifyKnowledgeMaintenance:async()=>accepted()}};
 let m=new KnowledgeMaintenance(options);await m.tick();await f.store.write({document:source.id,content:'# 来源\n'+after,expected:source.revision});await m.tick();let j=m.jobs()[0];assert.ok(j.progress.total>1);assert.equal(j.progress.completed,1);assert.equal(f.store.history(target.id).length,1);await m.stop();m=new KnowledgeMaintenance(options);for(let i=0;i<10&&m.jobs()[0].state!=='completed';i++)await m.tick();j=m.jobs()[0];assert.equal(j.state,'completed');assert.equal(j.progress.completed,j.progress.total);assert.equal(calls,j.progress.total);assert.equal(f.store.history(target.id).length,2);assert.equal(f.store.read(target.id).content,f.store.read(target.id).content.replace(before,after));await m.stop();
});

test('partial long-source evidence cannot auto-approve a whole-document revision',async t=>{
 const f=fixture(t),before='采样间隔是 10 ms，仅用于 RX101 固件 v2。',after=before.replace('10','20'),source=await f.write('source.md','# 来源\n'+before+'\n'+('其他版本限制。\n'.repeat(9000))),target=await f.write('guide.md','# 指南\n'+before+'\n[依据](source.md)');
 const m=new KnowledgeMaintenance({store:f.store,consolidation:{config:{model:'fixture'},all:()=>[]},clock:()=>100000,idleMs:0,intervalMs:0,register:async()=>{},verify:async()=>({passed:true}),agent:{maintainKnowledge:async(c,i)=>{assert.equal(i.sources[0].partial,true);return {decision:'revise',reason:'片段证据支持',patches:[{before,after,evidence:[{source:source.id,quote:after}]}]};},verifyKnowledgeMaintenance:async()=>accepted()}});await m.tick();await f.store.write({document:source.id,content:f.store.read(source.id).content.replace(before,after),expected:source.revision});await m.tick();const j=m.jobs()[0];assert.equal(j.state,'review');assert.equal(j.verdict.complete,false);assert.match(j.reason,/全文限制/);assert.equal(f.store.history(target.id).length,1);await assert.rejects(m.action(j.id,'apply'),/没有通过复核/);await m.stop();
});

test('first updated scan retires old size-limit false alarms without claiming factual verification',async t=>{
 const f=fixture(t),source=await f.write('source.md','# 来源\n'+'版本约束\n'.repeat(15000)),target=await f.write('guide.md','# 指南\n[来源](source.md)'),m=new KnowledgeMaintenance({store:f.store,consolidation:{all:()=>[]},clock:()=>100000,idleMs:0,intervalMs:0});
 m.track(target.id,{revision:target.revision,refs:{[source.id]:'unavailable:'+source.revision}});m.save({id:'old-false-alarm',document:target.id,fingerprint:'old',state:'queued',title:'指南',input:{document:{revision:target.revision},sources:[{key:source.id,missing:true,revision:'unavailable:'+source.revision}]},events:[]});await m.scan();assert.equal(m.get('old-false-alarm').state,'obsolete');assert.equal(m.blocked().has(target.id),false);assert.equal(m.settings().sourcePolicy,SOURCE_POLICY);assert.equal(f.store.history(target.id).length,1);await m.stop();
});

test('upgrading source classification retains a real revision change that happened while the source was excluded',async t=>{
 const f=fixture(t),source=await f.write('source.md','# 来源\n'+'原始版本约束\n'.repeat(12000)),target=await f.write('guide.md','# 指南\n[来源](source.md)'),m=new KnowledgeMaintenance({store:f.store,consolidation:{all:()=>[]},clock:()=>100000,idleMs:0,intervalMs:0});
 m.track(target.id,{revision:target.revision,refs:{[source.id]:'unavailable:'+source.revision}});await f.store.write({document:source.id,content:f.store.read(source.id).content+'\n新的适用范围约束',expected:source.revision});await m.scan();const j=m.latest().find(j=>j.document===target.id);assert.ok(j);assert.equal(j.state,'queued');assert.equal(j.input.sources[0].previousRevision,source.revision);assert.match(j.reason,/版本已变化/);await m.stop();
});
