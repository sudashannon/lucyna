const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {sourceKey,sourceHash}=require('../src/work-incremental.cjs');
const {WorkAssistant}=require('../src/work-assistant.cjs');

async function fixture(t,run){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-summary-reconciliation-'));
  const identity={root:`/work/reconciliation-${path.basename(directory)}`};
  const agents=[];
  const makeAssistant=agentRun=>{
    const assistant=new WorkAssistant({directory,debounceMs:600000,agent:{run:agentRun},
      config:async()=>({baseURL:'http://fixture.invalid/v1',model:'reconciliation-fixture'})});
    agents.push(assistant);return assistant;
  };
  const assistant=makeAssistant(run);
  const load=async()=>assistant.load(identity);
  const ingest=async(messages,authoritative=false)=>assistant.ingest({...identity,sessionId:'journal',title:'状态迁移测试',authoritative,
    messages:messages.map(({id,role='user',text,timestamp})=>({id,role,timestamp,content:text}))},{schedule:false});
  const summarize=async()=>{const before=await assistant.view(identity);await assistant.summarize(before.workId);return assistant.view(identity);};
  t.after(async()=>{for(const agent of agents)await agent.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,identity,assistant,makeAssistant,load,ingest,summarize};
}

const respond=value=>({text:JSON.stringify(value),finishReason:'stop',totalUsage:{inputTokens:12,outputTokens:8}});
const firstEvidence=payload=>payload.messages[0].excerpts[0].evidenceId;
const evidenceFor=(payload,messageId)=>payload.messages.find(message=>message.messageId===messageId)?.excerpts[0]?.evidenceId;
const cite=evidenceId=>({evidenceId});
function allPriorHandles(payload){
  if(!payload.previousSummary)return [];
  const result=[];
  if(payload.previousSummary.overview)result.push('overview');
  for(const section of ['goals','decisions','progress','openQuestions','nextSteps']){
    result.push(...(payload.previousSummary[section]||[]).map(item=>item.id));
  }
  return result;
}
function initialStatePayload(payload,items){
  const e=firstEvidence(payload),groups=new Map();
  for(const {section,...item}of items){
    const source=item.sourceMessageId?evidenceFor(payload,item.sourceMessageId):e;
    const upsert=groups.get(section)||[];upsert.push({text:item.text,sources:[cite(source)]});groups.set(section,upsert);
  }
  const overviewText=items.find(item=>item.overviewText)?.overviewText||'当前 Work 的目标、决策和验证状态。';
  return {overview:{text:overviewText,sources:[cite(e)]},keep:[],
    changes:[...groups].map(([section,upsert])=>({section,upsert}))};
}
async function seed(t,items,extraMessages=[]){
  const calls=[];
  let onDelta=()=>assert.fail('seed provider received an unexpected second request');
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    if(calls.length===1)return respond(initialStatePayload(payload,items));
    return onDelta(payload,calls.length);
  });
  await f.ingest([{id:'m1',text:'用户记录工作基线、当前决定、未决问题和下一步。',timestamp:100},...extraMessages],true);
  const baseline=await f.summarize();
  assert.equal(baseline.status,'idle',baseline.error);
  return {...f,calls,baseline,setDeltaHandler:fn=>{onDelta=fn;}};
}

