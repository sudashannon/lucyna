// Reorganize an offline COPY. The caller owns backup, validation and cutover.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),YAML=require('yaml'),{DatabaseSync}=require('node:sqlite');
const {rewriteLinks}=require('../src/knowledge-layout-links.cjs'),{remapEmbeddingCache}=require('../src/knowledge-layout-cache.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const categories=new Set(['知识','规范','计划','提案','任务','报告','设计','图表','资料','待分类']);
async function unify({directory,originalRoot}){
 const root=path.resolve(directory),original=path.resolve(originalRoot);if(root===original)throw Error('必须在隔离副本运行');
 const db=new DatabaseSync(path.join(root,'catalog.sqlite'));db.exec('PRAGMA foreign_keys=ON;');
 try{
  const libraries=db.prepare('SELECT l.*,f.folder FROM libraries l LEFT JOIN library_folders f ON f.library=l.id').all(),canonical=libraries.find(x=>x.alias==='personal');if(!canonical)throw Error('未找到主知识库');
  if(libraries.some(x=>x.folder==='@root'))throw Error('副本已经统一');
  for(const name of ['claims.json','review.json','todos.json'])if(fs.existsSync(path.join(root,'engine-state',name)))throw Error('检测到需要单独迁移的知识状态：'+name);
  const docs=db.prepare('SELECT * FROM documents').all(),libs=new Map(libraries.map(x=>[x.id,x])),origins=new Map(db.prepare('SELECT document,provenance FROM document_origins').all().map(x=>[x.document,JSON.parse(x.provenance)])),used=new Set(),items=[];
  const consolidationExists=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_consolidation'").get();
  const consolidation=consolidationExists?db.prepare('SELECT root,data FROM knowledge_consolidation').all():[];if(consolidation.some(x=>JSON.parse(x.data).pending))throw Error('存在尚未完成的知识沉淀写入，请先恢复后重试');
  const registered=new Set(docs.map(d=>{const lib=libs.get(d.library);if(!lib?.folder)throw Error('知识库目录登记不完整');return path.resolve(root,'libraries',lib.folder,'documents',...d.relative.split('/')).toLowerCase();}));
  function checkFiles(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw Error('知识目录中存在链接，请先核对');if(stat.isDirectory())checkFiles(file);else if(!stat.isFile()||!registered.has(path.resolve(file).toLowerCase()))throw Error('知识目录存在未登记文件，请先核对');}}
  for(const lib of libraries)if(lib.folder)checkFiles(path.join(root,'libraries',lib.folder,'documents'));
  for(const d of [...docs].sort((a,b)=>a.id.localeCompare(b.id))){const lib=libs.get(d.library);if(!lib||!lib.folder)throw Error('知识库目录登记不完整');const parts=d.relative.split('/'),cat=categories.has(parts[0])?parts.shift():(origins.get(d.id)?.kind==='work-consolidation'?'知识':'待分类'),base=parts.pop();if(!base)throw Error('无效文件名');const extension=path.posix.extname(base),stem=base.slice(0,base.length-extension.length);let name=base,target=cat+'/'+name;if(used.has(target.toLowerCase())){name=stem+'-'+d.id.slice(0,8)+extension;target=cat+'/'+name;}if(used.has(target.toLowerCase()))throw Error('目标文件名冲突');used.add(target.toLowerCase());items.push({id:d.id,library:d.library,from:d.relative,oldLogical:lib.folder+'/documents/'+d.relative,to:target,oldFolder:lib.folder});}
  const docById=new Map(docs.map(d=>[d.id,d])),mapping=new Map(items.map(i=>[i.oldLogical,i.to])),targetRoot=path.join(root,'unified-libraries');if(fs.existsSync(targetRoot))throw Error('目标目录已存在');fs.mkdirSync(targetRoot);
  const report={version:1,canonical:canonical.id,files:items.length,rewritten:0,unresolved:0,changed:0,items:[]},revisions=[];
  for(const i of items){const d=docById.get(i.id),file=path.join(root,'libraries',i.oldFolder,'documents',...i.from.split('/')),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('来源不是普通文件');const old=fs.readFileSync(file);if(hash(old)!==d.hash)throw Error('来源文件与版本记录不一致');let data=old;
   if(/\.(md|markdown)$/i.test(i.from)){const r=await rewriteLinks(old.toString('utf8'),{old:i.oldLogical,next:i.to},mapping);data=Buffer.from(r.content);report.rewritten+=r.rewritten;report.unresolved+=r.unresolved.length;}
   const target=path.join(targetRoot,...i.to.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data,{flag:'wx'});
   const digest=hash(data);if(digest!==d.hash){const id=crypto.randomUUID(),dir=path.join(root,'revisions',i.id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,id),data,{flag:'wx'});revisions.push({id,document:i.id,parent:d.revision,hash:digest});report.changed++;}report.items.push({...i,hash:digest});
  }
  for(const category of categories)fs.mkdirSync(path.join(targetRoot,category),{recursive:true});
  const cacheFile=path.join(root,'engine-state/wiki/embeddings.bin');if(fs.existsSync(cacheFile)){const paths=new Map(items.map(i=>[path.resolve(original,'libraries',i.oldFolder,'documents',...i.from.split('/')).toLowerCase(),path.join(original,'libraries',...i.to.split('/'))]));const c=remapEmbeddingCache(fs.readFileSync(cacheFile),paths);fs.writeFileSync(cacheFile,c.bytes);report.cacheRemapped=c.remapped;}
  db.exec('BEGIN IMMEDIATE');try{
   db.exec('CREATE TABLE IF NOT EXISTS library_redirects(old_id TEXT PRIMARY KEY,target TEXT NOT NULL REFERENCES libraries(id)); CREATE TABLE IF NOT EXISTS document_path_aliases(path TEXT PRIMARY KEY COLLATE NOCASE,document TEXT NOT NULL REFERENCES documents(id));');
   const tmp=db.prepare('UPDATE documents SET relative=? WHERE id=?');for(const i of items)tmp.run('__unify__/'+i.id,i.id);
   const revs=new Map(revisions.map(r=>[r.document,r])),addRevision=db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?)'),update=db.prepare('UPDATE documents SET library=?,relative=?,revision=?,hash=? WHERE id=?');
   const originGet=db.prepare('SELECT provenance FROM document_origins WHERE document=?'),originSet=db.prepare('INSERT INTO document_origins VALUES(?,?) ON CONFLICT(document) DO UPDATE SET provenance=excluded.provenance'),oldPath=db.prepare('INSERT OR IGNORE INTO document_path_aliases VALUES(?,?)');
   const earlierFile=path.join(root,'layout-migration-report.json'),earlier=fs.existsSync(earlierFile)?new Map(JSON.parse(fs.readFileSync(earlierFile)).items.map(x=>[x.id,x])):new Map();
   for(const i of report.items){const d=docById.get(i.id),rev=revs.get(i.id),lib=libs.get(i.library);if(rev)addRevision.run(rev.id,rev.document,rev.parent,rev.hash,new Date().toISOString(),'unify-categories');update.run(canonical.id,i.to,rev?.id||d.revision,i.hash,i.id);oldPath.run(path.join(original,'libraries',i.oldFolder,'documents',...i.from.split('/')),i.id);const before=earlier.get(i.id);if(before)oldPath.run(path.join(original,'libraries',before.library,'documents',...before.from.split('/')),i.id);const prior=originGet.get(i.id);let p=prior?JSON.parse(prior.provenance):{};p.previousLibrary={id:lib.id,alias:lib.alias,name:lib.name,relative:i.from};originSet.run(i.id,JSON.stringify(p));}
   const redirect=db.prepare('INSERT OR REPLACE INTO library_redirects VALUES(?,?)');for(const l of libraries)if(l.id!==canonical.id){redirect.run(l.id,canonical.id);redirect.run(l.alias,canonical.id);}
   if(consolidationExists){const save=db.prepare('UPDATE knowledge_consolidation SET data=? WHERE root=?');for(const row of consolidation){const state=JSON.parse(row.data);if(state.document){state.document.library=canonical.id;const rev=revs.get(state.document.id);if(rev&&state.document.revision===rev.parent)state.document.revision=rev.id;save.run(JSON.stringify(state),row.root);}}}
   db.prepare('UPDATE imports SET library=?').run(canonical.id);db.prepare('DELETE FROM library_folders').run();db.prepare('INSERT INTO library_folders VALUES(?,?)').run(canonical.id,'@root');db.prepare('UPDATE libraries SET name=? WHERE id=?').run('Lucyna 知识库',canonical.id);
   const itemById=new Map(report.items.map(i=>[i.id,i])),fix=db.prepare('UPDATE operations SET result=? WHERE id=?');for(const op of db.prepare('SELECT id,result FROM operations WHERE result IS NOT NULL').all()){const r=JSON.parse(op.result),i=itemById.get(r.id);if(!i)continue;r.library=canonical.id;r.workspace=canonical.alias;r.relative=i.to;r.path=path.join(original,'libraries',...i.to.split('/'));fix.run(JSON.stringify(r),op.id);}
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  const config=path.join(root,'engine-state/workspaces.yaml');if(fs.existsSync(config)){const cfg=YAML.parse(fs.readFileSync(config,'utf8')),aliases=new Set(libraries.map(l=>l.alias));cfg.workspaces=(cfg.workspaces||[]).filter(w=>!aliases.has(w.alias));cfg.workspaces.push({alias:canonical.alias,path:path.join(original,'libraries'),type:'docs'});fs.writeFileSync(config,YAML.stringify(cfg));}
  fs.renameSync(path.join(root,'libraries'),path.join(root,'before-unified-libraries'));fs.renameSync(targetRoot,path.join(root,'libraries'));fs.writeFileSync(path.join(root,'unify-report.json'),JSON.stringify(report,null,2));return {files:items.length,rewritten:report.rewritten,unresolved:report.unresolved,changed:report.changed,cacheRemapped:report.cacheRemapped};
 }finally{db.close();}
}
module.exports={unify};
