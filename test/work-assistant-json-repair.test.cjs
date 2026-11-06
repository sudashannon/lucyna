const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {WorkAssistant}=require('../src/work-assistant.cjs');
const {withSummaryReconciliation}=require('./work-summary-fixture.test.cjs');

async function fixture(t,run){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-summary-json-repair-'));
  const assistant=new WorkAssistant({directory,debounceMs:600000,agent:{run:withSummaryReconciliation(run)},
    config:async()=>({baseURL:'http://fixture.invalid/v1',model:'fixture'})});
  const identity={root:`/work/json-repair-${path.basename(directory)}`};
  t.after(async()=>{await assistant.close();await fs.rm(directory,{recursive:true,force:true});});
  const ingest=async(sessionId,messages,authoritative=false)=>assistant.ingest({...identity,sessionId,authoritative,
    messages:messages.map(({id,role='user',text,timestamp})=>({id,role,timestamp,content:text}))},{schedule:false});
  return {assistant,directory,identity,ingest};
}

const result=(text,usage=8,finishReason='stop')=>({text,finishReason,totalUsage:{inputTokens:usage,outputTokens:3}});
function summaryFor(payload,quote){
  const source=payload.messages[0];
  return {overview:{text:'当前 Work 保留了可核对的工作进展。',sources:[quote===undefined
    ?{evidenceId:source.excerpts[0].evidenceId}
    :{sessionId:source.sessionId,messageId:source.messageId,role:source.role,quote}]},changes:[]};
}

test('malformed JSON is corrected once with the exact untrusted candidate and the same evidence context',async t=>{
  const calls=[];
  const bad='{"overview"?:{"text":"PRIVATE_BAD_JSON"},"changes":[]}';
  const f=await fixture(t,async(_config,instructions,raw)=>{
    calls.push({instructions,payload:JSON.parse(raw)});
    return calls.length===1?result(bad):result(JSON.stringify(summaryFor(calls[1].payload)));
  });
  await f.ingest('journal',[{id:'m1',text:'用户确认本轮任务只整理已验证的工作来源。',timestamp:1}]);
  const before=await f.assistant.view(f.identity);
  await f.assistant.summarize(before.workId);
  const after=await f.assistant.view(f.identity);
  assert.equal(calls.length,2);
  assert.equal(calls[1].payload.correction.kind,'json');
  assert.equal(calls[1].payload.correction.candidate,bad);
  const {correction:_ignored,...repairContext}=calls[1].payload;
  assert.deepEqual(repairContext,calls[0].payload,'repair must reuse exactly the same source and evidence IDs');
  assert.doesNotMatch(calls[0].instructions,/"(?:overview|evidenceRequests)"\s*\?/,'prompt examples must be valid JSON');
  assert.ok(after.summary);
  assert.equal(after.analysis.rounds,2);
  assert.equal(after.usedTokens,22);
  assert.equal(after.usageUnknown,false);
  assert.equal(after.lastFailureDiagnostic,null);
});

test('a truncated response keeps the truncation error and does not request a syntax correction',async t=>{
  let calls=0;
  const f=await fixture(t,async()=>{calls++;return result('{"overview":',12,'length');});
  await f.ingest('journal',[{id:'m1',text:'截断测试只检查失败提示且不能自动猜补JSON。',timestamp:1}]);
  const collected=await f.assistant.view(f.identity);
  await f.assistant.summarize(collected.workId);
  const failed=await f.assistant.view(f.identity);
  assert.equal(calls,1);
  assert.match(failed.error,/截断/);
  assert.equal(failed.lastFailureDiagnostic.kind,'truncated');
  assert.equal(failed.lastFailureDiagnostic.attempts,1);
  assert.equal(failed.analysis.rounds,1);
  assert.equal((await f.assistant.load(f.identity)).state.analysis.hashes.length,0);
});

