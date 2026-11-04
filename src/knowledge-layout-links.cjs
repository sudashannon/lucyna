const path=require('node:path');

// Rewrite Markdown destinations only; source text is left byte-for-byte intact
// apart from destinations that map to managed files. Unknown links are reported.
async function rewriteLinks(content,source,mapping){
 const [{unified},{default:remarkParse}]=await Promise.all([import('unified'),import('remark-parse')]);
 const tree=unified().use(remarkParse).parse(content),patches=[],unresolved=[];
 function visit(node){
  if(['link','image','definition'].includes(node.type)&&typeof node.url==='string'&&node.position){
   const url=node.url;
   if(!/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(url)){
    try{
     const match=/^([^?#]*)([?#].*)?$/.exec(url),oldTarget=path.posix.normalize(path.posix.join(path.posix.dirname(source.old),decodeURIComponent(match[1]))),target=mapping.get(oldTarget);
     if(target){
      const relative=path.posix.relative(path.posix.dirname(source.next),target)||path.posix.basename(target);
      const replacement=relative.split('/').map(segment=>encodeURIComponent(segment)).join('/')+(match[2]||'');
      const raw=content.slice(node.position.start.offset,node.position.end.offset),offset=raw.indexOf(url,node.type==='definition'?raw.indexOf(':')+1:raw.lastIndexOf('](')+2);
      if(offset<0)unresolved.push(url);else patches.push({at:node.position.start.offset+offset,length:url.length,value:replacement});
     }else unresolved.push(url);
    }catch{unresolved.push(url);}
   }
  }
  for(const child of node.children||[])visit(child);
 }
 visit(tree);let result=content;for(const p of patches.sort((a,b)=>b.at-a.at))result=result.slice(0,p.at)+p.value+result.slice(p.at+p.length);
 return {content:result,rewritten:patches.length,unresolved};
}
module.exports={rewriteLinks};