test('same subject updates its stable ID; resolved questions and next steps leave current state',async t=>{
  const f=await seed(t,[
    {section:'goals',text:'完成 U-Boot!24 的严格配置并验证。'},
    {section:'decisions',text:'U-Boot!24 当前采用旧启动设置。'},
    {section:'openQuestions',text:'U-Boot!24 是否已通过设备验证？'},
    {section:'openQuestions',text:'另一个设备仍待确认。'},
    {section:'nextSteps',text:'完成 U-Boot!24 设备验证。'},
    {section:'nextSteps',text:'检查另一个设备。'},
  ]);
  const ids={decision:f.baseline.summary.decisions[0].id,
    open:f.baseline.summary.openQuestions[0].id,next:f.baseline.summary.nextSteps[0].id};
  f.setDeltaHandler((payload)=>{
    assert.equal(payload.analysis.mode,'incremental');
    const e=firstEvidence(payload);
    return respond({overview:{text:'U-Boot!24 已完成验证；另一个设备仍待确认。',sources:[cite(e)]},
      keep:['g1','q2','n2'],changes:[
        {section:'decisions',upsert:[{id:'d1',text:'U-Boot!24 已按新启动设置完成设备验证。',sources:[cite(e)]}]},
        {section:'openQuestions',remove:[{id:'q1',reason:'resolved',sources:[cite(e)]}]},
        {section:'nextSteps',remove:[{id:'n1',reason:'resolved',sources:[cite(e)]}]},
        {section:'progress',upsert:[{text:'U-Boot!24 已完成设备验证。',sources:[cite(e)]}]},
      ]});
  });
  await f.ingest([{id:'m2',text:'用户确认 U-Boot!24 已完成设备验证；此前待办已完成。',timestamp:200}]);
  const out=await f.summarize();
  assert.equal(out.status,'idle',out.error);
  assert.equal(out.summary.decisions.length,1);
  assert.equal(out.summary.decisions[0].id,ids.decision);
  assert.match(out.summary.decisions[0].text,/已按新启动设置完成设备验证/);
  assert.deepEqual(out.summary.openQuestions.map(item=>item.text),['另一个设备仍待确认。']);
  assert.deepEqual(out.summary.nextSteps.map(item=>item.text),['检查另一个设备。']);
  assert.equal(out.summary.progress.length,1,'progress is kept as a concise milestone, not a repeated delta log');
  assert.equal(out.summary.openQuestions.some(item=>item.id===ids.open),false);
  assert.equal(out.summary.nextSteps.some(item=>item.id===ids.next),false);
  assert.equal(out.summaryRevision,out.sourceRevision);
});

test('an omitted old handle receives one reconciliation correction and then commits',async t=>{
  const f=await seed(t,[{section:'goals',text:'保持 Work 交付按期完成。'}]);
  f.setDeltaHandler(payload=>{
    const e=firstEvidence(payload);
    if(!payload.correction)return respond({overview:{text:'新增进展已检查。',sources:[cite(e)]},changes:[
      {section:'progress',upsert:[{text:'本轮新增一个构建验证。',sources:[cite(e)]}]},
    ]});
    assert.equal(payload.correction.kind,'reconciliation');
    return respond({overview:{text:'新增进展已检查。',sources:[cite(e)]},keep:['g1'],changes:[
      {section:'progress',upsert:[{text:'本轮新增一个构建验证。',sources:[cite(e)]}]},
    ]});
  });
  await f.ingest([{id:'m2',text:'本轮新增一个构建验证结果。',timestamp:200}]);
  const out=await f.summarize();
  const state=(await f.load()).state;
  assert.equal(f.calls.length,3);
  assert.equal(out.status,'idle',out.error);
  assert.equal(state.analysis.hashes.length,2);
  assert.equal(out.summary.goals.length,1);
  assert.equal(out.analysis.rounds,2);
});

test('a second incomplete reconciliation preserves the old summary and does not checkpoint the delta',async t=>{
  const f=await seed(t,[{section:'decisions',text:'保持当前启动策略。'}]);
  f.setDeltaHandler(payload=>{
    const e=firstEvidence(payload);
    return respond({overview:{text:'增量待核对。',sources:[cite(e)]},changes:[
      {section:'decisions',upsert:[{text:'新建了一个未核实决策。',sources:[cite(e)]}]},
    ]});
  });
  const previous=structuredClone((await f.load()).state.summary);
  await f.ingest([{id:'m2',text:'有一项新的计划还没有被用户确认。',timestamp:200}]);
  const out=await f.summarize(),state=(await f.load()).state;
  assert.equal(f.calls.length,3);
  assert.equal(out.status,'error');
  assert.equal(out.lastFailureDiagnostic.kind,'reconciliation');
  assert.equal(out.lastFailureDiagnostic.correctionFailed,true);
  assert.deepEqual(state.summary,previous);
  assert.equal(state.analysis.hashes.length,1);
  assert.equal(state.summaryRevision,f.baseline.summaryRevision);
});