test('two malformed responses stop after one correction and persist only safe parse diagnostics',async t=>{
  const calls=[];
  const first='{"privateCandidate":"PRIVATE_BAD_JSON_SECRET"';
  const second='{"overview": nope}';
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    calls.push(JSON.parse(raw));
    return result(calls.length===1?first:second,10);
  });
  await f.ingest('journal',[{id:'m1',text:'保留当前任务的真实进度和未决事项。',timestamp:1}]);
  const collected=await f.assistant.view(f.identity);
  await f.assistant.summarize(collected.workId);
  const failed=await f.assistant.view(f.identity);
  const state=(await f.assistant.load(f.identity)).state;
  assert.equal(calls.length,2);
  assert.equal(calls[1].correction.candidate,first);
  assert.match(failed.error,/JSON 自动纠正仍未返回有效 JSON/);
  assert.equal(failed.lastFailureDiagnostic.kind,'json');
  assert.equal(failed.lastFailureDiagnostic.attempts,2);
  assert.equal(failed.lastFailureDiagnostic.responseChars,second.length);
  assert.equal(failed.lastFailureDiagnostic.finishReason,'stop');
  assert.equal(failed.lastFailureDiagnostic.correctionFailed,true);
  if(failed.lastFailureDiagnostic.parsePosition!==undefined)assert.ok(Number.isSafeInteger(failed.lastFailureDiagnostic.parsePosition));
  if(failed.lastFailureDiagnostic.parseLine!==undefined)assert.ok(Number.isSafeInteger(failed.lastFailureDiagnostic.parseLine));
  if(failed.lastFailureDiagnostic.parseColumn!==undefined)assert.ok(Number.isSafeInteger(failed.lastFailureDiagnostic.parseColumn));
  assert.equal(state.summary,null);
  assert.equal(state.summaryRevision,0);
  assert.equal(state.analysis.hashes.length,0,'failed batches must not advance the source checkpoint');
  assert.equal(failed.analysis.rounds,2);
  const saved=await fs.readFile(path.join(f.directory,`${collected.workId}.json`),'utf8');
  assert.doesNotMatch(saved,/PRIVATE_BAD_JSON_SECRET|PRIVATE_BAD_JSON/);
  assert.doesNotMatch(JSON.stringify(failed.lastFailureDiagnostic),/PRIVATE_BAD_JSON|PRIVATE/);
});

test('a failed correction call marks usage unknown while preserving its sanitized provider failure',async t=>{
  let calls=0;
  const f=await fixture(t,async()=>{
    calls++;
    if(calls===1)return result('{"changes"?:[]}',19);
    throw Object.assign(Error('PRIVATE_API_KEY_AND_RESPONSE_BODY'),{publicMessage:'辅助模型服务限流（HTTP 429），请稍后重试'});
  });
  await f.ingest('journal',[{id:'m1',text:'本条消息用于检查纠正请求失败时的用量统计。',timestamp:1}]);
  const collected=await f.assistant.view(f.identity);
  await f.assistant.summarize(collected.workId);
  const failed=await f.assistant.view(f.identity);
  const saved=await fs.readFile(path.join(f.directory,`${collected.workId}.json`),'utf8');
  assert.equal(calls,2);
  assert.equal(failed.analysis.rounds,2);
  assert.equal(failed.usedTokens,22,'the first invocation usage is still recorded');
  assert.equal(failed.usageUnknown,true,'a later unaccounted correction request must not be hidden by prior usage');
  assert.match(failed.error,/格式纠正请求失败：辅助模型服务限流/);
  assert.doesNotMatch(failed.error,/PRIVATE_API_KEY/);
  assert.doesNotMatch(saved,/PRIVATE_API_KEY_AND_RESPONSE_BODY/);
});

