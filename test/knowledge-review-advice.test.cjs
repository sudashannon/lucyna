const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {KnowledgeLibrary}=require('../src/knowledge-library.cjs');
const {KnowledgeReviewAdvice}=require('../src/knowledge-review-advice.cjs');

const config={protocol:'chat-completions',baseURL:'http://127.0.0.1:18989/v1',model:'review-test'};
const quote='每次上线前记录设备型号、固件版本与实际验证结果。';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t,{rule='missing-sections',blocked=false,searchResults=[{id:'/wiki/规范/标签.md'}],result}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-review-advice-')),store=new KnowledgeLibrary(directory),
 main={id:'/wiki/设计/路线.md',workspace:'alpha',title:'标签治理方案',path:'/wiki/设计/路线.md',type:'knowledge',frontmatter:{type:'design',tags:['索引']}},
 related={id:'/wiki/规范/标签.md',workspace:'alpha',title:'标签规范',path:'/wiki/规范/标签.md',type:'knowledge',frontmatter:{type:'standard'}},
 texts=new Map([[main.id,'---\ntype: design\n---\n# 标签治理方案\n\n当前草稿讨论统一词汇与标签迁移。\n\n[标签规范](../规范/标签.md)\n'],[related.id,`# 标签规范\n\n${quote}\n\n统一名称和旧拼写的映射保留为别名。\n`]]),
 finding={id:'finding:one',workspace:'alpha',issue:{rule,componentId:main.id,detail:'type design missing: goal|decision|risk|目标|决策|风险|trade',target:'',inputRevision:'revision-1'}},
 catalog={workspaces:[{alias:'alpha',path:'/wiki'}],documents:[main,related]},calls=[],
 service=new KnowledgeReviewAdvice({store,agent:{async adviseKnowledgeReview(_config,request,signal){calls.push(request);return result?result(request):{summary:'先根据文档现有范围核对缺失要点。',steps:['补充目标、决策或风险中确实适用的内容。','将验证责任与真实结果分开记录。'],suggestedText:'目标：由维护者在实施前填写并确认。',questions:['本次变更具体目标是什么？'],references:[{id:related.id,quote}],limitations:[],};}},config:()=>config,getReviews:async()=>[finding],getCatalog:async()=>catalog,readDocument:async doc=>({content:texts.get(doc.id)}),search:async()=>searchResults,isBlocked:id=>id===related.id&&blocked});
 t.after(async()=>{await service.stop();store.close();fs.rmSync(directory,{recursive:true,force:true});});
 return {service,store,main,related,texts,finding,catalog,calls};
}

test('按问题和文档类型生成建议，并只回传白名单文档的可核对引用与链接',async t=>{
 const f=fixture(t);const advice=await f.service.get({id:'finding:one',workspace:'alpha',revision:'revision-1',generate:true});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].finding.guidance.includes('文档类别'),true);
 assert.equal(f.calls[0].document.type.documentType,'design');assert.equal(f.calls[0].context.coverage,'partial');
 assert.equal(f.calls[0].context.documents[0].relation,'原文链接');
 assert.equal(advice.rule,'missing-sections');assert.equal(advice.documentId,f.main.id);assert.equal(advice.references[0].id,f.related.id);
 assert.equal(advice.references[0].quote,quote);assert.equal(advice.cached,false);
 assert.equal(advice.suggestedText,'目标：由维护者在实施前填写并确认。');
});

test('Windows 知识库原文的相对链接与建议链接按注册盘符路径解析',async t=>{
 const f=fixture(t,{rule:'orphan',searchResults:[],result:request=>({summary:'先确认两份文档讨论的是同一套标签范围。',steps:['核对差异和范围后再关联。'],suggestedText:'可在确认范围匹配后关联 [标签规范](../规范/标签.md)。',references:[{id:f.related.id,quote}]})});
 f.main.path='C:/docs/design/route.md';f.related.path='C:/docs/规范/标签.md';
 f.texts.set(f.main.id,'# 路线\n\n[标签规范](../规范/标签.md)\n');
 const advice=await f.service.get({id:'finding:one',workspace:'alpha',revision:'revision-1',generate:true});
 assert.equal(f.calls[0].context.documents[0].relation,'原文链接');
 assert.equal(advice.suggestedText,'可在确认范围匹配后关联 [标签规范](../规范/标签.md)。');
});