test('a removal with an invalid citation is rejected without a correction request',async t=>{
  const f=await seed(t,[{section:'openQuestions',text:'确认设备启动策略是否可用。'}]);
  f.setDeltaHandler(payload=>{
    const e=firstEvidence(payload);
    return respond({overview:{text:'设备问题已经解决。',sources:[cite(e)]},keep:[],changes:[
      {section:'openQuestions',remove:[{id:'q1',reason:'resolved',sources:[cite('not-in-this-request')]}]},
    ]});
  });
  const previous=structuredClone((await f.load()).state.summary);
  await f.ingest([{id:'m2',text:'用户确认设备启动策略已完成并验证。',timestamp:200}]);
  const out=await f.summarize(),state=(await f.load()).state;
  assert.equal(f.calls.length,2,'invalid evidence must not be hidden by correction');
  assert.equal(out.status,'error');
  assert.equal(out.lastFailureDiagnostic.kind,'validation');
  assert.deepEqual(state.summary,previous);
  assert.equal(state.analysis.hashes.length,1);
});

test('old retrieved evidence cannot roll a current decision backwards',async t=>{
  const f=await seed(t,[{section:'decisions',text:'HISTORICALKEY 的当前决定：保留新的安全策略。',sourceMessageId:'m1'}],
    [{id:'old',text:'旧证据 HISTORICALKEY 曾建议启用旧策略。',timestamp:50}]);
  f.setDeltaHandler((payload)=>{
    const e=firstEvidence(payload);
    if(payload.correction){
      assert.equal(payload.correction.kind,'reconciliation');
      return respond({overview:{text:'当前安全策略保持不变。',sources:[cite(e)]},keep:allPriorHandles(payload).filter(id=>id!=='overview'),changes:[]});
    }
    if(payload.analysis.round===2){
      const old=evidenceFor(payload,'old');
      assert.ok(old,'requested historical evidence should be included in the second context');
      return respond({overview:{text:'当前安全策略保持不变。',sources:[cite(e)]},
        keep:allPriorHandles(payload).filter(id=>id!=='overview'),changes:[{section:'decisions',upsert:[
          {id:'d1',text:'回滚：启用旧策略。',sources:[cite(old)]},
        ]}]});
    }
    return respond({overview:{text:'当前安全策略保持不变。',sources:[cite(e)]},keep:allPriorHandles(payload).filter(id=>id!=='overview'),changes:[],
      evidenceRequests:['HISTORICALKEY']});
  });
  const prior=(await f.load()).state.summary;
  await f.ingest([{id:'m2',text:'用户确认当前安全策略继续有效，无需修改。',timestamp:300}]);
  const out=await f.summarize();
  assert.equal(f.calls.length,4);
  assert.equal(f.calls[2].analysis.round,2);
  assert.equal(f.calls[3].correction.kind,'reconciliation');
  assert.equal(out.status,'idle',out.error);
  assert.equal(out.summary.decisions[0].id,prior.decisions[0].id);
  assert.equal(out.summary.decisions[0].text,prior.decisions[0].text);
});