test('a repaired JSON object with an invalid citation is still rejected without advancing its checkpoint',async t=>{
  const calls=[];
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    return calls.length===1?result('{"changes"?:[]}'):
      result(JSON.stringify(summaryFor(payload,'THIS_QUOTE_IS_NOT_IN_THE_SOURCE')));
  });
  await f.ingest('journal',[{id:'m1',text:'只有原文中真实存在的句子可以成为摘要引用。',timestamp:1}]);
  const collected=await f.assistant.view(f.identity);
  await f.assistant.summarize(collected.workId);
  const failed=await f.assistant.view(f.identity);
  const state=(await f.assistant.load(f.identity)).state;
  assert.equal(calls.length,2);
  assert.match(calls[1].correction.candidate,/"changes"\?\:/);
  assert.equal(failed.status,'error');
  assert.equal(failed.lastFailureDiagnostic.kind,'validation');
  assert.equal(failed.lastFailureDiagnostic.correctionFailed,true);
  assert.equal(state.summary,null);
  assert.equal(state.analysis.hashes.length,0);
  assert.equal(state.summaryRevision,0);
  assert.match(failed.error,/自动纠正后仍未通过结构或来源核验/);
});

test('a misspelled remove handle is corrected from the same-section short ID map',async t=>{
  const calls=[];
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    const evidenceId=payload.messages[0].excerpts[0].evidenceId;
    if(calls.length===1)return result(JSON.stringify({overview:{text:'当前进展已有登记。',sources:[{evidenceId}]},
      changes:[{section:'progress',upsert:[{text:'原有进展条目',sources:[{evidenceId}]}]}]}));
    if(!payload.correction)return result(JSON.stringify({overview:{text:'本轮新增消息要求替换旧进展。',sources:[{evidenceId}]},
      changes:[{section:'progress',remove:['p9'],upsert:[{text:'新进展条目',sources:[{evidenceId}]}]}]}));
    return result(JSON.stringify({overview:{text:'本轮新增消息要求替换旧进展。',sources:[{evidenceId}]},
      changes:[{section:'progress',remove:['p1'],upsert:[{text:'经修正并替换的进展条目',sources:[{evidenceId}]}]}]}));
  });
  await f.ingest('journal',[{id:'m1',text:'第一条消息支持目前已经登记的进展。',timestamp:1}],true);
  const initial=await f.assistant.view(f.identity);await f.assistant.summarize(initial.workId);
  const prior=(await f.assistant.view(f.identity)).summary.progress[0];
  await f.ingest('journal',[
    {id:'m1',text:'第一条消息支持目前已经登记的进展。',timestamp:1},
    {id:'m2',text:'用户确认旧进展应被本轮的新增记录替换。',timestamp:2}
  ],true);
  await f.assistant.summarize(initial.workId);
  const completed=await f.assistant.view(f.identity);
  assert.equal(calls.length,3);
  assert.equal(calls[1].previousSummary.progress[0].id,'p1');
  assert.deepEqual(calls[2].correction,{kind:'itemId',candidate:JSON.stringify({overview:{text:'本轮新增消息要求替换旧进展。',sources:[{evidenceId:'c1.1'}]},
    changes:[{section:'progress',remove:['p9'],upsert:[{text:'新进展条目',sources:[{evidenceId:'c1.1'}]}]}]})});
  assert.equal(completed.summary.progress.length,1);
  assert.notEqual(completed.summary.progress[0].id,prior.id);
  assert.equal(completed.summary.progress[0].text,'经修正并替换的进展条目');
});

test('a source edit while JSON correction is in flight prevents stale checkpoint commit',async t=>{
  const started=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const firstCorrection=new Promise(resolve=>{started.push(resolve);});
  let calls=0;
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    calls++;
    if(calls===1)return result('{"changes"?:[]}');
    started[0]();await gate;
    return result(JSON.stringify(summaryFor(JSON.parse(raw))));
  });
  await f.ingest('journal',[{id:'m1',text:'初始消息用于验证来源更新期间的取消保护。',timestamp:1}],true);
  const collected=await f.assistant.view(f.identity);
  const running=f.assistant.summarize(collected.workId);
  await firstCorrection;
  await f.ingest('journal',[{id:'m1',text:'原消息已修改，旧请求必须取消且不能提交检查点。',timestamp:1}],true);
  release();await running;
  const current=await f.assistant.view(f.identity),state=(await f.assistant.load(f.identity)).state;
  assert.equal(calls,2);
  assert.equal(current.sourceRevision,collected.sourceRevision+1);
  assert.equal(current.summary,null);
  assert.equal(state.analysis.hashes.length,0);
  assert.equal(current.summaryRevision,0);
});

