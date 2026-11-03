const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {KnowledgeLibrary,hash}=require('../src/knowledge-library.cjs');
const {classifyWorkAsset,sensitiveDocument}=require('../src/work-knowledge-policy.cjs');
const {createWorkKnowledge}=require('../src/work-knowledge.cjs');
test('Work policy separates notes, process archives, code references, evidence and credentials',()=>{
 assert.equal(classifyWorkAsset({path:'notes/result.md',kind:'note'}).category,'work-note');
 assert.equal(classifyWorkAsset({path:'SESSION-1.md',kind:'log'}).category,'work-record');
 assert.equal(classifyWorkAsset({path:'scripts/fix.py',kind:'script'}).snapshot,false);
 assert.equal(classifyWorkAsset({path:'evidence/plot.png',kind:'evidence',size:100}).snapshot,true);
 assert.equal(classifyWorkAsset({path:'evidence/large.pdf',kind:'evidence',size:11*1024*1024}).snapshot,false);
 assert.equal(classifyWorkAsset({path:'notes/.env.local',kind:'note'}).allowed,false);
 assert.ok(sensitiveDocument('password: "FixtureRealish!9"'));
 assert.equal(sensitiveDocument('api_key: ${API_KEY}\npassword: <your-password>\n密码：通过环境变量读取'), '');
});
test('Work snapshots survive source deletion, remain out of library catalog, and enforce owning Work',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-work-materials-')),store=new KnowledgeLibrary(directory);t.after(()=>store.close());
 const input={root:'/work/a',relative:'notes/result.md',kind:'note',policy:classifyWorkAsset({kind:'note'}),content:'# verified at source',sourceHash:hash('# verified at source'),locator:{distro:'fixture'}};
 const a=await store.captureWork(input);assert.equal((await store.captureWork(input)).revision,a.revision);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM documents').get().n,0);
 const reopened=new KnowledgeLibrary(directory);try{assert.equal(reopened.readWork('/work/a',a.id).content,input.content);assert.throws(()=>reopened.readWork('/work/b',a.id),/不属于/);}finally{reopened.close();}
 await assert.rejects(store.captureWork({...input,relative:'scripts/a.py',kind:'script'}),/仅登记引用/);
 await assert.rejects(store.captureWork({...input,content:'password: RealishFixture!9',sourceHash:null}),/凭据/);
 const script=await store.captureWork({...input,relative:'scripts/a.py',kind:'script',content:undefined});assert.equal(store.readWork('/work/a',script.id).content,null);
});
test('trusted capture validates current asset inventory and rejects root escape before saving',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-work-capture-'));fs.mkdirSync(path.join(directory,'notes'));fs.writeFileSync(path.join(directory,'notes','a.md'),'# selected note');
 const escape='../'+path.basename(directory)+'-outside.md';
 const provider=createWorkKnowledge({listWorks:async()=>[{root:'/work/a'}],details:async()=>({assets:[{path:'notes/a.md',kind:'note',name:'a'},{path:escape,kind:'note'}]}),wslUnc:()=>directory,distro:'fixture'});
 const result=await provider.capture('/work/a','notes/a.md');assert.equal(result.sourceHash,hash(result.content));assert.equal(result.policy.category,'work-note');
 await assert.rejects(provider.capture('/work/b','notes/a.md'),/登记/);await assert.rejects(provider.capture('/work/a','not-listed.md'),/清单/);
 fs.writeFileSync(path.join(directory,escape),'outside');await assert.rejects(provider.capture('/work/a',escape),/越出/);
 fs.writeFileSync(path.join(directory,'notes','a.md'),'password: Fixture!9234');await assert.rejects(provider.capture('/work/a','notes/a.md'),/脱敏/);
});
