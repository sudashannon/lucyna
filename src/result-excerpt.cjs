// Bounded, deterministic excerpt of visible text. Never consumes thinking,
// tool output, images, or another model call.
function visibleText(content,limit){
 let text='';const budget=Math.max(512,limit*4);
 if(typeof content==='string')text=content.slice(0,budget);
 else if(Array.isArray(content))for(const block of content){if(block?.type==='text'&&typeof block.text==='string')text+=block.text.slice(0,budget-text.length)+'\n';if(text.length>=budget)break;}
 return text;
}
function excerpt(text,limit){
 text=text.replace(/```[\s\S]*?(?:```|$)/g,' ').replace(/!\[[^\]]*\]\([^)]*\)/g,' ').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/<[^>]*>/g,' ').replace(/^[\s#>*-]+/gm,'').replace(/[`*_~]/g,'').replace(/\s+/g,' ').trim();
 return text==='.'?'':text.length>limit?text.slice(0,limit-1)+'…':text;
}
function resultExcerpt(content,limit=240){return excerpt(visibleText(content,limit),limit);}
// Navigation labels are plain text. Keep prose and point table-only entries at
// their source message without squeezing the table syntax into a one-line label.
function navigationExcerpt(content,limit=240){
 const lines=visibleText(content,limit).replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,' ').split(/\r?\n/);
 const divider=/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
 const prose=[];
 let table=false;
 for(let index=0;index<lines.length;index++){
  const line=lines[index];
  if(line.includes('|')&&divider.test(lines[index+1]||'')){
   table=true;index++;
   while(lines[index+1]?.includes('|'))index++;
  }else if(/^\s*\|.*(?<!\\)\|/.test(line))table=true;
  else prose.push(line);
 }
 return excerpt(prose.join('\n'),limit)||(table?'表格':'');
}
module.exports={resultExcerpt,navigationExcerpt};
