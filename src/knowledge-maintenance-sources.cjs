const fs=require('node:fs'),path=require('node:path');
const {hash}=require('./knowledge-library.cjs');
const {snapshot}=require('./knowledge-consolidation.cjs');
const {sensitiveDocument}=require('./work-knowledge-policy.cjs');
const MAX_TEXT=120000;
async function links(content){
 const [{unified},{default:parse}]=await Promise.all([import('unified'),import('remark-parse')]);
 const urls=[],definitions=new Map(),refs=[];
 function visit(node){if(node.type==='definition')definitions.set(node.identifier,node.url);if(node.type==='link'||node.type==='image')urls.push(node.url);if(node.type==='linkReference'||node.type==='imageReference')refs.push(node.identifier);for(const c of node.children||[])visit(c);}
 visit(unified().use(parse).parse(content));for(const r of refs)if(definitions.has(r))urls.push(definitions.get(r));return [...new Set(urls)];
}
function readRevision(store,id,revision){try{const row=store.db.prepare('SELECT * FROM revisions WHERE document=? AND id=?').get(id,revision);if(!row)return '';const b=fs.readFileSync(store.revisionPath(id,revision));return b.length<=MAX_TEXT&&hash(b)===row.hash&&!sensitiveDocument(b.toString('utf8'))?b.toString('utf8'):'';}catch{return '';}}
async function inventory(store,consolidation){
 const docs=new Map(),byPath=new Map();
 for(const row of store.db.prepare('SELECT * FROM documents ORDER BY id').all()){
  if(!/\.(md|markdown)$/i.test(row.relative))continue;
  let d;try{d=store.read(row.id);}catch{d={...store.describe(row),content:'',unavailable:true};}
  d.title=(/^#\s+(.+)$/m.exec(d.content)?.[1]||path.basename(d.relative)).slice(0,160);
  d.readable=!d.unavailable&&Buffer.byteLength(d.content)<=MAX_TEXT&&!sensitiveDocument(d.content);
  try{const stat=fs.lstatSync(d.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_TEXT||hash(fs.readFileSync(d.path))!==d.hash)d.readable=false;}catch{d.readable=false;}
  docs.set(d.id,d);byPath.set(path.resolve(d.path).toLowerCase(),d);
 }
 for(const a of store.db.prepare('SELECT path,document FROM document_path_aliases').all())if(docs.has(a.document))byPath.set(path.resolve(a.path).toLowerCase(),docs.get(a.document));
 const workCache=new Map(),references=new Map(),warnings=[];
 for(const doc of docs.values()){
  if(!doc.readable){warnings.push({document:doc.id,title:doc.title,reason:'原文不可读、与登记版本不一致、超过 120 KB 或含疑似凭据；未送入模型'});references.set(doc.id,[]);continue;}
  const sources=[];
  for(const url of await links(doc.content)){
   if(!url||url.startsWith('#')||/^(?:https?:|mailto:|data:|\/\/)/i.test(url))continue;
   let target;try{const clean=decodeURIComponent(url.split(/[?#]/)[0]);if(/^[a-z][a-z0-9+.-]*:/i.test(clean)&&!path.isAbsolute(clean))continue;target=path.resolve(path.dirname(doc.path),clean);}catch{continue;}
   const source=byPath.get(target.toLowerCase());
   if(source?.id===doc.id)continue;
   if(source)sources.push({key:source.id,document:source.id,label:source.title,revision:source.readable?source.revision:'unavailable:'+source.revision,hash:source.hash,content:source.readable?source.content:'',missing:!source.readable,path:source.path,url,canonical:path.resolve(source.path).toLowerCase()!==target.toLowerCase()});
   else if(/\.(md|markdown)$/i.test(target))sources.push({key:'missing:'+hash(target),label:url,revision:'missing',missing:true,url});
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
module.exports={inventory,links,readRevision,MAX_TEXT};
