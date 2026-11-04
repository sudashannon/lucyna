// Operates on an isolated, stopped COPY of a knowledge profile. Never switches
// the live profile. A caller must back up and verify before installing the copy.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const YAML=require('yaml');
const {DatabaseSync}=require('node:sqlite');
const {planLayout}=require('../src/knowledge-layout-plan.cjs');
const {rewriteLinks}=require('../src/knowledge-layout-links.cjs');
const {remapEmbeddingCache}=require('../src/knowledge-layout-cache.cjs');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const exists=f=>fs.existsSync(f);
async function restructure({directory,originalRoot,index}){
 const root=path.resolve(directory),oldRoot=path.resolve(originalRoot);
 if(root===oldRoot)throw Error('迁移必须在隔离副本中运行');
 const db=new DatabaseSync(path.join(root,'catalog.sqlite'));
 db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 try{
  if(db.prepare("SELECT name FROM sqlite_master WHERE name='library_folders'").get()&&db.prepare('SELECT count(*) n FROM library_folders').get().n)throw Error('副本已迁移，拒绝重复执行');
  const libraries=db.prepare('SELECT id,name,alias FROM libraries').all(),documents=db.prepare('SELECT * FROM documents').all().map(d=>({...d,libraryPath:path.join(oldRoot,'libraries',d.library,'documents')}));
  const plan=planLayout({libraries,documents,index}),docById=new Map(documents.map(d=>[d.id,d])),libraryById=new Map(plan.libraries.map(l=>[l.id,l]));
  const mapping=new Map(plan.items.map(i=>[i.library+'/documents/'+i.from, i.to.replace(/^([^/]+)\//,'$1/documents/')]));
  const report={version:1,libraries:plan.libraries.length,files:plan.items.length,rewritten:0,unresolved:0,changed:0,identical:0,items:[]};
  const destination=path.join(root,'new-libraries');if(exists(destination))throw Error('迁移目标已存在');fs.mkdirSync(destination);
  const revisions=[];
  for(const item of plan.items){
   const row=docById.get(item.id),oldFile=path.join(root,'libraries',item.library,'documents',...item.from.split('/'));
   const stat=fs.lstatSync(oldFile);if(!stat.isFile()||stat.isSymbolicLink())throw Error('来源不是普通文件：'+item.id);
   const oldBytes=fs.readFileSync(oldFile);if(digest(oldBytes)!==row.hash)throw Error('来源文件与登记版本不一致：'+item.id);
   let bytes=oldBytes;
   if(/\.(md|markdown)$/i.test(item.from)){
    const source={old:item.library+'/documents/'+item.from,next:item.to.replace(/^([^/]+)\//,'$1/documents/')};
    const rewritten=await rewriteLinks(oldBytes.toString('utf8'),source,mapping);bytes=Buffer.from(rewritten.content);report.rewritten+=rewritten.rewritten;report.unresolved+=rewritten.unresolved.length;
   }
   const [folder,...relativeParts]=item.to.split('/'),relative=relativeParts.join('/'),target=path.join(destination,folder,'documents',...relativeParts);
   fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});
   if(digest(bytes)!==row.hash){const revision=crypto.randomUUID(),dir=path.join(root,'revisions',row.id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,revision),bytes,{flag:'wx'});revisions.push({id:revision,document:row.id,parent:row.revision,hash:digest(bytes)});report.changed++;}else report.identical++;
   report.items.push({id:item.id,library:item.library,from:item.from,relative,hash:digest(bytes)});
  }
  for(const lib of plan.libraries)fs.mkdirSync(path.join(destination,lib.folder,'documents'),{recursive:true});
  const cacheFile=path.join(root,'engine-state','wiki','embeddings.bin');
  if(exists(cacheFile)){
   const paths=new Map(report.items.map(item=>{const lib=libraryById.get(item.library);return [path.resolve(oldRoot,'libraries',item.library,'documents',...item.from.split('/')).toLowerCase(),path.join(oldRoot,'libraries',lib.folder,'documents',...item.relative.split('/'))];}));
   const converted=remapEmbeddingCache(fs.readFileSync(cacheFile),paths);fs.writeFileSync(cacheFile,converted.bytes);report.cacheEntries=converted.entries;report.cacheRemapped=converted.remapped;
  }
  db.exec('BEGIN IMMEDIATE');try{
   db.exec('CREATE TABLE IF NOT EXISTS library_folders(library TEXT PRIMARY KEY REFERENCES libraries(id),folder TEXT NOT NULL UNIQUE COLLATE NOCASE);');
   const addFolder=db.prepare('INSERT INTO library_folders VALUES(?,?)'),update=db.prepare('UPDATE documents SET relative=?, revision=?, hash=? WHERE id=?'),addRevision=db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?)');
   for(const lib of plan.libraries)addFolder.run(lib.id,lib.folder);
   const revMap=new Map(revisions.map(r=>[r.document,r]));
   for(const item of report.items){const row=docById.get(item.id),rev=revMap.get(item.id);if(rev)addRevision.run(rev.id,rev.document,rev.parent,rev.hash,new Date().toISOString(),'directory-migration');update.run(item.relative,rev?.id||row.revision,item.hash,item.id);}
   const fix=db.prepare('UPDATE operations SET result=? WHERE id=?');
   for(const op of db.prepare("SELECT id,result FROM operations WHERE result IS NOT NULL").all()){
    let result;try{result=JSON.parse(op.result);}catch{throw Error('操作记录格式无效');}const item=report.items.find(x=>x.id===result.id);if(!item)continue;const lib=libraryById.get(item.library);result.path=path.join(oldRoot,'libraries',lib.folder,'documents',...item.relative.split('/'));result.relative=item.relative;fix.run(JSON.stringify(result),op.id);
   }
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  const config=path.join(root,'engine-state','workspaces.yaml');if(exists(config)){const data=YAML.parse(fs.readFileSync(config,'utf8'));for(const ws of data.workspaces||[]){const lib=plan.libraries.find(x=>x.alias===ws.alias);if(lib)ws.path=path.join(oldRoot,'libraries',lib.folder,'documents');}fs.writeFileSync(config,YAML.stringify(data));}
  fs.renameSync(path.join(root,'libraries'),path.join(root,'previous-libraries'));
  fs.renameSync(destination,path.join(root,'libraries'));
  fs.writeFileSync(path.join(root,'layout-migration-report.json'),JSON.stringify(report,null,2));
  return {libraries:report.libraries,files:report.files,rewritten:report.rewritten,unresolved:report.unresolved,changed:report.changed,identical:report.identical};
 }finally{db.close();}
}
module.exports={restructure};
