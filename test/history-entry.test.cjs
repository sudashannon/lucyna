const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {historyFileKey,copiesHistory,historyLabel}=require('../src/renderer/history-entry.ts');
test('WSL files keep Linux case across UNC aliases, unlike local Windows files',()=>{
 assert.equal(historyFileKey('\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\Work\\a.jsonl'),historyFileKey('/home/user/Work/a.jsonl'));
 assert.equal(historyFileKey('\\\\wsl$\\Ubuntu-22.04\\home\\user\\Work\\a.jsonl'),historyFileKey('/home/user/Work/a.jsonl'));
 assert.notEqual(historyFileKey('/home/user/Work/a.jsonl'),historyFileKey('/home/user/work/a.jsonl'));
 assert.equal(historyFileKey('C:\\Work\\A.jsonl'),historyFileKey('/mnt/c/work/a.jsonl'));
});
test('native history opens in place, explicit copies and runtime transfer remain distinct',()=>{
 const native={path:'original',sessionFile:'original',agentDir:'/home/user/.omp/agent',runtime:'wsl',sourceKind:'native-wsl'};
 assert.equal(copiesHistory(native,'wsl'),false);assert.equal(copiesHistory(native,'wsl',true),true);assert.equal(copiesHistory(native,'windows'),true);
 assert.equal(historyLabel(native,'wsl'),'WSL 原生 · 原地续聊');
 assert.match(historyLabel({...native,sourceKind:'wsl',importedAt:'date'},'wsl'),/已有副本/);
 assert.match(historyLabel({...native,sourceKind:'native'},'wsl'),/Windows 历史存储/);
 assert.match(historyLabel(native,'windows'),/将创建跨环境副本/);
});