test('拒绝编造的文档 ID、原文摘录与链接，不写入无效建议',async t=>{
 const f=fixture(t,{result:()=>({summary:'已准备关联 [其他文档](../其他/不存在.md)。',steps:['打开该引用并核对。'],references:[{id:'/wiki/幽灵.md',quote:'此段依据在提供的原文中并不存在。'}]})});
 await assert.rejects(f.service.get({id:'finding:one',workspace:'alpha',revision:'revision-1',generate:true}),/无法核对的依据/);
 assert.equal(f.store.db.prepare('SELECT 1 FROM knowledge_review_advice').get(),undefined);
});

test('只读缓存命中，原文、关联文档、目录索引或待维护状态变化时缓存失效',async t=>{
 const f=fixture(t),request={id:'finding:one',workspace:'alpha',revision:'revision-1',generate:true};
 await f.service.get(request);assert.equal(await f.service.get({...request,generate:false}).then(value=>value.cached),true);assert.equal(f.calls.length,1);
 f.texts.set(f.related.id,`# 标签规范\n\n${quote}\n\n新增了版本条件。`);
 assert.equal(await f.service.get({...request,generate:false}),null);
 await f.service.get(request);f.service.isBlocked=id=>id===f.related.id;
 assert.equal(await f.service.get({...request,generate:false}),null);
 f.catalog.documents.push({id:'/wiki/新文档.md',workspace:'alpha',title:'新文档',path:'/wiki/新文档.md',type:'knowledge'});
 assert.equal(await f.service.get({...request,generate:false}),null);
 f.texts.set(f.main.id,'原文的新版本。');f.finding.issue.inputRevision='revision-2';
 await assert.rejects(f.service.get({...request,refresh:true}),/版本已变化/);
});

test('没有辅助模型配置时不发起生成，查缓存仍可用',async t=>{
 const f=fixture(t);f.service.config=()=>null;
 assert.equal(await f.service.get({id:'finding:one',workspace:'alpha',revision:'revision-1'}),null);
 await assert.rejects(f.service.get({id:'finding:one',workspace:'alpha',revision:'revision-1',generate:true}),/请先在设置中配置辅助模型/);
 assert.equal(f.calls.length,0);
});

test('相同 finding 并发请求只调用一次 agent，停机时取消并等待生成结束',async t=>{
 const gate=deferred(),f=fixture(t,{result:()=>new Promise((resolve,reject)=>{gate.resolve();const signal=f.requestSignal;if(signal?.aborted)reject(new Error('aborted'));else signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})});
 // Wrap the fixture agent to expose the service-owned cancellation signal.
 const original=f.service.agent.adviseKnowledgeReview.bind(f.service.agent);
 f.service.agent.adviseKnowledgeReview=(model,request,signal)=>{f.requestSignal=signal;return original(model,request,signal);};
 const input={id:'finding:one',workspace:'alpha',revision:'revision-1',generate:true};
 const first=f.service.get(input);await gate.promise;const second=f.service.get(input);await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(f.calls.length,1);const stopping=f.service.stop();
 await assert.rejects(first,/aborted/);await assert.rejects(second,/aborted/);await stopping;
 assert.equal(f.store.db.prepare('SELECT 1 FROM knowledge_review_advice').get(),undefined);
});

test('重新核对时 finding revision 变化会丢弃模型结果',async t=>{
 const f=fixture(t,{result:()=>{f.finding.issue.inputRevision='revision-2';return {summary:'核对后再决定。',steps:['回到最新文档再次检查。'],references:[]};}});
 await assert.rejects(f.service.get({id:'finding:one',workspace:'alpha',revision:'revision-1',generate:true}),/待核实记录已变化/);
 assert.equal(f.store.db.prepare('SELECT 1 FROM knowledge_review_advice').get(),undefined);
});