test('when only old supplements remain, they may rebuild a deleted overview but cannot revise another item',async t=>{
  const calls=[];
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    const e=firstEvidence(payload);
    if(calls.length===1)return respond({overview:{text:'OMEGA_TOKEN 的工作概况。',sources:[cite(e)]},keep:[],changes:[
      {section:'decisions',upsert:[{text:'保持当前设备安全策略。',sources:[cite(evidenceFor(payload,'current'))]}]},
    ]});
    if(calls.length===2){
      assert.equal(payload.analysis.changedMessages,0);
      assert.ok(payload.messages.some(message=>message.messageId==='current'),'only the surviving old evidence should be supplemental');
      return respond({overview:{text:'错误地更新了另一项状态。',sources:[cite(e)]},keep:[],changes:[
        {section:'decisions',upsert:[{id:'d1',text:'只根据旧补充证据修改现有决定。',sources:[cite(e)]}]},
      ]});
    }
    assert.equal(payload.correction.kind,'reconciliation');
    assert.equal(payload.analysis.changedMessages,0);
    return respond({overview:{text:'OMEGA_TOKEN 当前工作概况。',sources:[cite(e)]},keep:['d1'],changes:[]});
  });
  await f.ingest([
    {id:'overview-source',text:'OMEGA_TOKEN 早期讨论仍未完成。',timestamp:100},
    {id:'current',text:'OMEGA_TOKEN 当前设备安全策略仍有效。',timestamp:200},
  ],true);
  const before=await f.assistant.view(f.identity);
  await f.assistant.summarize(before.workId);
  const prior=(await f.assistant.load(f.identity)).state.summary;
  await f.ingest([{id:'current',text:'OMEGA_TOKEN 当前设备安全策略仍有效。',timestamp:200}],true);
  const out=await f.assistant.view(f.identity);
  await f.assistant.summarize(before.workId);
  const after=await f.assistant.view(f.identity);
  assert.equal(calls.length,3);
  assert.equal(out.summary.overview, null, 'the removed overview citation is pruned before replacement');
  assert.equal(after.status,'idle',after.error);
  assert.equal(after.summary.decisions[0].id,prior.decisions[0].id);
  assert.equal(after.summary.decisions[0].text,prior.decisions[0].text);
  assert.match(after.summary.overview.text,/当前工作概况/);
});

test('merged and superseded removals must point to a surviving prior item',async t=>{
  const f=await seed(t,[
    {section:'decisions',text:'启用设备安全启动策略。'},
    {section:'decisions',text:'按原启动策略继续。'},
  ]);
  f.setDeltaHandler(payload=>{
    const e=firstEvidence(payload);
    return respond({overview:{text:'设备采用已更新的启动策略。',sources:[cite(e)]},keep:['overview'],changes:[
      {section:'decisions',upsert:[{id:'d1',text:'启用设备安全启动策略并完成验证。',sources:[cite(e)]}],
        remove:[{id:'d2',reason:'merged',into:'x99',sources:[cite(e)]}]},
    ]});
  });
  const prior=structuredClone((await f.load()).state.summary);
  await f.ingest([{id:'m2',text:'用户确认采用新启动策略并已验证完成。',timestamp:200}]);
  const out=await f.summarize(),state=(await f.load()).state;
  assert.equal(f.calls.length,3);
  assert.equal(out.lastFailureDiagnostic.kind,'reconciliation');
  assert.deepEqual(state.summary,prior);
  assert.equal(state.analysis.hashes.length,1);
});

