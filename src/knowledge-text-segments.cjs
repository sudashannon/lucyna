const MAX_SEGMENT=60000,MAX_DOCUMENT=2*1024*1024;
// Exact slices with offsets: no text is discarded and UTF-16 pairs stay intact.
function segments(content,limit=MAX_SEGMENT){
 const result=[];let start=0;
 while(start<content.length){let end=Math.min(content.length,start+limit);
  while(Buffer.byteLength(content.slice(start,end))>limit)end=start+Math.max(1,Math.floor((end-start)*.8));
  if(end<content.length){const newline=content.lastIndexOf('\n',end-1);if(newline>start+(end-start)/2)end=newline+1;if(/[\uD800-\uDBFF]/.test(content[end-1]))end--;}
  result.push({start,end,content:content.slice(start,end),lineStart:content.slice(0,start).split('\n').length});start=end;
 }
 return result.length?result:[{start:0,end:0,content:'',lineStart:1}];
}
function terms(text){return new Set((text.toLowerCase().match(/[a-z0-9_-]{3,}|[\u4e00-\u9fff]{2}/g)||[]).slice(0,3000));}
function excerpt(content,query,limit=MAX_SEGMENT){
 if(Buffer.byteLength(content)<=limit)return {content,partial:false};
 const words=terms(query),parts=segments(content,Math.floor(limit/4)),ranked=parts.map((p,index)=>({...p,index,score:[...terms(p.content)].filter(w=>words.has(w)).length})).sort((a,b)=>b.score-a.score||a.index-b.index);
 const chosen=[parts[0],...ranked.filter(p=>p.start!==0).slice(0,2)].sort((a,b)=>a.start-b.start);
 return {content:chosen.map(p=>p.content).join('\n\n[中间段落未包含；不得据此判断全文没有其他限制]\n\n'),partial:true,ranges:chosen.map(({start,end,lineStart})=>({start,end,lineStart}))};
}
module.exports={segments,excerpt,MAX_SEGMENT,MAX_DOCUMENT};
