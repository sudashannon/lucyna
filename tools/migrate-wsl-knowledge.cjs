// Copy only the legacy index and bounded, registered document dependencies.
// Reports and user content are written to the user's data directory, never Git.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {KnowledgeRuntime}=require('../src/knowledge-runtime.cjs');
const {resolveDataRoot}=require('../src/data-root.cjs');
const {sensitiveDocument}=require('../src/work-knowledge-policy.cjs');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function download(url,limit=32*1024*1024,method='GET'){
 const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('源请求失败（'+response.status+'）');
 if(method==='HEAD')return {etag:response.headers.get('etag')};
 const parts=[];let size=0;for await(const part of response.body){size+=part.length;if(size>limit)throw Error('源文件超过迁移预算');parts.push(Buffer.from(part));}return {bytes:Buffer.concat(parts),etag:response.headers.get('etag')};
}
const within=(root,file)=>file===root||file.startsWith(root.replace(/\/$/,'')+'/');
const privatePath=file=>/(?:^|\/)(?:\.env(?:\.|$)|\.ssh(?:\/|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|auth\.json$)|\.(?:pem|key|pfx|p12)$/i.test(file);
async function migrate({directory,origin='http://127.0.0.1:18989',apply=false,fetchSource=download,onProgress=()=>{},runtime}={}){
 runtime=runtime||new KnowledgeRuntime(directory,{executable:require('electron')});
 const sourceURL=route=>new URL(route,origin);
 const jsonSource=async route=>JSON.parse((await fetchSource(sourceURL(route),16*1024*1024)).bytes.toString('utf8'));
 const workspaces=await jsonSource('/api/workspaces'),index=await jsonSource('/api/wiki/index');if(!Array.isArray(workspaces)||!Array.isArray(index))throw Error('原 Stele 索引格式无效');
 const spaces=new Map(workspaces.map(w=>[w.alias,{...w,root:path.posix.basename(w.path)==='openspec'?path.posix.dirname(w.path):w.path}]));
 const report={version:1,startedAt:new Date().toISOString(),source:origin,totalIndex:index.length,workspaces:workspaces.map(w=>({alias:w.alias,type:w.type,path:w.path})),documents:[],attachments:[],excluded:[],issues:[],mapping:{},rewrittenLinks:0,sourceChanged:[],copied:0,unchanged:0,failed:0};
 const sourceFiles=new Map(),documentByPath=new Map();
 const artifactURL=(file,space)=>sourceURL('/api/artifact?'+new URLSearchParams({path:file,workspace:space.alias}));
 async function load(file,space,type='attachment'){
  if(sourceFiles.has(file))return sourceFiles.get(file);
  if(!within(space.root,file)||privatePath(file))throw Error('来源越界或属于敏感配置');
  if(sourceFiles.size>=5000||[...sourceFiles.values()].reduce((n,e)=>n+e.bytes.length,0)>512*1024*1024)throw Error('超过单次迁移预算，请分批迁移');
  const result=await fetchSource(artifactURL(file,space),/\.(md|markdown)$/i.test(file)?2*1024*1024:32*1024*1024),isText=/\.(md|markdown|ya?ml|txt|json|csv|svg)$/i.test(file);
  if(isText){let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(result.bytes);}catch{throw Error('文本编码不是 UTF-8');}const sensitive=sensitiveDocument(text);if(sensitive)throw Error('疑似敏感内容：'+sensitive);}
  const entry={file,space,bytes:result.bytes,hash:digest(result.bytes),etag:result.etag,type,relative:path.posix.relative(space.root,file)};sourceFiles.set(file,entry);return entry;
 }
 for(const doc of index){
  const space=spaces.get(doc.workspace),file=doc.path;if(doc.type==='session'||/\.jsonl$/i.test(file)){report.excluded.push({workspace:doc.workspace,path:file,reason:'原生会话保留原件，不转为知识正文'});continue;}
  if(!space||typeof file!=='string'||!within(space.root,file)){report.excluded.push({workspace:doc.workspace,path:file,reason:'索引项超出注册来源范围'});continue;}
  if(!/\.(md|markdown|ya?ml)$/i.test(file)){report.excluded.push({workspace:doc.workspace,path:file,reason:'不支持的索引文件格式'});continue;}
  try{const entry=await load(file,space,/\.ya?ml$/i.test(file)?'workflow-metadata':'document');entry.nativeType=doc.type;entry.title=doc.title;documentByPath.set(file,entry);if(entry.type==='document')report.documents.push({workspace:space.alias,path:file,hash:entry.hash});else report.attachments.push({workspace:space.alias,path:file,kind:entry.type,hash:entry.hash});}
  catch(error){report.excluded.push({workspace:doc.workspace,path:file,reason:error.message});}
  if(report.documents.length%100===0)onProgress({stage:'scan',documents:report.documents.length,attachments:report.attachments.length});
 }
 const [{unified},{default:remarkParse}]=await Promise.all([import('unified'),import('remark-parse')]);
 const parser=unified().use(remarkParse),links=[],parsed=new Set(),attempted=new Set();
 async function parseLinks(entry){
  if(parsed.has(entry.file))return;parsed.add(entry.file);const before=links.length;
  const text=entry.bytes.toString('utf8'),tree=parser.parse(text);const visit=node=>{
   if(['link','image','definition'].includes(node.type)&&typeof node.url==='string'&&node.position){
    const href=node.url,raw=text.slice(node.position.start.offset,node.position.end.offset);let target;
    try{if(href.startsWith('doc://')){const u=new URL(href),space=spaces.get(u.hostname);if(space)target=path.posix.resolve(space.root,decodeURIComponent(u.pathname.slice(1)));}
     else if(href.startsWith('file:///'))target=decodeURIComponent(new URL(href).pathname);
     else if(!/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href))target=path.posix.resolve(path.posix.dirname(entry.file),decodeURIComponent(href.split(/[?#]/)[0]));
    }catch{}
    if(target){const start=node.type==='definition'?raw.indexOf(':')+1:raw.lastIndexOf('](')+2;const offset=raw.indexOf(href,start);links.push({entry,target,href,image:node.type==='image',offset:offset<0?null:node.position.start.offset+offset});}
   }
   for(const child of node.children||[])visit(child);
  };visit(tree);
  for(const link of links.slice(before)){if(sourceFiles.has(link.target)||attempted.has(link.target))continue;attempted.add(link.target);
  const space=[...spaces.values()].filter(s=>within(s.root,link.target)).sort((a,b)=>b.root.length-a.root.length)[0];
  if(!space||!/\.(md|markdown|ya?ml|txt|png|jpe?g|gif|webp|svg|pdf|docx|xlsx|pptx)$/i.test(link.target)){report.issues.push({source:link.entry.file,target:link.target,reason:'外部或不支持的引用，仅保留原链接'});continue;}
  try{const entry=await load(link.target,space,/\.(md|markdown)$/i.test(link.target)?'linked-document':'attachment');report.attachments.push({workspace:space.alias,path:entry.file,kind:entry.type,hash:entry.hash});}
  catch(error){report.issues.push({source:link.entry.file,target:link.target,reason:error.message});}
  }
 }
 // Linked Markdown can itself reference figures or other documents. Walk to a
 // fixed point with a strict file/byte budget, rather than copying repositories.
 for(const entry of sourceFiles.values())if(/\.(md|markdown)$/i.test(entry.file))await parseLinks(entry);
 report.fileCount=sourceFiles.size;report.bytes=[...sourceFiles.values()].reduce((n,e)=>n+e.bytes.length,0);
 if(!apply){const destination=path.join(directory,'migrations','preview-'+crypto.randomUUID());await fs.mkdir(destination,{recursive:true});report.reportPath=path.join(destination,'report.json');await fs.writeFile(report.reportPath,JSON.stringify(report,null,2),{mode:0o600});return report;}
 await runtime.ensure();const savedLibraries=await runtime.call('/api/library/libraries'),targets=new Map();
 for(const space of spaces.values()){
  const alias='wsl-'+space.alias.replace(/[^a-z0-9_-]/gi,'-');let library=savedLibraries.find(l=>l.alias===alias);
  if(!library)library=await runtime.call('/api/library/libraries',{method:'POST',body:{name:'WSL · '+space.alias,alias}});targets.set(space.alias,library);
 }
 for(const entry of sourceFiles.values()){const library=targets.get(entry.space.alias);entry.library=library.id;entry.target=path.join(library.path,...entry.relative.split('/'));}
 const rewrites=new Map();
 for(const link of links){const target=sourceFiles.get(link.target);if(!target||link.offset===null)continue;let managed=target;
  if(link.image&&target.library!==link.entry.library){const relative='_legacy-assets/'+target.hash.slice(0,16)+'/'+path.posix.basename(target.file),key=link.entry.library+'\0'+relative;managed={...target,library:link.entry.library,relative,target:path.join(targets.get(link.entry.space.alias).path,...relative.split('/')),crossCopy:true};if(!sourceFiles.has(key))sourceFiles.set(key,managed);}
  const suffix=link.href.match(/[?#].*$/)?.[0]||'',replacement=path.relative(path.dirname(link.entry.target),managed.target).split(path.sep).join('/')+suffix;
  const list=rewrites.get(link.entry)||[];list.push({offset:link.offset,length:link.href.length,replacement});rewrites.set(link.entry,list);
 }
 for(const [entry,patches] of rewrites){let text=entry.bytes.toString('utf8');for(const patch of patches.sort((a,b)=>b.offset-a.offset)){text=text.slice(0,patch.offset)+patch.replacement+text.slice(patch.offset+patch.length);report.rewrittenLinks++;}entry.transferred=Buffer.from(text);}
 const entries=[...sourceFiles.values()],jobId=crypto.randomUUID();let batch=[],batchBytes=0;
 async function flush(){if(!batch.length)return;const result=await runtime.call('/api/library/batch',{method:'POST',body:{items:batch}});for(let i=0;i<result.items.length;i++){const item=result.items[i],source=batch[i].provenance;report.mapping[source.originalPath+(batch[i].provenance.crossCopy?'#'+batch[i].library:'')]={id:item.id,library:batch[i].library,relative:batch[i].relative,path:item.path,originalHash:source.originalHash,transferredHash:source.transferredHash,status:item.status,error:item.error};if(item.status==='failed')report.failed++;else if(item.status==='skipped')report.unchanged++;else report.copied++;}batch=[];batchBytes=0;onProgress({stage:'copy',copied:report.copied,unchanged:report.unchanged,failed:report.failed});}
 for(const entry of entries){const bytes=entry.transferred||entry.bytes;if(batch.length>=64||batchBytes+bytes.length>8*1024*1024)await flush();batch.push({library:entry.library,relative:entry.relative,base64:bytes.toString('base64'),expected:'new',operationId:'legacy:'+digest(entry.library+'\0'+entry.relative+'\0'+digest(bytes)),provenance:{kind:'legacy-wsl',source:origin,workspace:entry.space.alias,originalPath:entry.file,originalHash:entry.hash,transferredHash:digest(bytes),sourceETag:entry.etag,nativeType:entry.nativeType||entry.type,capturedAt:report.startedAt,crossCopy:!!entry.crossCopy,authority:'imported-source-not-reverified'}});batchBytes+=bytes.length;}await flush();
 const destination=path.join(directory,'migrations',jobId);await fs.mkdir(destination,{recursive:true});
 try{const archive=await fetchSource(sourceURL('/api/recovery/export'),32*1024*1024);await fs.writeFile(path.join(destination,'legacy-state-recovery.zip'),archive.bytes,{mode:0o600});report.stateBackup='legacy-state-recovery.zip';}catch(error){report.issues.push({reason:'原状态备份失败：'+error.message});}
 const catalog=await runtime.call('/api/wiki/index'),indexed=new Set(catalog.map(d=>d.path?.toLowerCase()));
 report.notIndexed=[];report.hashMismatches=[];report.destinationVerified=0;
 for(const entry of entries){const record=report.mapping[entry.file+(entry.crossCopy?'#'+entry.library:'')];if(!record||record.status==='failed')continue;if(/\.(md|markdown)$/i.test(entry.relative)&&!indexed.has(entry.target.toLowerCase()))report.notIndexed.push(entry.file);try{if(digest(await fs.readFile(entry.target))!==record.transferredHash)report.hashMismatches.push(entry.file);else report.destinationVerified++;}catch{report.hashMismatches.push(entry.file);}}
 let verified=0;report.sourceVersionVerified=0;for(const entry of entries.filter(e=>!e.crossCopy)){try{const current=await fetchSource(artifactURL(entry.file,entry.space),0,'HEAD');if(entry.etag&&current.etag){if(entry.etag!==current.etag)report.sourceChanged.push(entry.file);else report.sourceVersionVerified++;}}catch(error){report.issues.push({source:entry.file,reason:'复制后无法核对来源版本：'+error.message});}if(++verified%200===0)onProgress({stage:'verify',verified});}
 report.actualFiles=entries.length;report.completedAt=new Date().toISOString();report.destination=directory;report.reportPath=path.join(destination,'report.json');
 await fs.writeFile(report.reportPath,JSON.stringify(report,null,2),{mode:0o600});return report;
}
module.exports={migrate,download};
if(require.main===module){const args=process.argv.slice(2),at=args.indexOf('--data'),base=resolveDataRoot(process.env.LUCYNA_USERDATA||process.env.OMP_CINDY_USERDATA||path.join(process.env.APPDATA,'omp-cindy')),directory=at>=0?path.resolve(args[at+1]):path.join(base,'knowledge');migrate({directory,apply:args.includes('--apply'),onProgress:status=>process.stderr.write(JSON.stringify(status)+'\n')}).then(report=>{const summary={applied:args.includes('--apply'),sourceItems:report.totalIndex,markdown:report.documents.length,attachments:report.attachments.length,excluded:report.excluded.length,unresolvedLinks:report.issues.length,files:report.actualFiles||report.fileCount,copied:report.copied,unchanged:report.unchanged,failed:report.failed,notIndexed:report.notIndexed?.length,hashMismatches:report.hashMismatches?.length,sourceChanged:report.sourceChanged.length,destinationVerified:report.destinationVerified,reportPath:report.reportPath};process.stdout.write(JSON.stringify(summary)+'\n');if(report.failed||report.notIndexed?.length||report.hashMismatches?.length||report.sourceChanged.length)process.exitCode=2;}).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});}
