const prefixes={overview:'',goals:'g',decisions:'d',progress:'p',openQuestions:'q',nextSteps:'n'};

// Adapt older fixture replies to the summary reconciliation contract so legacy
// tests can keep focusing on their original behavior. Dedicated reconciliation
// tests should call the real model stub directly and must not use this helper.
function reconcileFixtureResponse(response,payload){
  if(typeof response?.text!=='string'||!payload?.previousSummary)return response;
  let value;
  try{value=JSON.parse(response.text);}catch{return response;}
  if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.changes))return response;

  const evidenceId=payload.messages?.flatMap(message=>message.excerpts||[])
    .find(excerpt=>typeof excerpt?.evidenceId==='string')?.evidenceId;
  const existing=new Map();
  for(const [section,prefix]of Object.entries(prefixes)){
    if(section==='overview'){
      if(payload.previousSummary.overview?.id)existing.set('overview',{section:'overview',shortId:'overview'});
      continue;
    }
    (payload.previousSummary[section]||[]).forEach((item,index)=>{
      if(typeof item?.id==='string')existing.set(item.id,{section,shortId:item.id||prefix+(index+1)});
    });
  }

  const touched=new Set();
  let unknownRemove=false;
  for(const change of value.changes){
    if(!change||!Object.hasOwn(prefixes,change.section))continue;
    const items=existingForSection(existing,change.section);
    if(Array.isArray(change.remove)){
      change.remove=change.remove.map(item=>{
        if(typeof item==='object'&&item){
          const found=items.get(item.id);
          if(found)touched.add(found.shortId);
          return item;
        }
        if(typeof item!=='string')return item;
        const found=items.get(item);
        if(!found){unknownRemove=true;return item;}
        touched.add(found.shortId);
        if(!evidenceId)return item;
        return {id:item,reason:'resolved',sources:[{evidenceId}]};
      });
    }
    for(const item of Array.isArray(change.upsert)?change.upsert:[]){
      if(typeof item?.id==='string'&&items.has(item.id))touched.add(items.get(item.id).shortId);
    }
  }

  // Keep an unknown removal malformed on purpose. This preserves the old
  // regression that proves the host rejects a fabricated item handle.
  if(unknownRemove)return response;

  const explicit=new Set(Array.isArray(value.keep)?value.keep.filter(item=>typeof item==='string'):[]);
  for(const {shortId}of existing.values())if(!touched.has(shortId))explicit.add(shortId);
  if(Object.hasOwn(value,'overview'))explicit.delete('overview');
  value.keep=[...explicit];
  return {...response,text:JSON.stringify(value)};
}

function existingForSection(existing,section){
  return new Map([...existing].filter(([,item])=>item.section===section));
}

function withSummaryReconciliation(run){
  if(typeof run!=='function')throw new TypeError('fixture model runner must be a function');
  return async(...args)=>{
    const response=await run(...args);
    let payload;
    try{payload=JSON.parse(args[2]);}catch{return response;}
    return reconcileFixtureResponse(response,payload);
  };
}

module.exports={reconcileFixtureResponse,withSummaryReconciliation};
