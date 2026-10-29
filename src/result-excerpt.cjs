// Bounded, deterministic excerpt of visible text. Never consumes thinking,
// tool output, images, or another model call.
function resultExcerpt(content,limit=240){
 let text='';const budget=Math.max(512,limit*4);
 if(typeof content==='string')text=content.slice(0,budget);
 else if(Array.isArray(content))for(const block of content){if(block?.type==='text'&&typeof block.text==='string')text+=block.text.slice(0,budget-text.length)+'\n';if(text.length>=budget)break;}
 text=text.replace(/```[\s\S]*?(?:```|$)/g,' ').replace(/!\[[^\]]*\]\([^)]*\)/g,' ').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/<[^>]*>/g,' ').replace(/^[\s#>*-]+/gm,'').replace(/[`*_~]/g,'').replace(/\s+/g,' ').trim();
 return text==='.'?'':text.length>limit?text.slice(0,limit-1)+'…':text;
}
module.exports={resultExcerpt};
