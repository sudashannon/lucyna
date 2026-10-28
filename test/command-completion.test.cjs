const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const filename=path.resolve(__dirname,'../src/renderer/command-completion.ts'),mod=new Module(filename,module);
mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const {normalizeCommands,commandCatalog,completionContext,suggestionsFor,applyCompletion,commandHint}=mod.exports;
const native=[{name:'mcp',source:'builtin',description:'Manage MCP',input:{hint:'<subcommand>'},subcommands:[{name:'list',description:'列出服务'},{name:'test',description:'测试连接',usage:'<name>'}]},{name:'work-review',source:'file',description:'检查工作状态'},{name:'skill:worktree-session',source:'skill',description:'工作区会话技能',input:{hint:'arguments'}},{name:'skill:git',source:'skill',description:'版本控制'},{name:'plugins',aliases:['plugin'],source:'builtin',description:'插件管理'},{name:'model',source:'builtin',description:'Show model'}];
const catalog=commandCatalog(normalizeCommands(native));
const context=(text,caret=text.length,end=caret,manual=false)=>completionContext(text,caret,end,catalog,manual);
test('native catalog remains intact, local routes override only their own names, no fabricated skills',()=>{
 assert.equal(catalog.filter(x=>x.name==='model').length,1);assert.equal(catalog.find(x=>x.name==='model').source,'desktop');assert.equal(catalog.filter(x=>x.source==='skill').length,2);assert.equal(native[5].source,'builtin');
 assert.throws(()=>normalizeCommands({}));assert.deepEqual(normalizeCommands([{name:'/bad'},{name:'bad name'},{name:'good',source:'extension'},{name:'good'}]).map(x=>x.name),['good']);
});
test('slash completion supports name prefixes, skill short names, aliases and Chinese descriptions',()=>{
 assert.equal(suggestionsFor(context('/wor'),catalog)[0].name,'/work-review');
 assert.ok(suggestionsFor(context('/wor'),catalog).some(x=>x.name==='/skill:worktree-session'));
 assert.equal(suggestionsFor(context('/skill:wo'),catalog)[0].name,'/skill:worktree-session');
 assert.equal(suggestionsFor(context('/plugin'),catalog)[0].name,'/plugins');
 assert.equal(suggestionsFor(context('/工作区'),catalog)[0].name,'/skill:worktree-session');
});
test('normal text, paths, later lines, selections and free arguments do not hijack typing',()=>{
 for(const text of ['hello /work','C:/work','hello\n/work','/mcp test stele','/work-review some prompt'])assert.equal(context(text),null);
 assert.equal(context('/work',3,5),null);assert.equal(context('\n/work'),null);
});
test('accepting a command replaces only the token and preserves arguments, suffixes and leading spaces',()=>{
 const text='  /wor 请检查当前状态\n不要修改文件',ctx=context(text,5);
 const result=applyCompletion(text,ctx,suggestionsFor(ctx,catalog)[0]);
 assert.equal(result.text,'  /work-review 请检查当前状态\n不要修改文件');assert.equal(result.caret,'  /work-review '.length);
});
test('manual launcher prepends a command to existing prose without discarding the draft',()=>{
 const text='请检查当前状态',ctx=context(text,text.length,text.length,true);
 const chosen=suggestionsFor(ctx,catalog).find(x=>x.name==='/skill:worktree-session');
 assert.equal(applyCompletion(text,ctx,chosen).text,'/skill:worktree-session 请检查当前状态');
});
test('native subcommands can be completed and their parameter hints remain visible',()=>{
 const text='/mcp te stele',ctx=context(text,7),items=suggestionsFor(ctx,catalog);
 assert.equal(ctx.kind,'subcommand');assert.equal(items[0].name,'test');
 assert.equal(applyCompletion(text,ctx,items[0]).text,'/mcp test stele');
 assert.match(commandHint('/mcp test stele',catalog),/\/mcp test <name>/);
 assert.equal(context('/mcp ' ).kind,'subcommand');
});
test('source filters never mix skills and commands; empty results remain empty',()=>{
 assert.equal(suggestionsFor(context('/'),catalog,'skills').length,2);
 assert.ok(suggestionsFor(context('/'),catalog,'commands').every(x=>x.source!=='skill'));
 assert.deepEqual(suggestionsFor(context('/no-such-command'),catalog),[]);
});
