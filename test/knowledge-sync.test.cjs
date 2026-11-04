const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {KnowledgeLibrary}=require('../src/knowledge-library.cjs'),{KnowledgeSync}=require('../src/knowledge-sync.cjs');
const {toWslPath}=require('../src/work-stele.cjs');
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{stdio:'pipe',encoding:'utf8'}).trim();
function store(root){const s=new KnowledgeLibrary(root),lib=s.list()[0];s.db.prepare("UPDATE library_folders SET folder='@root' WHERE library=?").run(lib.id);return {s,lib};}
test('two devices synchronize histories and detect conflicts without touching legacy files',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-sync-')),remote=path.join(root,'remote.git'),seed=path.join(root,'seed');fs.mkdirSync(seed);execFileSync('git',['init','--bare',remote],{stdio:'pipe'});git(seed,'init','-b','master');fs.writeFileSync(path.join(seed,'legacy.txt'),'old stele');git(seed,'add','.');git(seed,'-c','user.name=test','-c','user.email=test@example.test','commit','-m','initial');git(seed,'remote','add','origin',remote);git(seed,'push','origin','master');
 const a=store(path.join(root,'a')),b=store(path.join(root,'b'));try{
  let d=await a.s.write({library:a.lib.id,relative:'知识/example.md',content:'# first',expected:'new',provenance:{kind:'fixture',source:'example'}});d=await a.s.write({document:d.id,content:'# second',expected:d.revision});await a.s.write({library:a.lib.id,relative:'资料/picture.png',bytes:Buffer.from('fixture image'),expected:'new'});
  const sa=new KnowledgeSync(a.s,{allowLocal:true}),sb=new KnowledgeSync(b.s,{allowLocal:true});await sa.configure(remote);await sb.configure(remote);assert.equal((await sa.run()).action,'synced');git(seed,'fetch','origin','master');assert.equal(git(seed,'show','origin/master:lucyna-knowledge/知识/example.md'),'# second');assert.equal((await sb.run()).action,'synced');let bd=b.s.db.prepare('SELECT * FROM documents WHERE relative=?').get('知识/example.md');assert.equal(bd.id,d.id);assert.equal(b.s.read(bd.id).content,'# second');assert.deepEqual(b.s.read(bd.id).provenance,{kind:'fixture',source:'example'});assert.deepEqual(b.s.history(bd.id).map(x=>[x.id,x.hash,x.created,x.origin]),a.s.history(d.id).map(x=>[x.id,x.hash,x.created,x.origin]));assert.equal(b.s.history(bd.id).length,2);assert.equal(b.s.db.prepare('SELECT count(*) AS n FROM documents').get().n,2);
  bd=await b.s.write({document:bd.id,content:'# third',expected:bd.revision});await sb.run();const pulled=await sa.run();assert.equal(pulled.imported,1);assert.equal(a.s.read(d.id).content,'# third');assert.equal(a.s.history(d.id).length,3);
  let ad=a.s.doc(d.id);await a.s.write({document:ad.id,content:'# device a',expected:ad.revision});bd=b.s.doc(bd.id);await b.s.write({document:bd.id,content:'# device b',expected:bd.revision});await sa.run();const conflict=await sb.run();assert.equal(conflict.action,'conflict');assert.deepEqual(conflict.conflicts,['知识/example.md']);assert.equal(b.s.read(bd.id).content,'# device b');assert.equal(git(seed,'show','origin/master:legacy.txt'),'old stele');
 }finally{a.s.close();b.s.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('WSL Git synchronizes a Windows-managed knowledge directory',{skip:process.platform!=='win32'},async()=>{
 const runtime=require('../src/runtime-config.cjs');
 const previousPrefix=runtime.wslPrefix;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-sync-wsl-'));
 const remote=path.join(root,'remote.git');
 const seed=path.join(root,'seed');
 let local;
 try{
  fs.mkdirSync(seed);
  execFileSync('git',['init','--bare',remote],{stdio:'pipe'});
  git(seed,'init','-b','master');
  fs.writeFileSync(path.join(seed,'legacy.txt'),'preserved');
  git(seed,'add','.');
  git(seed,'-c','user.name=test','-c','user.email=test@example.test','commit','-m','initial');
  git(seed,'remote','add','origin',remote);
  git(seed,'push','origin','master');
  local=store(path.join(root,'a'));
  await local.s.write({library:local.lib.id,relative:'知识/test.md',content:'# WSL Git',expected:'new'});
  const sync=new KnowledgeSync(local.s,{allowLocal:true});
  sync.wsl=true;
  await sync.configure('file://'+toWslPath(remote));
  // The fixture's synthetic username is not an installed Linux account.
  runtime.wslPrefix=['-d',runtime.distro];
  assert.equal((await sync.run()).action,'synced');
  assert.equal(git(seed,'fetch','origin','master'),'');
  assert.equal(git(seed,'show','origin/master:legacy.txt'),'preserved');
 }finally{
  runtime.wslPrefix=previousPrefix;
  local?.s.close();
  fs.rmSync(root,{recursive:true,force:true});
 }
});
test('native Git is preferred independently of OMP runtime',{skip:process.platform!=='win32'},async()=>{const sync=new KnowledgeSync({root:os.tmpdir()});assert.equal(await sync.chooseGit(),false);});
test('direct remote edits are reported without replacing local knowledge',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-sync-conflict-')),remote=path.join(root,'remote.git'),seed=path.join(root,'seed');fs.mkdirSync(seed);execFileSync('git',['init','--bare',remote],{stdio:'pipe'});git(seed,'init','-b','master');fs.writeFileSync(path.join(seed,'legacy.txt'),'legacy');git(seed,'add','.');git(seed,'-c','user.name=test','-c','user.email=test@example.test','commit','-m','initial');git(seed,'remote','add','origin',remote);git(seed,'push','origin','master');const a=store(path.join(root,'a'));try{const d=await a.s.write({library:a.lib.id,relative:'知识/test.md',content:'# local',expected:'new'}),sync=new KnowledgeSync(a.s,{allowLocal:true});await sync.configure(remote);await sync.run();git(seed,'fetch','origin','master');git(seed,'merge','--ff-only','origin/master');fs.writeFileSync(path.join(seed,'lucyna-knowledge','知识','test.md'),'# external');git(seed,'add','.');git(seed,'-c','user.name=test','-c','user.email=test@example.test','commit','-m','external');git(seed,'push','origin','master');const result=await sync.run();assert.equal(result.action,'conflict');assert.equal(a.s.read(d.id).content,'# local');assert.equal(git(seed,'show','HEAD:lucyna-knowledge/知识/test.md'),'# external');}finally{a.s.close();fs.rmSync(root,{recursive:true,force:true});}
});
