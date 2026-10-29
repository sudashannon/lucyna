// Local presentation ranking and exact, version-bound excerpts. No model calls.
const stopWords=new Set(['的','了','和','与','是','在','我','我们','怎么','如何','什么','一下','原因','问题']);
function searchTerms(query){
  const words=[...new Intl.Segmenter('zh-CN',{granularity:'word'}).segment(query.toLowerCase())].filter(s=>s.isWordLike).map(s=>s.segment);
  // Domain terms such as 图传 are sometimes split into single characters by ICU.
  const phrases=query.match(/[\p{Script=Han}]{2,24}/gu)||[];
  return [...new Set([...words,...phrases].filter(w=>w.length>1&&!stopWords.has(w)))].slice(0,16);
}
function matchedTerms(value,terms){const text=String(value||'').toLowerCase();return terms.filter(term=>text.includes(term));}
function rankSearchResults(results,documents,query,workspace=''){
  const terms=searchTerms(query),byId=new Map(documents.map(d=>[d.id,d])),merged=new Map();
  for(const row of results)if(row.type!=='session'&&byId.get(row.id)?.type!=='session'&&(!workspace||row.workspace===workspace))merged.set(row.id,row);
  // Bring literal title/tag matches into view even if absent from semantic top-K.
  for(const doc of documents){
    if(doc.type==='session'||workspace&&doc.workspace!==workspace)continue;
    const tags=['tags','_derivedTags','_inheritedTags'].flatMap(k=>Array.isArray(doc.frontmatter?.[k])?doc.frontmatter[k]:[]).join(' ');
    if(matchedTerms(doc.title+' '+tags,terms).length&&!merged.has(doc.id))merged.set(doc.id,{...doc,reasons:['catalog-match'],rankScore:0});
  }
  return [...merged.values()].map((row,index)=>{
    const doc=byId.get(row.id),titleMatches=matchedTerms(row.title,terms);
    const metadata=['tags','_derivedTags','_inheritedTags'].flatMap(k=>Array.isArray(doc?.frontmatter?.[k])?doc.frontmatter[k]:[]).join(' ');
    const matches=matchedTerms(row.title+' '+metadata+' '+(row.evidence?.excerpt||''),terms);
    return {...row,updatedAt:doc?.updatedAt||row.updatedAt,matchedTerms:matches,keywordScore:titleMatches.length*4+matches.length,_order:index};
  }).sort((a,b)=>b.keywordScore-a.keywordScore||a._order-b._order).slice(0,80).map(({_order,...row})=>row);
}
function excerptFromSnapshot(content,query){
  const lines=content.split('\n'),terms=searchTerms(query);let start=0;
  if(lines[0]?.replace(/^\uFEFF/,'').trim()==='---'){
    const end=lines.findIndex((line,i)=>i>0&&line.trim()==='---');if(end>=0)start=end+1;
  }
  const usable=(line)=>!!line.trim()&&!/^\s*(#{1,6}\s|```|~~~|---\s*$)/.test(line);
  let best=-1,score=-1;
  for(let i=start;i<lines.length;i++){
    if(!usable(lines[i]))continue;
    const value=matchedTerms(lines[i],terms).length;
    if(value>score){score=value;best=i;}
  }
  if(best<0)return {excerpt:'',lineStart:undefined,lineEnd:undefined,matchedTerms:[],bodyMatch:false};
  // Select whole original lines so the citation exactly matches its line range.
  let end=best;while(end+1<lines.length&&end<best+2&&lines[end+1].trim()&&lines.slice(best,end+2).join('\n').length<=1600)end++;
  const excerpt=lines.slice(best,end+1).join('\n');
  return {excerpt,lineStart:best+1,lineEnd:end+1,matchedTerms:matchedTerms(excerpt,terms),bodyMatch:score>0};
}
module.exports={searchTerms,rankSearchResults,excerptFromSnapshot};
