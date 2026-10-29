const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {workRecord,relatedHistory,groupRepositories}=require('../src/renderer/work-detail-data.ts');
const {createWorkDetails}=require('../src/work-details.cjs');
test('Work record keeps pending text despite all checkboxes checked, with source anchors and newest updates',()=>{
 const r=workRecord('# Work\n## 定位\n- **状态**: `active`\n- **目标**: Goal\n- 当前: Ready locally\n- **未决**: CI and device incomplete\n- **最近更新**: 2026-10-26 19:31 +08:00\n## 待执行任务\n- [x] done\n## 遗留状态\n- 接手者下一步: Verify\n## 2026-10-29 New event\nLatest\n## 2026-10-21 Old event\nOlder');
 assert.equal(r.state,'active');assert.equal(r.completed,1);assert.equal(r.tasks.length,0);assert.equal(r.pending.length,2);assert.equal(r.current.anchor,'定位');assert.equal(r.latest[0].title,'2026-10-29 New event');assert.match(r.recorded,/10-26/);
});
test('one repository groups multiple worktrees, journal links reject ambiguous short ids and copies',()=>{
 assert.equal(groupRepositories([{repo:'/r',name:'one'},{repo:'/r',name:'two'},{repo:'/s',name:'other'}]).length,2);
 const log={name:'SESSION-abcdef01.md'},one={id:'abcdef01-1111',path:'/original'};assert.equal(relatedHistory(log,[one]),one);
 assert.equal(relatedHistory(log,[one,{id:one.id,path:'/copy'}]),null);assert.equal(relatedHistory(log,[one,{id:'abcdef01-2222'}]),null);
});
test('Work detail bridge validates operations, known roots and deduplicates concurrent reads',async()=>{
 let calls=0;const read=createWorkDetails({listWorks:async()=>[{root:'/work'}],execute:(file,args,options,cb)=>{calls++;assert.equal(file,'wsl.exe');assert.ok(args.includes('--exec'));assert.ok(options.windowsHide);setTimeout(()=>cb(null,'{"members":[]}',''),10);}});
 await Promise.all([read('/work'),read('/work')]);assert.equal(calls,1);
 await assert.rejects(read('/elsewhere'),/不在/);await assert.rejects(read('/work','app','checkout'),/不支持/);await assert.rejects(read('/work','../app','diff'),/无效/);await assert.rejects(read('/work','app','diff',{scope:'bad'}),/比较/);assert.equal(calls,1);
});
test('Work detail bridge decodes WSL UTF-16 failures and keeps timeout errors actionable',async()=>{
 const make=(error,stderr)=>createWorkDetails({listWorks:async()=>[{root:'/work'}],execute:(_file,_args,_options,cb)=>cb(error,Buffer.alloc(0),stderr)});
 await assert.rejects(make(Error('failed'),Buffer.from('服务连接超时 WSAETIMEDOUT','utf16le'))('/work'),/服务连接超时 WSAETIMEDOUT/);
 await assert.rejects(make({killed:true},Buffer.alloc(0))('/work'),/已有任务与草稿保持不变/);
});
