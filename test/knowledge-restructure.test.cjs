const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {KnowledgeLibrary}=require('../src/knowledge-library.cjs');
const {restructure}=require('../tools/restructure-knowledge.cjs');
test('isolated restructure keeps document IDs and history while updating links and library folders',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-layout-')),oldRoot=path.join(root,'old-location'),copy=path.join(root,'copy');const store=new KnowledgeLibrary(copy);const lib=store.list()[0];
 const a=await store.write({library:lib.id,relative:'openspec/a.md',content:'# A\n[计划](../plans/b.md)',expected:'new'});
 const b=await store.write({library:lib.id,relative:'plans/b.md',content:'# B',expected:'new'});
 fs.renameSync(path.join(copy,'libraries',path.basename(path.dirname(lib.path))),path.join(copy,'libraries',lib.id));store.db.prepare('DELETE FROM library_folders').run();store.close();
 fs.mkdirSync(path.join(copy,'engine-state'));fs.writeFileSync(path.join(copy,'engine-state/workspaces.yaml'),'workspaces: []\n');
 const idx=[{path:path.join(oldRoot,'libraries',lib.id,'documents','openspec','a.md'),type:'knowledge'},{path:path.join(oldRoot,'libraries',lib.id,'documents','plans','b.md'),type:'plan'}];
 const result=await restructure({directory:copy,originalRoot:oldRoot,index:idx});assert.equal(result.files,2);assert.equal(result.rewritten,1);assert.equal(result.changed,1);
 const migrated=new KnowledgeLibrary(copy);t.after(()=>migrated.close());const read=migrated.read(a.id);assert.ok(read.path.includes('个人知识库'));assert.ok(read.content.includes('../%E8%AE%A1%E5%88%92/b.md'));assert.equal(migrated.history(a.id).length,2);assert.equal(migrated.read(b.id).content,'# B');assert.ok(fs.existsSync(path.join(copy,'previous-libraries',lib.id,'documents','openspec','a.md')));
});
