const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
function load(desktop){global.window={desktop};delete require.cache[require.resolve('../src/renderer/api.ts')];return require('../src/renderer/api.ts');}
test('partial desktop bridge preserves native calls and returns actionable errors for missing knowledge APIs',async()=>{
 const request=async()=>({running:true});const {api}=load({request,knowledgeCatalog:undefined});assert.equal(api.request,request);assert.deepEqual(await api.request(),{running:true});await assert.rejects(api.knowledgeCatalog(),/接口尚未就绪/);await assert.rejects(api.knowledgeDocument('id'),/重新打开 Lucyna/);
});
test('demo missing capabilities are explicit while a working catalog remains connected',async()=>{
 const knowledgeCatalog=async()=>({documents:[{id:'real'}]});let bridge=load({knowledgeCatalog});assert.equal(bridge.api.knowledgeCatalog,knowledgeCatalog);assert.equal((await bridge.api.knowledgeCatalog()).documents[0].id,'real');bridge=load({mode:'demo'});assert.equal(bridge.demoMode,true);await assert.rejects(bridge.api.knowledgeReviews(),/演示窗口/);
});