test('a v1 full sweep rebuilds privately from empty state and clears a prior error fingerprint',async t=>{
  const calls=[];
  let f=await fixture(t,async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    const e=firstEvidence(payload);
    if(calls.length===1){
      assert.equal(payload.analysis.mode,'full');
      assert.equal(payload.previousSummary,null,'a new full correction must start from an empty private summary');
      return respond({overview:{text:'全量消息中的最新工作状态。',sources:[cite(e)]},keep:[],changes:[
        {section:'progress',upsert:[{text:'全量重建后的第一项里程碑。',sources:[cite(e)]}]},
      ]});
    }
    assert.equal(payload.analysis.mode,'full');
    assert.deepEqual(payload.previousSummary.progress.map(item=>item.text),['全量重建后的第一项里程碑。']);
    assert.ok(!JSON.stringify(payload.previousSummary).includes('旧版 ghost 摘要'));
    return respond({keep:allPriorHandles(payload),changes:[]});
  });
  const messages=Array.from({length:65},(_,index)=>({id:`m${index+1}`,timestamp:100+index,
    text:index===0?'基线消息用于引用，随后按保留历史全量重建。':`第 ${index+1} 条保留消息记录独立工程状态。`}));
  await f.ingest(messages,true);
  const {identity:savedIdentity,state}=await f.assistant.load(f.identity);
  const rows=state.sessions.flatMap(session=>session.messages.map(message=>({sessionId:session.sessionId,messageId:message.id,role:message.role,text:message.text})));
  const source=rows.find(row=>row.messageId==='m1');
  const oldCitation={sessionId:source.sessionId,messageId:source.messageId,role:source.role,quote:source.text.slice(0,32)};
  state.summary={overview:{id:'overview',text:'旧版概况',sources:[oldCitation]},goals:[],decisions:[],
    progress:[{id:'old-ghost',text:'旧版 ghost 摘要',sources:[oldCitation]}],openQuestions:[],nextSteps:[]};
  state.summaryRevision=state.sourceRevision;
  state.lastFullAt=Date.now();
  state.status='error';state.error='旧版本的摘要失败';state.lastFailureFingerprint='stale-v1-fingerprint';
  state.analysis={version:1,hashes:rows.map(row=>[sourceKey(row),sourceHash(row)]),lastFullAt:Date.now(),deltasSinceFull:0,sweep:null};
  await f.assistant.persist(savedIdentity,state);
  await f.assistant.close();
  const migrated=f.makeAssistant(async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    const e=firstEvidence(payload);
    if(calls.length===1){
      assert.equal(payload.analysis.mode,'full');
      assert.equal(payload.previousSummary,null);
      return respond({overview:{text:'全量消息中的最新工作状态。',sources:[cite(e)]},keep:[],changes:[
        {section:'progress',upsert:[{text:'全量重建后的第一项里程碑。',sources:[cite(e)]}]},
      ]});
    }
    assert.equal(payload.analysis.mode,'full');
    assert.deepEqual(payload.previousSummary.progress.map(item=>item.text),['全量重建后的第一项里程碑。']);
    assert.ok(!JSON.stringify(payload.previousSummary).includes('旧版 ghost 摘要'));
    return respond({keep:allPriorHandles(payload),changes:[]});
  });
  const loaded=await migrated.load(f.identity);
  assert.equal(loaded.state.analysis.version,0);
  assert.equal(loaded.state.lastFailureFingerprint,'');
  assert.equal(loaded.state.summary.progress[0].text,'旧版 ghost 摘要');
  await migrated.summarize(loaded.state.workId);
  const between=await migrated.view(f.identity);
  assert.equal(between.status,'summarizing');
  assert.equal(between.summary.progress[0].text,'旧版 ghost 摘要','old summary remains visible until every full batch succeeds');
  await migrated.summarize(loaded.state.workId);
  const finished=await migrated.view(f.identity);
  assert.equal(finished.status,'idle');
  assert.ok(!JSON.stringify(finished.summary).includes('旧版 ghost 摘要'));
  assert.equal(finished.summaryRevision,finished.sourceRevision);
  assert.equal(calls.length,2);
});

test('when a requested old source is missing, final reconciliation reuses one correction',async t=>{
  const f=await seed(t,[{section:'goals',text:'保留当前目标及其原始说明。'}]);
  f.setDeltaHandler(payload=>{
    const e=firstEvidence(payload);
    if(!payload.correction)return respond({overview:{text:'已查看本轮更新。',sources:[cite(e)]},changes:[],
      evidenceRequests:['MISSING_UNIQUE_ARCHIVE_KEY']});
    assert.equal(payload.correction.kind,'reconciliation');
    return respond({keep:allPriorHandles(payload),changes:[]});
  });
  await f.ingest([{id:'m2',text:'用户新增一条更新，但旧档案中没有所需编号。',timestamp:200}]);
  const out=await f.summarize();
  assert.equal(f.calls.length,3);
  assert.equal(out.status,'idle',out.error);
  assert.equal(f.calls[2].correction.kind,'reconciliation');
  assert.equal(out.summary.goals.length,1);
});