async function seedTwelveGoals(f){
  await f.ingest('journal',[{id:'base',text:'当前 Work 有十二条需要保留的既有目标。',timestamp:1}]);
  const base=await f.assistant.view(f.identity);
  await f.assistant.summarize(base.workId);
  return f.assistant.view(f.identity);
}

test('capacity correction uses request-local item handles and preserves the replaced stable ID',async t=>{
  const calls=[];
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    const evidenceId=payload.messages[0].excerpts[0].evidenceId;
    if(calls.length===1){
      const goals=Array.from({length:12},(_,index)=>({text:`保留目标 ${index+1}`,sources:[{evidenceId}]}));
      return result(JSON.stringify({overview:{text:'当前 Work 的目标已登记。',sources:[{evidenceId}]},changes:[{section:'goals',upsert:goals}]}));
    }
    if(!payload.correction)return result(JSON.stringify({overview:{text:'新增消息已并入当前 Work。',sources:[{evidenceId}]},
      changes:[{section:'goals',upsert:[{text:'新增后超出容量的目标',sources:[{evidenceId}]}]}]}));
    return result(JSON.stringify({overview:{text:'新增消息已并入当前 Work。',sources:[{evidenceId}]},
      changes:[{section:'goals',upsert:[{id:'g1',text:'将新目标合并到既有目标一',sources:[{evidenceId}]}]}]}));
  });
  const initial=await seedTwelveGoals(f);
  const firstId=initial.summary.goals[0].id;
  await f.ingest('journal',[{id:'delta',text:'用户补充一条会改变现有目标的新信息。',timestamp:2}]);
  await f.assistant.summarize(initial.workId);
  const after=await f.assistant.view(f.identity);
  assert.equal(calls.length,3);
  assert.deepEqual(calls[1].previousSummary.goals.map(row=>row.id),Array.from({length:12},(_,index)=>`g${index+1}`));
  assert.ok(!JSON.stringify(calls[1].previousSummary).includes(firstId));
  assert.equal(calls[2].correction.kind,'capacity');
  assert.equal(after.summary.goals.length,12);
  assert.equal(after.summary.goals[0].id,firstId);
  assert.equal(after.summary.goals[0].text,'将新目标合并到既有目标一');
  assert.equal(after.analysis.rounds,2);
  assert.equal(after.summaryRevision,after.sourceRevision);
});

test('a later full-sweep batch repairs capacity against short handles from the prior checkpoint',async t=>{
  const calls=[];
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    const evidenceId=payload.messages[0].excerpts[0].evidenceId;
    if(calls.length===1){
      const progress=Array.from({length:12},(_,index)=>({text:`首批进展 ${index+1}`,sources:[{evidenceId}]}));
      return result(JSON.stringify({overview:{text:'Work整体进展正在分批校正。',sources:[{evidenceId}]},changes:[{section:'progress',upsert:progress}]}));
    }
    if(!payload.correction)return result(JSON.stringify({overview:{text:'最后一批已纳入全量校正。',sources:[{evidenceId}]},
      changes:[{section:'progress',upsert:[{text:'来自最后一批的新进展',sources:[{evidenceId}]}]}]}));
    return result(JSON.stringify({overview:{text:'最后一批已纳入全量校正。',sources:[{evidenceId}]},
      changes:[{section:'progress',upsert:[{id:'p1',text:'归并最后一批证据的进展',sources:[{evidenceId}]}]}]}));
  });
  await f.ingest('journal',Array.from({length:65},(_,index)=>({id:`m${index+1}`,timestamp:index+1,
    text:`Work retained history message ${index+1} records a concrete engineering decision and its next check.`})),true);
  const collected=await f.assistant.view(f.identity);
  await f.assistant.summarize(collected.workId);
  let state=(await f.assistant.load(f.identity)).state;
  assert.equal(state.analysis.sweep.cursor,64);
  assert.equal(state.summary,null,'incomplete full sweeps do not publish their partial summary');
  await f.assistant.summarize(collected.workId);
  const completed=await f.assistant.view(f.identity);
  state=(await f.assistant.load(f.identity)).state;
  assert.equal(calls.length,3);
  assert.equal(calls[1].analysis.batchIndex,65);
  assert.deepEqual(calls[1].previousSummary.progress.map(row=>row.id),Array.from({length:12},(_,index)=>`p${index+1}`));
  assert.equal(calls[2].correction.kind,'capacity');
  assert.equal(completed.summary.progress.length,12);
  assert.equal(completed.summary.progress[0].text,'归并最后一批证据的进展');
  assert.equal(state.analysis.sweep,null);
  assert.equal(completed.summaryRevision,completed.sourceRevision);
});

