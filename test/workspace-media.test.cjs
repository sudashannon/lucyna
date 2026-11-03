const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(require('node:fs').readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {readWorkspacePreview}=require('../src/workspace-preview.cjs');
const {createWorkspaceMedia,mediaErrorText}=require('../src/renderer/workspace-media.ts');

async function fixture(t){const parent=await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-media-')),root=path.join(parent,'work');await fs.mkdir(path.join(root,'notes'),{recursive:true});t.after(()=>fs.rm(parent,{recursive:true,force:true}));return {root,parent};}
test('relative, document-relative and Linux absolute images share a bounded Work reader',async t=>{
 const {root}=await fixture(t),bytes=Buffer.from('RIFF fixture WEBP');await fs.writeFile(path.join(root,'notes','截图 a.webp'),bytes);
 const media=createWorkspaceMedia('/home/test/work',undefined,(work,reference,base)=>readWorkspacePreview(root,reference,base,work));
 const url=await media.resolveImage('notes/%E6%88%AA%E5%9B%BE%20a.webp');assert.equal(url,'data:image/webp;base64,'+bytes.toString('base64'));
 assert.equal((await media.open('/home/test/work/notes/截图%20a.webp')).dataUrl,url);
 assert.equal((await readWorkspacePreview(root,'截图 a.webp','notes/report.md','/home/test/work')).dataUrl,url);
 assert.equal((await readWorkspacePreview(root,'/home/test/work/notes/截图 a.webp','notes/report.md','/home/test/work')).dataUrl,url);
 await fs.writeFile(path.join(root,'notes','readme.md'),'# 验收');assert.equal((await media.open('notes/readme.md#%E9%AA%8C%E6%94%B6')).anchor,'验收');
 await assert.rejects(media.resolveImage('notes/readme.md'),/不是可预览的图片/);
});
test('preview rejects traversal, sibling prefixes, escaped junctions and oversized files',async t=>{
 const {root,parent}=await fixture(t),outside=path.join(parent,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'secret.png'),'private');
 await assert.rejects(readWorkspacePreview(root,'../outside/secret.png',undefined,'/home/test/work'),/当前工作区/);
 await assert.rejects(readWorkspacePreview(root,'/home/test/work-copy/secret.png',undefined,'/home/test/work'),/当前工作区/);
 await fs.symlink(outside,path.join(root,'linked'),'junction');await assert.rejects(readWorkspacePreview(root,'linked/secret.png'),/当前工作区/);
 const large=await fs.open(path.join(root,'large.png'),'w');await large.truncate(10*1024*1024+1);await large.close();await assert.rejects(readWorkspacePreview(root,'large.png'),/10 MiB/);
 await assert.rejects(readWorkspacePreview(root,'missing.webp'),/文件不存在/);
 await assert.rejects(readWorkspacePreview(root,'https://example.com/x.png'),/工作区文件路径/);
});
test('same path on different hosts stays isolated; in-flight dedup does not hide regenerated files',async()=>{
 const calls=[];let release;const pending=new Promise(r=>release=r);
 const local=createWorkspaceMedia('/work',undefined,(...args)=>{calls.push(args);return pending;});
 const remote=createWorkspaceMedia('/work','ssh-test',async(...args)=>{calls.push(args);return {kind:'image',name:'x.png',dataUrl:'remote'};});
 const a=local.resolveImage('x.png'),b=local.resolveImage('x.png');assert.equal(await remote.resolveImage('x.png'),'remote');
 release({kind:'image',name:'x.png',dataUrl:'local'});assert.deepEqual(await Promise.all([a,b]),['local','local']);assert.equal(calls.length,2);assert.equal(calls[1][3],'ssh-test');
 await local.resolveImage('x.png');assert.equal(calls.length,3);
});
test('failed reads can retry and malformed or remote URLs do not become file requests',async()=>{
 let reads=0;const media=createWorkspaceMedia('/work',undefined,async()=>{if(++reads===1)throw Error('remote disconnected');return {kind:'image',name:'x.png',dataUrl:'ok'};});
 await assert.rejects(media.resolveImage('x.png'),/disconnected/);assert.equal(await media.resolveImage('x.png'),'ok');
 for(const href of ['https://example.com/x.png','file:///etc/x.png','//server/x.png','%ZZ.png'])await assert.rejects(media.open(href));
 assert.equal(reads,2);assert.equal(mediaErrorText(Error("Error invoking remote method 'preview:read': Error: ENOENT")),'文件不存在或已移动');
});
