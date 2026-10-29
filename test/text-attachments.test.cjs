const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const front=require('../src/renderer/text-attachments.ts'),back=require('../src/text-attachments.cjs');
test('paste thresholds count lines, preserve unicode/CRLF and bound total bytes',()=>{
  assert.equal(front.shouldAttachText('x'.repeat(8000)),false);assert.equal(front.shouldAttachText('x'.repeat(8001)),true);
  assert.equal(front.shouldAttachText(Array(100).fill('中').join('\r\n')),true);assert.equal(front.shouldAttachText(Array(99).fill('中').join('\n')),false);
  assert.equal(front.textLines('a\rb\r\nc\nd'),4);assert.equal(front.textBytes('你好'),6);
  assert.throws(()=>front.validateTextAttachments('',Array(9).fill({text:'x'})),/8/);
  assert.throws(()=>front.validateTextAttachments('x',[{text:'中'.repeat(1500000)}]),/4 MiB/);
});
test('only explicit inline mode includes content; file references require a saved immutable native URL',()=>{
  const files=[{id:'a',name:'粘贴文本 1.md',mode:'file',text:'秘密原文\r\n'.repeat(100)}];
  assert.throws(()=>front.composeTextPrompt('请分析',files),/尚未保存/);
  assert.throws(()=>front.composeTextPrompt('',files,[{id:'a',url:'file:///etc/passwd'}]),/尚未保存/);
  const url='local://paste-lucyna-'+'a'.repeat(32)+'.md',prompt=front.composeTextPrompt('请分析',files,[{id:'a',url}]);
  assert.ok(prompt.startsWith('请分析'));assert.ok(prompt.includes(url));assert.ok(!prompt.includes('秘密原文'));
  assert.equal(front.composeTextPrompt('任务',[{...files[0],mode:'inline'}]),'任务\n\n'+files[0].text);
});
test('native local roots retain WSL origin and Windows uses the upstream 180-character fallback',()=>{
  const linux=back.attachmentRoots({sessionFile:'/home/user/sessions/demo.jsonl',sessionId:'abc',runtime:'wsl'});
  assert.equal(linux.local,'\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\sessions\\demo\\local');assert.equal(linux.local,linux.canonical);
  const windows=back.attachmentRoots({sessionFile:'C:\\sessions\\demo.jsonl',sessionId:'abc',runtime:'windows'});assert.equal(windows.local,'C:\\sessions\\demo\\local');
  const long=back.attachmentRoots({sessionFile:'C:\\'+('long\\'.repeat(40))+'demo.jsonl',sessionId:'abc',runtime:'windows'},'C:\\tmp');assert.equal(long.local,'C:\\tmp\\omp-local\\abc');
  assert.throws(()=>back.attachmentRoots({sessionFile:'relative.jsonl',sessionId:'a',runtime:'windows'}),/路径/);
});
test('immutable writes preserve exact bytes, are idempotent, separate sessions, and restore short Windows cache from journal assets',async()=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'lucyna-text-')),state={sessionFile:path.join(dir,'demo.jsonl'),sessionId:'test-'+path.basename(dir),runtime:'windows'},files=[{id:'a',text:'原始文本\r\n尾部\t  '}];
  const first=await back.writeTextAttachments(state,files),roots=back.attachmentRoots(state);
  assert.deepEqual(await back.writeTextAttachments(state,files),first);const filename=first[0].name;
  assert.equal(await fsp.readFile(path.join(roots.local,filename),'utf8'),files[0].text);
  assert.deepEqual((await fsp.readdir(roots.local)).filter(n=>n.endsWith('.tmp')),[]);
  const peer={...state,sessionFile:path.join(dir,'peer.jsonl'),sessionId:'peer'};await back.writeTextAttachments(peer,files);assert.notEqual(back.attachmentRoots(peer).local,roots.local);
  await fsp.writeFile(path.join(roots.local,filename),'changed');await assert.rejects(back.writeTextAttachments(state,files),/不一致/);assert.equal(await fsp.readFile(path.join(roots.local,filename),'utf8'),'changed');
  const long={...state,sessionFile:path.join(dir,'long'.repeat(38),'long-session.jsonl')};const saved=await back.writeTextAttachments(long,files),longRoots=back.attachmentRoots(long);assert.notEqual(longRoots.local,longRoots.canonical);
  await fsp.unlink(path.join(longRoots.local,saved[0].name));await back.restoreTextAttachments(long);assert.equal(await fsp.readFile(path.join(longRoots.local,saved[0].name),'utf8'),files[0].text);
});
test('malformed attachments and directory collisions fail without overwriting files',async()=>{
  assert.throws(()=>back.validateAttachments([{id:'../a',text:'x'}]),/无效/);assert.throws(()=>back.validateAttachments([{id:'a',text:'x'},{id:'a',text:'y'}]),/无效/);
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'lucyna-collision-')),state={sessionFile:path.join(dir,'demo.jsonl'),sessionId:'collision',runtime:'windows'};await fsp.writeFile(path.join(dir,'demo'),'do not replace');await assert.rejects(back.writeTextAttachments(state,[{id:'a',text:'text'}]));assert.equal(await fsp.readFile(path.join(dir,'demo'),'utf8'),'do not replace');
});