test('unresolved capacity correction leaves the prior summary and source checkpoint untouched',async t=>{
  const calls=[];
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    const evidenceId=payload.messages[0].excerpts[0].evidenceId;
    if(calls.length===1){
      const goals=Array.from({length:12},(_,index)=>({text:`目标 ${index+1}`,sources:[{evidenceId}]}));
      return result(JSON.stringify({overview:{text:'既有工作目标。',sources:[{evidenceId}]},changes:[{section:'goals',upsert:goals}]}));
    }
    return result(JSON.stringify({overview:{text:'仍有新目标。',sources:[{evidenceId}]},
      changes:[{section:'goals',upsert:[{text:`超限目标 ${calls.length}`,sources:[{evidenceId}]}]}]}));
  });
  const initial=await seedTwelveGoals(f),priorState=(await f.assistant.load(f.identity)).state;
  const priorHashes=structuredClone(priorState.analysis.hashes),priorSummary=structuredClone(priorState.summary);
  await f.ingest('journal',[{id:'delta',text:'新增消息要求补充一个不同目标。',timestamp:2}]);
  await f.assistant.summarize(initial.workId);
  const failed=await f.assistant.view(f.identity),state=(await f.assistant.load(f.identity)).state;
  assert.equal(calls.length,3);
  assert.equal(failed.lastFailureDiagnostic.kind,'capacity');
  assert.equal(failed.lastFailureDiagnostic.correctionFailed,true);
  assert.equal(state.summaryRevision,initial.summaryRevision);
  assert.deepEqual(state.analysis.hashes,priorHashes);
  assert.deepEqual(state.summary,priorSummary);
  assert.equal(state.analysis.hashes.length,1);
});

test('capacity recovery cannot hide an invalid citation in the rejected patch',async t=>{
  const calls=[];
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    const evidenceId=payload.messages[0].excerpts[0].evidenceId;
    if(calls.length===1){
      const goals=Array.from({length:12},(_,index)=>({text:`既有目标 ${index+1}`,sources:[{evidenceId}]}));
      return result(JSON.stringify({overview:{text:'目标基线已建立。',sources:[{evidenceId}]},changes:[{section:'goals',upsert:goals}]}));
    }
    const additions=Array.from({length:13},(_,index)=>({text:`新目标 ${index+1}`,
      sources:[{evidenceId:'citation-not-present-in-this-request'}]}));
    return result(JSON.stringify({overview:{text:'新增消息提出目标。',sources:[{evidenceId}]},changes:[{section:'goals',upsert:additions}]}));
  });
  const initial=await seedTwelveGoals(f),prior=(await f.assistant.load(f.identity)).state;
  const priorSummary=structuredClone(prior.summary),priorHashes=structuredClone(prior.analysis.hashes);
  await f.ingest('journal',[{id:'delta',text:'新增消息提出了一个可能的目标。',timestamp:2}]);
  await f.assistant.summarize(initial.workId);
  const failed=await f.assistant.view(f.identity),state=(await f.assistant.load(f.identity)).state;
  assert.equal(calls.length,2,'citation validation must happen before capacity correction');
  assert.equal(failed.lastFailureDiagnostic.kind,'validation');
  assert.equal(failed.lastFailureDiagnostic.correctionFailed,undefined);
  assert.deepEqual(state.summary,priorSummary);
  assert.deepEqual(state.analysis.hashes,priorHashes);
  assert.equal(state.summaryRevision,initial.summaryRevision);
});

