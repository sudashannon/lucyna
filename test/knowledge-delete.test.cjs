const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {KnowledgeLibrary,hash}=require('../src/knowledge-library.cjs');

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-delete-')),store=new KnowledgeLibrary(root);let open=true;
 t.after(()=>{if(open)store.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,store,library:store.list()[0],close:()=>{if(open){store.close();open=false;}}};
}
function request(library,document,overrides={}){return {reviewId:'review/raw: 1',workspace:library.alias,inputRevision:'analyzer-hash:duplicate-v2',documentId:document.id,documentRevision:document.revision,operationId:randomUUID(),title:'删除测试文档',componentId:document.id,...overrides};}

test('managed review deletion moves only the selected projection and preserves revisions, siblings, imports and idempotency',async t=>{
 const {root,store,library}=fixture(t),doc=await store.write({library:library.id,relative:'资料/待删除.md',content:'# 当前文档\n',expected:'new'}),related=await store.write({library:library.id,relative:'资料/关联文档.md',content:'# 保留\n',expected:'new'});
 const attachment=path.join(store.directory(library.id),'资料','附件.bin');fs.writeFileSync(attachment,Buffer.from([1,2,3]));
 const external=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-delete-import-source-'));t.after(()=>fs.rmSync(external,{recursive:true,force:true}));const original=path.join(external,'imported.md');fs.writeFileSync(original,'# 外部原件\n');
 const plan=await store.scan(external,library.id);await store.executeImport(plan.id);const imported=store.db.prepare('SELECT * FROM documents WHERE relative=?').get('imported.md');
 store.db.prepare('INSERT INTO document_path_aliases(path,document) VALUES(?,?)').run('legacy-alias',doc.id);
 const op=request(library,doc),saved=store.deleteManagedDocumentSync(op),tombstone=store.tombstone(doc.id),trash=path.join(root,...tombstone.trash_relative.split('/'));
 assert.equal(saved.deleted,true);assert.equal(saved.documentId,doc.id);assert.equal(saved.indexed,false);assert.equal(fs.existsSync(doc.path),false);assert.equal(fs.readFileSync(trash,'utf8'),'# 当前文档\n');
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM revisions WHERE document=?').get(doc.id).n,1);assert.equal(store.db.prepare('SELECT 1 FROM documents WHERE id=?').get(doc.id),undefined);assert.equal(store.db.prepare('SELECT 1 FROM document_path_aliases WHERE document=?').get(doc.id),undefined);
 assert.ok(store.doc(related.id));assert.equal(fs.existsSync(related.path),true);assert.equal(fs.readFileSync(attachment)[0],1);assert.equal(fs.readFileSync(original,'utf8'),'# 外部原件\n');assert.ok(store.doc(imported.id));
 assert.deepEqual(store.findReviewDelete({...op}),saved);assert.equal(store.reviewDeleteComponent(op.operationId),doc.id);
 assert.equal(store.reviewDeleteIndex(op.operationId,{indexed:true}).indexed,true);
});

test('deletion rejects a changed managed revision, changed projection bytes and symlink escapes',async t=>{
 const {store,library}=fixture(t),doc=await store.write({library:library.id,relative:'资料/改版.md',content:'v1',expected:'new'}),stale=request(library,doc);
 const next=await store.write({document:doc.id,content:'v2',expected:doc.revision});
 assert.throws(()=>store.deleteManagedDocumentSync(stale),/变化|确认/);assert.equal(store.read(doc.id).content,'v2');assert.equal(fs.readFileSync(next.path,'utf8'),'v2');
 const live=request(library,next);fs.writeFileSync(next.path,'outside edit');assert.throws(()=>store.deleteManagedDocumentSync(live),/变化|核对/);assert.equal(fs.readFileSync(next.path,'utf8'),'outside edit');
 fs.unlinkSync(next.path);fs.rmSync(path.dirname(next.path),{recursive:true,force:true});const outside=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-delete-outside-'));fs.writeFileSync(path.join(outside,'改版.md'),'outside secret');fs.symlinkSync(outside,path.dirname(next.path),'junction');
 assert.throws(()=>store.deleteManagedDocumentSync(live),/链接|越界/);assert.equal(fs.readFileSync(path.join(outside,'改版.md'),'utf8'),'outside secret');assert.ok(store.doc(doc.id));fs.rmSync(outside,{recursive:true,force:true});
});

