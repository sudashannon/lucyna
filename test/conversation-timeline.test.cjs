const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {buildTimeline,railEntries}=require('../src/renderer/conversation-timeline.ts');
const {jumpWindow,historyStart,historyEnd}=require('../src/renderer/transcript-window.ts');
test('timeline omits reasoning and tool output; groups visible answers by user turn',()=>{
 const nodes=buildTimeline([{id:'u',role:'user',content:'hello'},{id:'thought',role:'assistant',content:[{type:'thinking',thinking:'PRIVATE'}]},{id:'progress',role:'assistant',content:'progress'},{id:'tool',role:'tool',status:'失败',intent:'Read file',content:'PRIVATE TOOL OUTPUT'},{id:'final',role:'assistant',content:'**Done**'},{id:'u2',role:'user',content:'next'},{id:'a2',role:'assistant',content:'ok'}],true);
 assert.deepEqual(nodes.map(n=>[n.id,n.kind]),[['u','user'],['tool','failure'],['final','answer'],['u2','user'],['a2','completed']]);assert.ok(!JSON.stringify(nodes).includes('PRIVATE'));
});
test('large transcripts retain bounded jump windows and bounded rail density',()=>{
 const messages=Array.from({length:20000},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',content:'entry '+i}));
 for(const index of [0,4,100,14999,19999]){const range=jumpWindow(messages,index),start=historyStart(messages,range.start),end=historyEnd(messages,range.end);assert.ok(start<=index&&end>index);assert.ok(end-start<=80);}
 const entries=buildTimeline(messages,true),markers=railEntries(entries,messages.length);assert.ok(markers.length<=51);assert.equal(markers[0].id,'m0');assert.equal(markers.at(-1).id,'m19999');
 const compact=railEntries(entries,messages.length,8);assert.ok(compact.length<=11);assert.equal(compact[0].id,'m0');assert.equal(compact.at(-1).id,'m19999');
});
