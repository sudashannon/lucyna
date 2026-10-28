const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {listDirectory,previewKind}=require('../src/file-browser.cjs');
test('file browser lists actual folders first, hides dotfiles and filters within the current directory',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'omp-files-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'notes'));await Promise.all(['SESSION.md','script.py','data.bin','.private.md','图2.png','图10.png'].map(name=>fs.writeFile(path.join(root,name),'test')));
 let result=await listDirectory(root);assert.equal(result.entries[0].name,'notes');assert.equal(result.total,6);assert.equal(result.entries.find(e=>e.name==='script.py').kind,'text');assert.equal(result.entries.find(e=>e.name==='data.bin').kind,'file');
 assert.deepEqual(result.entries.filter(e=>e.kind==='image').map(e=>e.name),['图2.png','图10.png']);
 result=await listDirectory(root,'',{query:'SESSION',showHidden:true});assert.equal(result.total,1);assert.equal(result.entries[0].kind,'markdown');
 assert.equal((await listDirectory(root,'',{showHidden:true})).total,7);assert.equal((await listDirectory(root,'notes')).total,0);
});
test('file browser pagination never silently truncates large folders',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'omp-page-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await Promise.all(Array.from({length:205},(_,i)=>fs.writeFile(path.join(root,`note-${i}.md`),'')));
 const first=await listDirectory(root),second=await listDirectory(root,'',{offset:first.nextOffset});assert.equal(first.total,205);assert.equal(first.entries.length,200);assert.equal(second.entries.length,5);assert.equal(second.nextOffset,null);assert.equal(new Set([...first.entries,...second.entries].map(e=>e.path)).size,205);
});
test('directory traversal and junctions outside the work root are rejected',async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'omp-boundary-')),root=path.join(parent,'work'),outside=path.join(parent,'outside');t.after(()=>fs.rm(parent,{recursive:true,force:true}));await fs.mkdir(root);await fs.mkdir(outside);
 await assert.rejects(listDirectory(root,'../outside'),/只能浏览/);await assert.rejects(listDirectory(root,outside),/只能浏览/);await assert.rejects(listDirectory(root,'',{offset:-1}),/无效/);
 await fs.symlink(outside,path.join(root,'external'),'junction');const entry=(await listDirectory(root)).entries[0];assert.equal(entry.kind,'blocked');await assert.rejects(listDirectory(root,'external'),/只能浏览/);
 assert.equal(previewKind('README.md'),'markdown');assert.equal(previewKind('config.toml'),'text');assert.equal(previewKind('app.exe'),'file');
});