test('a prepared deletion recovers after moving the projection, and cannot remove a later same-content revision',async t=>{
 const {root,store,library,close}=fixture(t),doc=await store.write({library:library.id,relative:'资料/恢复.md',content:'exact bytes',expected:'new'}),op=request(library,doc),original=store.commitDelete.bind(store);
 store.commitDelete=()=>{throw Error('simulated crash after projection move');};assert.throws(()=>store.deleteManagedDocumentSync(op),/simulated crash/);assert.equal(fs.existsSync(doc.path),false);assert.ok(fs.existsSync(path.join(root,...store.db.prepare('SELECT trash_relative FROM knowledge_delete_operations WHERE operation_id=?').get(op.operationId).trash_relative.split('/'))));
 store.commitDelete=original;close();let reopened=new KnowledgeLibrary(root),id,second,later;
 try{
  assert.equal(reopened.doc(doc.id),null);assert.equal(reopened.tombstone(doc.id).revision,doc.revision);assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM revisions WHERE document=?').get(doc.id).n,1);
  second=await reopened.write({library:library.id,relative:'资料/保留新修订.md',content:'same bytes',expected:'new'});id=randomUUID();const requestData=request(library,second),trashRelative=['trash',id,second.id,...second.relative.split('/')].join('/');
  reopened.db.prepare('INSERT INTO knowledge_delete_operations(operation_id,signature,status,document,library,relative,revision,hash,trash_relative,request,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,reopened.deleteRequestSignature(requestData),'prepared',second.id,library.id,second.relative,second.revision,hash(Buffer.from('same bytes')),trashRelative,JSON.stringify({...requestData,title:'恢复冲突'}),new Date().toISOString());
  later=await reopened.write({document:second.id,content:'same bytes',expected:second.revision});assert.notEqual(later.revision,second.revision);
 }finally{reopened.close();}
 reopened=new KnowledgeLibrary(root);try{assert.equal(reopened.read(second.id).revision,later.revision);assert.equal(fs.readFileSync(later.path,'utf8'),'same bytes');assert.equal(reopened.db.prepare('SELECT status FROM knowledge_delete_operations WHERE operation_id=?').get(id).status,'conflict');}finally{reopened.close();}
});

test('tombstones block automatic replays and stale committed write recovery but permit explicit creation with a new identity',async t=>{
 const {root,store,library,close}=fixture(t),initial={library:library.id,relative:'知识/自动任务.md',content:'original',expected:'new',operationId:'old-write'},doc=await store.write(initial),op=request(library,doc);
 store.db.prepare("UPDATE operations SET status='committed' WHERE id='old-write'").run();store.deleteManagedDocumentSync(op);
 assert.equal(store.db.prepare("SELECT status FROM operations WHERE id='old-write'").get().status,'done');
 await assert.rejects(store.write({library:library.id,relative:doc.relative,content:'automatic replay',expected:'new',origin:'automatic-maintenance',operationId:'automatic-replay'}),/已删除|显式新建/);
 await assert.rejects(store.write(initial),/已删除/);
 const recreated=await store.write({library:library.id,relative:doc.relative,content:'explicit new document',expected:'new'});assert.notEqual(recreated.id,doc.id);assert.ok(store.tombstone(doc.id));
 close();const reopened=new KnowledgeLibrary(root);try{assert.equal(reopened.read(recreated.id).content,'explicit new document');assert.equal(fs.existsSync(doc.path),true);assert.ok(reopened.tombstone(doc.id));}finally{reopened.close();}
});
