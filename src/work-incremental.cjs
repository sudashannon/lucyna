const {createHash}=require('node:crypto');

const sourceKey=row=>JSON.stringify([row.sessionId,row.messageId||row.id]);
const sourceHash=row=>createHash('sha256').update(JSON.stringify([row.role,row.text])).digest('hex');
const normalize=value=>String(value||'').normalize('NFKC').toLowerCase();
const stopWords=new Set(['the','and','with','from','this','that','work','session','please','相关','这个','进行','需要','问题','消息','会话','工作']);

function queryTerms(queries){
  const terms=new Map();
  const add=(term,weight)=>{if(!stopWords.has(term)&&term.length>1)terms.set(term,Math.max(weight,terms.get(term)||0));};
  for(const raw of queries.slice(0,3)){
    if(typeof raw!=='string'||!raw.trim()||raw.length>240)continue;
    const query=normalize(raw);
    for(const word of query.match(/[a-z0-9][a-z0-9_.:/-]+/g)||[])add(word,3);
    for(const phrase of query.match(/[\u3400-\u9fff]{2,}/g)||[]){
      add(phrase,Math.min(8,phrase.length));
      for(let index=0;index<phrase.length-1;index++)add(phrase.slice(index,index+2),1);
    }
  }
  return [...terms].slice(0,160);
}

// Search only the retained evidence supplied by the caller. Never pad the
// result with unrelated recent messages when a query has no matching evidence.
function findRelatedSources(allSources,{queries=[],excludeKeys=new Set(),maxMessages=8,maxChars=12000}={}){
  if(!Array.isArray(allSources)||!Array.isArray(queries))return [];
  const terms=queryTerms(queries);
  if(!terms.length)return [];
  const messageLimit=Math.max(0,Math.min(16,Math.floor(maxMessages)||0));
  let remaining=Math.max(0,Math.min(24000,Math.floor(maxChars)||0));
  const unique=new Map();
  for(const row of allSources){
    if(!row||!['user','assistant'].includes(row.role)||typeof row.text!=='string'||!row.text.trim())continue;
    const key=sourceKey(row);
    if(excludeKeys.has(key)||unique.has(key))continue;
    const text=normalize(row.text),title=normalize(row.title);
    let score=0;
    for(const [term,weight] of terms)score+=text.includes(term)?weight:title.includes(term)?weight*0.5:0;
    if(score>0)unique.set(key,{row,key,score});
  }
  const ranked=[...unique.values()].sort((a,b)=>b.score-a.score||(Number(b.row.at)||0)-(Number(a.row.at)||0)||a.key.localeCompare(b.key));
  const result=[];
  for(const {row} of ranked){
    if(result.length>=messageLimit||remaining<8)break;
    const text=row.text.slice(0,remaining);
    if(!text.trim())continue;
    result.push({...row,text,...(text.length<row.text.length?{truncated:true}:{})});
    remaining-=text.length;
  }
  return result;
}

module.exports={sourceKey,sourceHash,findRelatedSources};