test('the syntax correction allowance is shared by the evidence retrieval round',async t=>{
  const calls=[];
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    if(calls.length===1)return result(JSON.stringify(summaryFor(payload)));
    if(calls.length===2)return result(JSON.stringify({overview:{text:'增量消息已整理。',sources:[{evidenceId:payload.messages[0].excerpts[0].evidenceId}]},
      changes:[],evidenceRequests:['QUANTUM_KEY']}));
    if(calls.length===3)return result('{"changes"?:[]}');
    return result('{"changes":');
  });
  await f.ingest('journal',[
    {id:'m1',text:'历史决策记录了QUANTUM_KEY这个具体配置名，需保留原始证据。',timestamp:1}
  ],true);
  const initial=await f.assistant.view(f.identity);await f.assistant.summarize(initial.workId);
  await f.ingest('journal',[
    {id:'m1',text:'历史决策记录了QUANTUM_KEY这个具体配置名，需保留原始证据。',timestamp:1},
    {id:'m2',text:'用户补充了当前工作的新消息，要求查证相关配置。',timestamp:2}
  ],true);
  await f.assistant.summarize(initial.workId);
  const failed=await f.assistant.view(f.identity);
  assert.equal(calls.length,4,'one delta request, one evidence request, and only one shared correction');
  assert.equal(calls[3].correction.kind,'json');
  assert.ok(calls[3].messages.some(message=>message.messageId==='m1'),'the second round should include the requested older evidence');
  assert.equal(failed.analysis.rounds,3);
  assert.equal(failed.lastFailureDiagnostic.attempts,3);
  assert.equal(failed.lastFailureDiagnostic.kind,'json');
  assert.equal(failed.lastFailureDiagnostic.correctionFailed,true);
});

test('a patch draft may request old evidence before the final overview is validated',async t=>{
  const calls=[];
  const f=await fixture(t,async(_config,_instructions,raw)=>{
    const payload=JSON.parse(raw);calls.push(payload);
    if(calls.length===1)return result(JSON.stringify(summaryFor(payload)));
    if(calls.length===2)return result(JSON.stringify({changes:[],evidenceRequests:['QUANTUM_KEY']}));
    const earlier=payload.messages.find(message=>message.messageId==='m1');
    const current=payload.messages.find(message=>message.messageId==='m2');
    return result(JSON.stringify({overview:{text:'补充旧证据后形成可核对概况。',
      sources:[{evidenceId:earlier.excerpts[0].evidenceId},{evidenceId:current.excerpts[0].evidenceId}]},changes:[]}));
  });
  const history=[{id:'m1',text:'历史决定明确记录了QUANTUM_KEY这一项唯一配置标识。',timestamp:1}];
  await f.ingest('journal',history,true);
  const initial=await f.assistant.view(f.identity);await f.assistant.summarize(initial.workId);
  await f.ingest('journal',[...history,{id:'m2',text:'新消息要求继续核实前面记录的具体配置。',timestamp:2}],true);
  await f.assistant.summarize(initial.workId);
  const completed=await f.assistant.view(f.identity);
  assert.equal(calls.length,3);
  assert.ok(calls[2].messages.some(message=>message.messageId==='m1'));
  assert.equal(completed.summary.overview.text,'补充旧证据后形成可核对概况。');
  assert.equal(completed.summaryRevision,completed.sourceRevision);
});
