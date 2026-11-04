const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {classifyWorkAsset,sensitiveDocument}=require('./work-knowledge-policy.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
const inside=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
const safeRelative=value=>{if(typeof value!=='string'||!value||value.length>1000||/[\0<>:"|?*]/.test(value)||value.includes('\\')||value.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)))throw failure('无效的库内相对路径');return value;};
const etag=bytes=>'"'+hash(bytes)+'"';
async function boundedRead(file,limit){const handle=await fsp.open(file,'r');try{const stat=await handle.stat();if(!stat.isFile()||stat.size>limit)throw failure('文件超过读取预算或不是普通文件',413);const chunks=[];let length=0;for(;;){const chunk=Buffer.alloc(Math.min(64*1024,limit-length+1));const {bytesRead}=await handle.read(chunk,0,chunk.length,null);if(!bytesRead)break;length+=bytesRead;if(length>limit)throw failure('读取期间文件超过大小限制',413);chunks.push(chunk.subarray(0,bytesRead));}return Buffer.concat(chunks);}finally{await handle.close();}}
class KnowledgeLibrary {
 constructor(directory){
  this.root=path.resolve(directory);fs.mkdirSync(this.root,{recursive:true});if(fs.lstatSync(this.root).isSymbolicLink())throw failure('知识库数据目录不能是链接');
  this.db=new DatabaseSync(path.join(this.root,'catalog.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  this.db.exec(`CREATE TABLE IF NOT EXISTS libraries(id TEXT PRIMARY KEY,name TEXT NOT NULL,alias TEXT UNIQUE NOT NULL,created TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,library TEXT NOT NULL REFERENCES libraries(id),relative TEXT NOT NULL COLLATE NOCASE,revision TEXT NOT NULL,hash TEXT NOT NULL,UNIQUE(library,relative));
   CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,document TEXT NOT NULL,parent TEXT,hash TEXT NOT NULL,created TEXT NOT NULL,origin TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,signature TEXT NOT NULL,status TEXT NOT NULL,result TEXT);
   CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,source TEXT NOT NULL,library TEXT NOT NULL,created TEXT NOT NULL,manifest TEXT NOT NULL,result TEXT);
   CREATE TABLE IF NOT EXISTS library_folders(library TEXT PRIMARY KEY REFERENCES libraries(id),folder TEXT NOT NULL UNIQUE COLLATE NOCASE);
   CREATE TABLE IF NOT EXISTS library_redirects(old_id TEXT PRIMARY KEY, target TEXT NOT NULL REFERENCES libraries(id));
   CREATE TABLE IF NOT EXISTS document_path_aliases(path TEXT PRIMARY KEY COLLATE NOCASE,document TEXT NOT NULL REFERENCES documents(id));`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS document_origins(document TEXT PRIMARY KEY,provenance TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS work_materials(id TEXT PRIMARY KEY,work_key TEXT NOT NULL,root TEXT NOT NULL,relative TEXT NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,category TEXT NOT NULL,revision TEXT NOT NULL,metadata TEXT NOT NULL,UNIQUE(work_key,relative));
   CREATE TABLE IF NOT EXISTS work_material_versions(id TEXT PRIMARY KEY,material TEXT NOT NULL,hash TEXT,created TEXT NOT NULL,metadata TEXT NOT NULL);`);
  this.queue=Promise.resolve();this.importJobs=new Map();this.recover();
  if(!this.list().length)this.create('个人知识库','personal');
 }
 close(){this.db.close();}
 serial(fn){const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;}
 directory(library){const row=this.db.prepare('SELECT folder FROM library_folders WHERE library=?').get(library);return row?.folder==='@root'?path.join(this.root,'libraries'):path.join(this.root,'libraries',row?.folder||library,'documents');}
 isUnified(){return !!this.db.prepare("SELECT 1 FROM library_folders WHERE folder='@root'").get();}
 list(){return this.db.prepare("SELECT l.*, (SELECT count(*) FROM documents d WHERE d.library=l.id AND (lower(d.relative) LIKE '%.md' OR lower(d.relative) LIKE '%.markdown')) AS documents FROM libraries l WHERE NOT EXISTS (SELECT 1 FROM library_redirects r WHERE r.old_id=l.id) ORDER BY created").all().map(row=>({...row,path:this.directory(row.id)}));}
 get(id){const old=this.db.prepare('SELECT target FROM library_redirects WHERE old_id=?').get(id);const row=this.list().find(row=>row.id===(old?.target||id)||row.alias===id);if(!row)throw failure('知识库不存在',404);return row;}
 create(name,alias){
  if(this.isUnified())throw failure('知识库已经统一管理，请选择文档类别');
  if(typeof name!=='string'||!name.trim()||name.length>120)throw failure('请输入知识库名称');
  const id=randomUUID();alias=alias||'library-'+id.slice(0,12);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(alias))throw failure('知识库标识无效');
  let folder=name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').replace(/[. ]+$/,'').slice(0,80);if(!folder||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(folder))folder=alias;
  const base=folder;let suffix=0;while(this.db.prepare('SELECT 1 FROM library_folders WHERE folder=? COLLATE NOCASE').get(folder)||fs.existsSync(path.join(this.root,'libraries',folder)))folder=base+'-'+(++suffix);
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO libraries VALUES(?,?,?,?)').run(id,name.trim(),alias,new Date().toISOString());this.db.prepare('INSERT INTO library_folders VALUES(?,?)').run(id,folder);fs.mkdirSync(this.directory(id),{recursive:true});this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}return this.get(id);
 }
 doc(identity){const row=this.db.prepare('SELECT * FROM documents WHERE id=?').get(identity)||this.db.prepare('SELECT d.* FROM document_path_aliases a JOIN documents d ON d.id=a.document WHERE a.path=? COLLATE NOCASE').get(String(identity));if(row)return row;for(const lib of this.list()){const target=path.resolve(String(identity));if(inside(lib.path,target)){return this.db.prepare('SELECT * FROM documents WHERE library=? AND relative=?').get(lib.id,path.relative(lib.path,target).split(path.sep).join('/'));}}return null;}
 describe(doc){const lib=this.get(doc.library);return {...doc,path:path.join(lib.path,...doc.relative.split('/')),workspace:lib.alias,libraryName:lib.name};}
 read(identity){const doc=this.doc(identity);if(!doc)throw failure('内部文档不存在',404);const revision=this.db.prepare('SELECT * FROM revisions WHERE id=?').get(doc.revision),bytes=fs.readFileSync(this.revisionPath(doc.id,revision.id));if(hash(bytes)!==revision.hash)throw failure('文档版本校验失败',500);const origin=this.db.prepare('SELECT provenance FROM document_origins WHERE document=?').get(doc.id);return {...this.describe(doc),content:bytes.toString('utf8'),etag:etag(bytes),...(origin?{provenance:JSON.parse(origin.provenance)}:{})};}
 history(identity){const doc=this.doc(identity);if(!doc)throw failure('内部文档不存在',404);return this.db.prepare('SELECT id,parent,hash,created,origin FROM revisions WHERE document=? ORDER BY rowid DESC').all(doc.id);}
 revisionPath(document,revision){return path.join(this.root,'revisions',document,revision);}
 atomic(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
 recover(){for(const operation of this.db.prepare("SELECT * FROM operations WHERE status='committed'").all()){const result=JSON.parse(operation.result),bytes=fs.readFileSync(this.revisionPath(result.id,result.revision));if(fs.existsSync(result.path)){const current=fs.readFileSync(result.path),currentHash=hash(current);if(currentHash!==hash(bytes)&&currentHash!==result.previousHash)this.atomic(path.join(this.root,'recovery-conflicts',randomUUID()),current);}this.atomic(result.path,bytes);this.db.prepare("UPDATE operations SET status='done' WHERE id=?").run(operation.id);}this.db.exec("DELETE FROM operations WHERE status='prepared'");}
 write(input){return this.serial(()=>this.writeSync(input));}
 writeSync({library,relative,document,category,content,bytes,expected,operationId=randomUUID(),origin='ui',provenance,syncIdentity}){
  const lib=this.get(library||this.doc(document)?.library);let name=safeRelative(relative||this.doc(document)?.relative);
  if(this.isUnified()&&!document){const allowed=['知识','规范','计划','提案','任务','报告','设计','图表','资料','待分类'],prefix=name.split('/')[0];if(category&&!allowed.includes(category))throw failure('请选择有效的文档类别');if(category&&allowed.includes(prefix)&&prefix!==category)throw failure('文档路径与所选类别不一致');if(category&&!allowed.includes(prefix))name=safeRelative(category+'/'+name);else if(!allowed.includes(prefix))name=safeRelative('待分类/'+name);}
  const data=bytes?Buffer.from(bytes):Buffer.from(typeof content==='string'?content:'');if(data.length>32*1024*1024||/\.md$/i.test(name)&&data.length>2*1024*1024)throw failure('文件超过导入或正文大小限制',413);
  if(/\.(md|markdown|txt)$/i.test(name)){try{new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw failure('文本文档必须使用有效 UTF-8 编码');}}
  const signature=hash(JSON.stringify({library:lib.id,relative:name,hash:hash(data),expected}));
  const prior=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);if(prior){if(prior.signature!==signature)throw failure('操作标识已用于其他内容',409);if(prior.status==='done')return JSON.parse(prior.result);throw failure('此操作需要先恢复核对',409);}
  const current=this.db.prepare('SELECT * FROM documents WHERE library=? AND relative=?').get(lib.id,name);
  if(current){const old=this.read(current.id);if(fs.existsSync(old.path)&&hash(fs.readFileSync(old.path))!==current.hash)throw failure('内部文件在应用外发生变化，请先核对；原文件已保留',409);if(expected!==current.revision&&expected!==old.etag)throw failure('文档已变化，请重新读取版本后保存',412);}
  else if(expected&&expected!=='new')throw failure('原文档已不存在',412);
  const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  if(syncIdentity&&(origin!=='sync'||!uuid(syncIdentity.document)||!uuid(syncIdentity.revision)||current&&current.id!==syncIdentity.document||!current&&this.doc(syncIdentity.document)||this.db.prepare('SELECT 1 FROM revisions WHERE id=?').get(syncIdentity.revision)))throw failure('同步文档标识或版本标识冲突',409);
  const id=current?.id||syncIdentity?.document||randomUUID(),revision=syncIdentity?.revision||randomUUID(),file=path.join(lib.path,...name.split('/'));
  // Managed projections cannot cross symlinks, including directory junctions.
  for(let p=path.dirname(file);p!==this.root;p=path.dirname(p)){if(!inside(this.root,p))throw failure('文档路径越界',403);if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw failure('知识目录不能包含链接',403);}
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw failure('文档不能是链接',403);
  if(!current&&fs.existsSync(file))throw failure('目标文件已存在，需先核对',409);
  this.db.prepare('INSERT INTO operations VALUES(?,?,?,NULL)').run(operationId,signature,'prepared');
  this.atomic(this.revisionPath(id,revision),data);
  const result={id,library:lib.id,relative:name,path:file,workspace:lib.alias,revision,etag:etag(data),bytes:data.length,...(current?{previousHash:current.hash}:{})};
  this.db.exec('BEGIN IMMEDIATE');try{
   this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?)').run(revision,id,current?.revision||null,hash(data),new Date().toISOString(),origin);
   this.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,hash=excluded.hash').run(id,lib.id,name,revision,hash(data));
   if(provenance){const encoded=JSON.stringify(provenance);if(encoded.length>32768)throw failure('来源元数据过大');this.db.prepare('INSERT INTO document_origins VALUES(?,?) ON CONFLICT(document) DO UPDATE SET provenance=excluded.provenance').run(id,encoded);}
   this.db.prepare("UPDATE operations SET status='committed',result=? WHERE id=?").run(JSON.stringify(result),operationId);this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  this.atomic(file,data);this.db.prepare("UPDATE operations SET status='done' WHERE id=?").run(operationId);if(origin!=='sync'&&this.onWrite)try{this.onWrite(result);}catch{}return result;
 }
 workKey(root){if(typeof root!=='string'||!root.startsWith('/')||/[\0\r\n]/.test(root))throw failure('无效 Work 身份');return hash('wsl-work\0'+root);}
 listWork(root,q=''){const key=this.workKey(root);return this.db.prepare('SELECT * FROM work_materials WHERE work_key=? ORDER BY rowid DESC').all(key).map(row=>({...row,metadata:JSON.parse(row.metadata)})).filter(row=>!q||(row.title+' '+row.relative).toLowerCase().includes(String(q).toLowerCase()));}
 captureWork({root,relative,title,kind,policy,sourceHash,sourceSize,content,bytes,locator}){return this.serial(()=>{
  safeRelative(relative);policy=classifyWorkAsset({path:relative,kind,size:sourceSize,directory:policy?.category==='reference'});if(!policy.allowed)throw failure(policy.reason);const key=this.workKey(root),old=this.db.prepare('SELECT * FROM work_materials WHERE work_key=? AND relative=?').get(key,relative),id=old?.id||randomUUID(),revision=randomUUID();
  const data=bytes?Buffer.from(bytes):typeof content==='string'?Buffer.from(content):null;
  if(data&&data.length>10*1024*1024)throw failure('工作资料快照超过上限');
  if(data&&!policy.snapshot)throw failure('此资产仅登记引用，不保存正文');
  if(policy.snapshot&&!data)throw failure('缺少工作资料快照');
  if(data&&sourceHash&&hash(data)!==sourceHash)throw failure('资产内容与来源摘要不一致');
  if(data&&['note','log'].includes(kind)){if(data.length>2*1024*1024)throw failure('工作文本超过上限');let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw failure('工作文本必须使用 UTF-8 编码');}if(sensitiveDocument(text))throw failure('内容含疑似访问凭据或私钥，请脱敏后再保存');}
  if(old){const prior=JSON.parse(old.metadata);if(prior.hash===(data?hash(data):null)&&prior.sourceHash===(sourceHash||null)&&JSON.stringify(prior.locator)===JSON.stringify(locator))return this.listWork(root).find(item=>item.id===id);}
  const metadata={sourceHash:sourceHash||null,sourceSize,locator,policy,createdAt:new Date().toISOString(),snapshot:!!data,hash:data?hash(data):null,unverified:true};
  if(data)this.atomic(path.join(this.root,'work-materials',key,id,revision),data);
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO work_material_versions VALUES(?,?,?,?,?)').run(revision,id,metadata.hash,metadata.createdAt,JSON.stringify(metadata));this.db.prepare('INSERT INTO work_materials VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,category=excluded.category,revision=excluded.revision,metadata=excluded.metadata').run(id,key,root,relative,title||relative,kind,policy.category,revision,JSON.stringify(metadata));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  return this.listWork(root).find(item=>item.id===id);
 });}
 readWork(root,id){const row=this.listWork(root).find(item=>item.id===id);if(!row)throw failure('资料不属于此 Work',404);if(!row.metadata.snapshot)return {...row,content:null};const bytes=fs.readFileSync(path.join(this.root,'work-materials',row.work_key,row.id,row.revision));if(hash(bytes)!==row.metadata.hash)throw failure('工作资料快照校验失败',500);return {...row,content:/\.(md|txt|markdown)$/i.test(row.relative)?bytes.toString('utf8'):null,base64:/\.(md|txt|markdown)$/i.test(row.relative)?undefined:bytes.toString('base64')};}
 async scan(source,library){
  const lib=this.get(library),root=await fsp.realpath(source),info=await fsp.lstat(source);if(!info.isDirectory()||info.isSymbolicLink())throw failure('请选择普通知识库目录');
  const files=[],skipped=[];let total=0;
  const excluded=new Set(['.git','node_modules','.runtime','.stele','__pycache__']);
  const walk=async(folder)=>{for(const entry of await fsp.readdir(folder,{withFileTypes:true})){
   const file=path.join(folder,entry.name),relative=path.relative(root,file).split(path.sep).join('/');
   if(excluded.has(entry.name)||/^\.env(?:\.|$)|\.(?:pem|key|pfx|p12)$/i.test(entry.name)||file===this.root||inside(this.root,file)){skipped.push({relative,reason:'排除的配置或运行目录'});continue;}
   const stat=await fsp.lstat(file);if(stat.isSymbolicLink()){skipped.push({relative,reason:'跳过符号链接或目录联接'});continue;}
   if(stat.isDirectory()){await walk(file);continue;}if(!stat.isFile())continue;
   if(!/\.(md|markdown|txt|png|jpe?g|gif|webp|svg|pdf|docx|xlsx|pptx)$/i.test(relative)){skipped.push({relative,reason:'暂不支持的格式'});continue;}
   try{safeRelative(relative);}catch(error){skipped.push({relative,reason:error.message});continue;}
   if(files.length>=5000||stat.size>(/\.(md|markdown)$/i.test(relative)?2:32)*1024*1024||total+stat.size>512*1024*1024){skipped.push({relative,reason:'超过单次导入预算'});continue;}
   const data=await boundedRead(file,stat.size);if(data.length!==stat.size)throw failure('扫描期间来源发生变化，请重新扫描',409);total+=data.length;
   files.push({relative,size:data.length,hash:hash(data),markdown:/\.(md|markdown)$/i.test(relative)});
  }};await walk(root);
  if(!files.some(f=>f.markdown))throw failure('目录中未找到可索引的 Markdown 文档');
  const id=randomUUID();this.db.prepare('INSERT INTO imports VALUES(?,?,?,?,?,NULL)').run(id,root,lib.id,new Date().toISOString(),JSON.stringify(files));
  return {id,library:lib.id,source:root,files,skipped,totalBytes:total};
 }
 executeImport(id){if(this.importJobs.has(id))return this.importJobs.get(id);const job=this.runImport(id).finally(()=>this.importJobs.delete(id));this.importJobs.set(id,job);return job;}
 async runImport(id){
  const job=this.db.prepare('SELECT * FROM imports WHERE id=?').get(id);if(!job)throw failure('导入预览不存在',404);if(job.result)return JSON.parse(job.result);
  const items=[];for(const file of JSON.parse(job.manifest)){
   try{
    const source=path.join(job.source,...file.relative.split('/')),resolved=await fsp.realpath(source);
    if(!inside(job.source,resolved))throw failure('来源已越出导入目录',403);
    const stat=await fsp.lstat(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.size)throw failure('来源已变化',409);
    const bytes=await boundedRead(source,file.size);if(hash(bytes)!==file.hash)throw failure('来源内容已变化，请重新扫描',409);
    const destination=this.isUnified()?'待分类/导入/'+id+'/'+file.relative:file.relative;
    const current=this.db.prepare('SELECT * FROM documents WHERE library=? AND relative=?').get(job.library,destination);
    if(current){if(current.hash===file.hash){items.push({relative:file.relative,status:'skipped'});continue;}throw failure('内部已存在不同版本，请保留现有内容并另行核对',409);}
    const result=await this.write({library:job.library,relative:destination,bytes,expected:'new',operationId:'import:'+id+':'+file.relative,origin:'import'});items.push({...result,status:'imported'});
   }catch(error){items.push({relative:file.relative,status:'failed',error:error.message});}
  }
  const result={id,library:job.library,items,imported:items.filter(i=>i.status==='imported').length,skipped:items.filter(i=>i.status==='skipped').length,failed:items.filter(i=>i.status==='failed').length};
  this.db.prepare('UPDATE imports SET result=? WHERE id=?').run(JSON.stringify(result),id);return result;
 }
}
module.exports={KnowledgeLibrary,hash,etag,inside,safeRelative,failure};
