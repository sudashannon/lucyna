const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {HistoryTrash}=require('../src/history-trash.cjs');
test('client deletion persists and restores without modifying journals; concurrent operations are retained',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-trash-')),file=path.join(directory,'session.jsonl'),content='{"type":"session","id":"original"}\n';
 try{
  await fs.writeFile(file,content);const trash=new HistoryTrash(directory);
  const [key]=await Promise.all([trash.put('/a',file,{title:'original'}),trash.put('/b',file,{title:'other work'})]);
  assert.equal((await trash.list('/a')).length,1);assert.equal((await trash.list('/b')).length,1);assert.equal(await fs.readFile(file,'utf8'),content);
  const reopened=new HistoryTrash(directory);assert.equal((await reopened.list('/a'))[0].key,key);await reopened.restore('/b',key);assert.equal((await reopened.list('/a')).length,1);
  await reopened.restore('/a',key);assert.equal((await reopened.list('/a')).length,0);assert.equal((await reopened.list('/b')).length,1);assert.equal(await fs.readFile(file,'utf8'),content);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('WSL alias paths identify the same journal while Linux case is preserved',()=>{
 const trash=new HistoryTrash('.');assert.equal(trash.key('/a','/home/user/Test.jsonl'),trash.key('/a','\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\Test.jsonl'));
 assert.notEqual(trash.key('/a','/home/user/Test.jsonl'),trash.key('/a','/home/user/test.jsonl'));
});
