const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {HistoryTrash}=require('../src/history-trash.cjs');
const {planDeletion}=require('../src/history-deletion.cjs');
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-delete-')),work=path.join(dir,'work'),bucket=path.join(dir,'agent','sessions','bucket'),id='12345678-abcd-1234-5678-123456789abc',root='/test/work';
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(work,{recursive:true});await fs.mkdir(bucket,{recursive:true});
 const source=path.join(bucket,id+'.jsonl'),memo=path.join(work,`SESSION-${id.slice(0,8)}.md`),artifacts=source.slice(0,-6),backup=source+'.rewrite.bak';
 await fs.writeFile(source,JSON.stringify({type:'session',id,cwd:root})+'\n');await fs.mkdir(artifacts);await fs.writeFile(path.join(artifacts,'output.txt'),'session artifact');await fs.writeFile(backup,'original backup');await fs.writeFile(memo,'private log');await fs.writeFile(path.join(work,'SESSION.md'),'shared summary');await fs.mkdir(path.join(work,'notes'));await fs.writeFile(path.join(work,'notes','shared.md'),'shared knowledge');
 const options={source,root,workPath:work,journalRoot:path.join(dir,'agent'),entry:{title:'test',runtime:'windows'},catalog:[{path:source,id}]};
 return {dir,work,root,id,source,memo,artifacts,backup,options,plan:await planDeletion(options),trash:new HistoryTrash(dir)};
}
test('physical recycle and restore keep journal, native artifacts, rewrite backup and Work memo byte-exact; shared assets stay',async t=>{
 const f=await fixture(t),before=await fs.readFile(f.source);
 assert.deepEqual(f.plan.files.map(x=>x.kind),['journal','artifacts','backup','memo']);
 const key=await f.trash.move(f.plan);
 assert.ok((await f.trash.list(f.root))[0].files.filter(file=>file.kind!=='memo').every(file=>file.trash.startsWith(path.join(f.dir,'agent','.lucyna-trash'))));
 for(const file of [f.source,f.memo,f.backup,f.artifacts])await assert.rejects(fs.stat(file),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(f.work,'SESSION.md'),'utf8'),'shared summary');assert.equal(await fs.readFile(path.join(f.work,'notes','shared.md'),'utf8'),'shared knowledge');
 const reopened=new HistoryTrash(f.dir);await reopened.restore(f.root,key);assert.deepEqual(await fs.readFile(f.source),before);assert.equal(await fs.readFile(f.memo,'utf8'),'private log');assert.equal(await fs.readFile(path.join(f.artifacts,'output.txt'),'utf8'),'session artifact');assert.equal((await reopened.list(f.root)).length,0);
});
test('preview and cancellation do not mutate files; changed evidence rejects deletion',async t=>{
 const f=await fixture(t);assert.equal((await f.trash.list(f.root)).length,0);await fs.appendFile(f.memo,' changed');await assert.rejects(f.trash.move(f.plan),/文件已变化/);assert.ok(await fs.stat(f.source));assert.equal((await f.trash.list(f.root)).length,0);
});
test('short ID collision, duplicate original/copy identity and unavailable catalog preserve memo with an explanation',async t=>{
 const f=await fixture(t);
 for(const extra of [{catalog:[...f.options.catalog,{path:path.join(f.dir,'other.jsonl'),id:'12345678-different'}]},{catalog:[...f.options.catalog,{path:path.join(f.dir,'copy.jsonl'),id:f.id}]},{catalogComplete:false}]){
  const plan=await planDeletion({...f.options,...extra});assert.equal(plan.files.some(x=>x.kind==='memo'),false);assert.ok(plan.warnings.some(x=>x.includes('保留')));
 }
 const full=path.join(f.work,`SESSION-${f.id}.md`);await fs.rename(f.memo,full);const exact=await planDeletion({...f.options,catalog:[...f.options.catalog,{path:path.join(f.dir,'other.jsonl'),id:'12345678-different'}]});assert.ok(exact.files.some(x=>x.path===full));
});
test('failure midway rolls all moved objects back and removes the manifest only after rollback',async t=>{
 const f=await fixture(t);let count=0;const trash=new HistoryTrash(f.dir,{rename:async(a,b)=>{if(++count===3)throw Error('injected move failure');return fs.rename(a,b);}});
 await assert.rejects(trash.move(f.plan),/已回退/);assert.ok(await fs.stat(f.source));assert.ok(await fs.stat(f.artifacts));assert.ok(await fs.stat(f.memo));assert.equal((await trash.list(f.root)).length,0);
});
test('a declared full owner disambiguates a short memo name; a different owner is preserved',async t=>{
 const f=await fixture(t),options={...f.options,catalog:[...f.options.catalog,{path:path.join(f.dir,'other.jsonl'),id:'12345678-other-id'}]};
 await fs.writeFile(f.memo,`# Session log\n\n本session：${f.id}。\n`);assert.ok((await planDeletion(options)).files.some(x=>x.kind==='memo'));
 await fs.writeFile(f.memo,'session_id: 12345678-other-id\n');assert.ok(!(await planDeletion(f.options)).files.some(x=>x.kind==='memo'));
});
test('restore preflights every destination and never overwrites a recreated memo',async t=>{
 const f=await fixture(t),key=await f.trash.move(f.plan);await fs.writeFile(f.memo,'new private log');await assert.rejects(f.trash.restore(f.root,key),/不会覆盖/);await assert.rejects(fs.stat(f.source),{code:'ENOENT'});assert.equal(await fs.readFile(f.memo,'utf8'),'new private log');assert.equal((await f.trash.list(f.root)).length,1);
});
test('interrupted restore can resume after restart without losing already restored files',async t=>{
 const f=await fixture(t),key=await f.trash.move(f.plan);let count=0;const trash=new HistoryTrash(f.dir,{rename:async(a,b)=>{if(++count===2)throw Error('interrupted restore');return fs.rename(a,b);}});
 await assert.rejects(trash.restore(f.root,key),/interrupted/);assert.ok(await fs.stat(f.source));assert.equal((await trash.list(f.root)).length,1);await new HistoryTrash(f.dir).restore(f.root,key);assert.ok(await fs.stat(f.memo));assert.equal((await trash.list(f.root)).length,0);
});
test('failed rollback leaves a discoverable partial manifest that a fresh process can restore',async t=>{
 const f=await fixture(t);let count=0;const trash=new HistoryTrash(f.dir,{rename:async(a,b)=>{if([2,3].includes(++count))throw Error('move and rollback blocked');return fs.rename(a,b);}});
 await assert.rejects(trash.move(f.plan),/部分文件/);const record=(await trash.list(f.root))[0];assert.equal(record.state,'partial');await assert.rejects(fs.stat(f.source),{code:'ENOENT'});await new HistoryTrash(f.dir).restore(f.root,record.key);assert.ok(await fs.stat(f.source));assert.ok(await fs.stat(f.memo));
});
test('Work log symlinks are not followed or removed',async t=>{
 const f=await fixture(t),outside=path.join(f.dir,'outside');await fs.mkdir(outside);await fs.rename(f.memo,path.join(outside,'memo.md'));
 try{await fs.symlink(path.join(outside,'memo.md'),f.memo);}catch(error){if(error.code==='EPERM'){t.skip('Windows symlink privilege unavailable');return;}throw error;}
 const plan=await planDeletion(f.options);assert.equal(plan.files.some(x=>x.kind==='memo'),false);assert.ok(await fs.stat(f.source));assert.equal(await fs.readFile(path.join(outside,'memo.md'),'utf8'),'private log');
});
test('a redirected recycle bin is refused before writing any external child directory',async t=>{
 const f=await fixture(t),outside=path.join(f.dir,'outside');await fs.mkdir(outside);await fs.symlink(outside,f.plan.files[0].trashRoot,'junction');await assert.rejects(f.trash.move(f.plan),/父目录已改变/);assert.deepEqual(await fs.readdir(outside),[]);assert.ok(await fs.stat(f.source));
});
