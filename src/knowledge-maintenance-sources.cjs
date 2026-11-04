const fs=require('node:fs'),path=require('node:path');
const {hash}=require('./knowledge-library.cjs');
const {snapshot}=require('./knowledge-consolidation.cjs');
const {sensitiveDocument}=require('./work-knowledge-policy.cjs');
const {MAX_DOCUMENT}=require('./knowledge-text-segments.cjs');
const MAX_TEXT=120000;
const SOURCE_POLICY=2;
const {links}=require('./knowledge-markdown-links.cjs');
function readRevision(store,id,revision){try{const row=store.db.prepare('SELECT * FROM revisions WHERE document=? AND id=?').get(id,revision);if(!row)return '';const b=fs.readFileSync(store.revisionPath(id,revision));return b.length<=MAX_DOCUMENT&&hash(b)===row.hash&&!sensitiveDocument(b.toString('utf8'))?b.toString('utf8'):'';}catch{return '';}}
async function inventory(store,consolidation){
 const docs=new Map(),byPath=new Map();let visited=0;
 const yieldBatch=async()=>{if(++visited%16===0)await new Promise(resolve=>setImmediate(resolve));};
 for(const row of store.db.prepare('SELECT * FROM documents ORDER BY id').all()){
  await yieldBatch();
  if(!/\.(md|markdown)$/i.test(row.relative))continue;
  let d;try{d=store.read(row.id);}catch{d={...store.describe(row),content:'',unavailable:true};}
  d.title=(/^#\s+(.+)$/m.exec(d.content)?.[1]||path.basename(d.relative)).slice(0,160);
  d.bytes=Buffer.byteLength(d.content);d.segmented=d.bytes>MAX_TEXT;
  d.issue=d.unavailable?'revision_unreadable':d.bytes>MAX_DOCUMENT?'document_limit':sensitiveDocument(d.content)?'sensitive':null;
  try{const stat=fs.lstatSync(d.path);if(!stat.isFile()||stat.isSymbolicLink())d.issue='unsafe_path';else if(hash(fs.readFileSync(d.path))!==d.hash)d.issue='projection_changed';}catch(error){d.issue=error.code==='ENOENT'?'file_missing':'file_unreadable';}
  d.readable=!d.issue;
  docs.set(d.id,d);byPath.set(path.resolve(d.path).toLowerCase(),d);
 }
 for(const a of store.db.prepare('SELECT path,document FROM document_path_aliases').all())if(docs.has(a.document))byPath.set(path.resolve(a.path).toLowerCase(),docs.get(a.document));
 const aliases=store.db.prepare('SELECT path,document FROM document_path_aliases').all(),workCache=new Map(),references=new Map(),warnings=[];
 const reasons={revision_unreadable:'保存的修订无法读取或校验，请核对修订文件',document_limit:'文档超过 2 MB 读取范围，请拆分后登记；未判为来源缺失',sensitive:'文档含疑似凭据，需脱敏后处理',unsafe_path:'原文路径不是普通文件，未自动处理',projection_changed:'原文与登记修订不同，请先核对外部修改',file_missing:'已登记的原文文件不存在',file_unreadable:'原文文件暂时无法读取'};
 for(const doc of docs.values()){
  await yieldBatch();
  if(!doc.readable){warnings.push({document:doc.id,title:doc.title,code:doc.issue,reason:reasons[doc.issue]});references.set(doc.id,[]);continue;}
  const sources=[];
  for(const url of await links(doc.content,{excludeQuotes:doc.provenance?.kind==='work-consolidation'})){
   if(!url||url.startsWith('#')||/^(?:https?:|mailto:|data:|\/\/)/i.test(url))continue;
   let target;try{const clean=decodeURIComponent(url.split(/[?#]/)[0]);if(/^[a-z][a-z0-9+.-]*:/i.test(clean)&&!path.isAbsolute(clean))continue;target=path.resolve(path.dirname(doc.path),clean);}catch{continue;}
   let source=byPath.get(target.toLowerCase());
   // Recover relative links only from registered original paths, never a fuzzy
   // basename match that could silently bind a different document.
   if(!source){const matches=new Map();for(const a of aliases.filter(a=>a.document===doc.id)){const oldTarget=path.resolve(path.dirname(a.path),decodeURIComponent(url.split(/[?#]/)[0])).toLowerCase(),found=byPath.get(oldTarget);if(found)matches.set(found.id,found);}if(matches.size===1)source=[...matches.values()][0];}
   if(source?.id===doc.id)continue;
   if(source)sources.push({key:source.id,document:source.id,label:source.title,revision:source.readable?source.revision:'unavailable:'+source.revision,hash:source.hash,content:source.readable?source.content:'',missing:!source.readable,issue:source.issue,reason:source.issue?reasons[source.issue]:undefined,path:source.path,url,canonical:path.resolve(source.path).toLowerCase()!==target.toLowerCase()});
   else if(/\.(md|markdown)$/i.test(target))sources.push({key:'missing:'+hash(target),label:url,revision:'missing',missing:true,issue:'unregistered_link',reason:'相对引用未匹配到已登记文档，请登记来源或修正链接',url});
  }
  if(doc.provenance?.kind==='work-consolidation'){
   const p=consolidation?.all().find(p=>p.root===doc.provenance.root),root=doc.provenance.root;
   if(p){if(!workCache.has(root))workCache.set(root,p.registered?await snapshot(p.directory).catch(()=>null):null);const current=workCache.get(root);
    for(const [relative,old] of Object.entries(p.sources)){
     const source=current?.files.find(f=>f.path===relative);
     sources.push({key:'work:'+hash(root+'\0'+relative),label:relative,root,revision:source?.hash||'unavailable',baseline:old.hash,hash:source?.hash,content:source?.content||'',missing:!source,quote:(old.facts||[]).map(f=>f.quote).join('\n')});
    }
   }
  }
  references.set(doc.id,[...new Map(sources.map(s=>[s.key,s])).values()]);
 }
 return {docs,references,warnings};
}
module.exports={inventory,links,readRevision,MAX_TEXT,MAX_DOCUMENT,SOURCE_POLICY};
