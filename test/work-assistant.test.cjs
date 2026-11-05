const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {WorkAssistant}=require('../src/work-assistant.cjs');

async function fixture(t,{run,localScope='scope-a',debounceMs=10}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-work-assistant-'));
  const assistant=new WorkAssistant({
    directory,
    localScope,
    debounceMs,
    agent:{run},
    config:async()=>({baseURL:'http://fixture.invalid/v1',model:'fixture'})
  });
  t.after(async()=>{
    await assistant.close();
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {assistant,directory};
}

function summaryFor(prompt,{quote,messageIndex=0}={}){
  const payload=JSON.parse(prompt);
  const source=payload.messages[messageIndex];
  return {
    overview:{text:'根据会话来源整理的工作摘要。',sources:[quote===undefined?{evidenceId:source.excerpts[0].evidenceId}:{
      sessionId:source.sessionId,
      messageId:source.messageId,
      role:source.role,
      quote
    }]},
    goals:[],decisions:[],progress:[],openQuestions:[],nextSteps:[]
  };
}

async function until(predicate,{timeoutMs=2500}={}){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    if(await predicate())return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('等待 Work 助手状态超时');
}

test('本地身份按可信 scope 隔离，远端身份按 hostId 归并',async t=>{
  const {assistant}=await fixture(t,{run:async()=>{throw Error('unexpected model call');}});
  const first=assistant.identity({root:'/work/demo'});
  const otherScope=new WorkAssistant({
    directory:assistant.directory,localScope:'scope-b',agent:{run:async()=>{}},config:async()=>null
  });
  try{
    assert.notEqual(first.workId,otherScope.identity({root:'/work/demo'}).workId);
    assert.equal(assistant.identity({root:'/work/demo',hostId:'remote-1'}).workId,
      otherScope.identity({root:'/work/demo',hostId:'remote-1'}).workId);
  }finally{await otherScope.close();}
});

test('authoritative history replaces the prior branch and identical snapshots do not revise sources',async t=>{
  let calls=0;
  const {assistant}=await fixture(t,{run:async(_config,_instructions,prompt)=>{
    calls++;
    return {text:JSON.stringify(summaryFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:4,outputTokens:2}};
  }});
  const identity={root:'/work/current'};
  const history={
    root:identity.root,sessionId:'journal:stable',title:'当前会话',authoritative:true,
    messages:[{id:'old-branch',role:'user',timestamp:1,content:'旧分支里的工作方向需要被替换。'}]
  };
  await assistant.ingest(history,{schedule:false});
  const before=(await assistant.view(identity)).sourceRevision;
  await assistant.ingest({...history,messages:[{id:'current-branch',role:'user',timestamp:2,content:'当前分支确认采用新的协作流程。'}]},{schedule:false});
  const current=await assistant.view(identity);
  assert.equal(current.sourceRevision,before+1);
  assert.equal(current.sessions[0].messageCount,1);
  assert.ok(!current.sources.some(source=>source.text.includes('旧分支')));
  await assistant.ingest({...history,messages:[{id:'current-branch',role:'user',timestamp:2,content:'当前分支确认采用新的协作流程。'}]},{schedule:false});
  assert.equal((await assistant.view(identity)).sourceRevision,current.sourceRevision);
  await assistant.summarize(current.workId);
  const summarized=await assistant.view(identity);
  assert.equal(calls,1);
  assert.equal(summarized.summaryRevision,summarized.sourceRevision);
  assert.equal(summarized.sources[0].text,'当前分支确认采用新的协作流程。');
});

test('short user corrections without timestamps remain the latest citable context',async t=>{
  const {assistant}=await fixture(t,{run:async(_config,_instructions,prompt)=>({
    text:JSON.stringify(summaryFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:4,outputTokens:2}
  })});
  const identity={root:'/work/untimed'};
  const state=await assistant.ingest({...identity,sessionId:'session-1',messages:[
    {role:'user',content:'先修改文件再运行程序'},
    {role:'assistant',content:'建议立即修改文件并运行。'},
    {role:'user',content:'不要'},
  ]},{schedule:false});
  await assistant.summarize(state.workId);
  const summarized=await assistant.view(identity);
  assert.equal(summarized.summary.overview.sources[0].quote,'不要');
});

test('invalid source citation charges returned usage and waits for explicit retry',async t=>{
  let calls=0;
  const {assistant}=await fixture(t,{run:async(_config,_instructions,prompt)=>{
    calls++;
    return {text:JSON.stringify(summaryFor(prompt,{quote:'这段原文中不存在的伪造引用'})),finishReason:'stop',totalUsage:{inputTokens:11,outputTokens:7}};
  }});
  const identity={root:'/work/invalid-citation'};
  await assistant.ingest({
    ...identity,sessionId:'session-1',
    messages:[{id:'m1',role:'user',timestamp:1,content:'用户确认先收集多会话上下文，再提出工作流优化建议。'}]
  },{schedule:false});
  const current=await assistant.view(identity);
  assistant.schedule(current.workId,0);
  await until(async()=> (await assistant.view(identity)).status==='error');
  await new Promise(resolve=>setTimeout(resolve,80));
  const failed=await assistant.view(identity);
  assert.equal(calls,1,'格式错误不应自行形成重试循环');
  assert.equal(failed.usedTokens,18,'格式和来源检查失败前已返回的模型用量仍需记录');
  assert.equal(failed.summary,null);
  assert.equal(failed.summaryRevision,0);
});

test('scheduled summaries across Works are serialized and stale results cannot replace newer messages',async t=>{
  let calls=0,active=0,maxActive=0;
  const {assistant}=await fixture(t,{run:async(_config,_instructions,prompt)=>{
    calls++;active++;maxActive=Math.max(maxActive,active);
    const payload=JSON.parse(prompt);
    const quote=payload.messages[0].excerpts[0].text;
    await new Promise(resolve=>setTimeout(resolve,55));
    active--;
    return {text:JSON.stringify(summaryFor(prompt,{quote})),finishReason:'stop',totalUsage:{inputTokens:3,outputTokens:2}};
  }});
  const first={root:'/work/first'};
  const second={root:'/work/second'};
  await assistant.ingest({...first,sessionId:'journal-first',messages:[{
    id:'initial',role:'user',timestamp:1,content:'第一次记录中的旧方向需要被新消息覆盖。'
  }]},{schedule:false});
  const firstView=await assistant.view(first);
  assistant.schedule(firstView.workId,0);
  await until(()=>calls===1);

  await assistant.observe({
    type:'message_end',workRoot:first.root,workAssistantSessionId:'journal-first',
    message:{id:'later',role:'user',timestamp:2,content:'最新确认改为先汇总全 Work 的多会话脉络。'}
  });
  await assistant.observe({type:'session_settled',workRoot:first.root,workAssistantSessionId:'journal-first'});
  await assistant.ingest({...second,sessionId:'journal-second',messages:[{
    id:'other',role:'user',timestamp:3,content:'另一个 Work 的摘要也需要顺序处理。'
  }]},{schedule:false});
  assistant.schedule((await assistant.view(second)).workId,0);

  await until(async()=>{
    const [one,two]=await Promise.all([assistant.view(first),assistant.view(second)]);
    return calls>=3&&one.summaryRevision===one.sourceRevision&&two.summaryRevision===two.sourceRevision;
  },{timeoutMs:4000});
  const [one,two]=await Promise.all([assistant.view(first),assistant.view(second)]);
  assert.equal(maxActive,1);
  assert.equal(calls,3,'第一份旧版本结果应丢弃，并在 settled 后只重新汇总一次');
  assert.equal(one.summary.overview.sources[0].quote,'最新确认改为先汇总全 Work 的多会话脉络。');
  assert.ok(two.summary);
});

test('evicting a session after source filtering still revises the Work and counts only retained text',async t=>{
  const {assistant}=await fixture(t,{run:async()=>{throw Error('unexpected model call');}});
  const root='/work/session-cap';
  for(let index=0;index<100;index++){
    await assistant.ingest({root,sessionId:`session-${index}`,title:`会话 ${index}`,lastActivityAt:index+1,
      messages:[{id:`message-${index}`,role:'user',timestamp:index+1,content:`第 ${index} 个会话留下了可汇总的工作背景。`}]},{schedule:false});
  }
  const before=await assistant.view({root});
  await assistant.ingest({root,sessionId:'session-100',title:'',lastActivityAt:200,
    messages:[{role:'tool',content:'此条消息会被安全过滤'}]},{schedule:false});
  const after=await assistant.view({root});
  assert.equal(after.sessions.length,100);
  assert.equal(after.sourceRevision,before.sourceRevision+1);
  assert.equal(after.coverage.droppedSessions,1);
  assert.equal(after.coverage.droppedMessages,before.coverage.droppedMessages+1);
});

test('per-session trimming records the first overflow',async t=>{
  const {assistant}=await fixture(t,{run:async()=>{throw Error('unexpected model call');}});
  const messages=Array.from({length:222},(_,index)=>( {
    id:`message-${index}`,
    role:index%2?'assistant':'user',
    timestamp:index+1,
    content:`第 ${index} 条公开消息包含可以留存并归入整个 Work 的上下文。`
  }));
  const snapshot=await assistant.ingest({root:'/work/message-cap',sessionId:'journal-cap',authoritative:true,messages},{schedule:false});
  assert.equal(snapshot.sessions[0].messageCount,222);
  assert.equal(snapshot.sessions[0].visibleMessages,220);
  assert.equal(snapshot.coverage.droppedMessages,2);
  assert.equal(snapshot.sourceRevision,1);
});

test('initial persistence failure releases the active summary slot for retry',async t=>{
  let calls=0;
  const {assistant}=await fixture(t,{run:async(_config,_instructions,prompt)=>{
    calls++;
    return {text:JSON.stringify(summaryFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:2,outputTokens:1}};
  }});
  const identity={root:'/work/write-failure'};
  await assistant.ingest({...identity,sessionId:'session-1',messages:[{
    id:'message-1',role:'user',timestamp:1,content:'这段公开记录支持下一步继续整理 Work 协作摘要。'
  }]},{schedule:false});
  const workId=(await assistant.view(identity)).workId;
  const persist=assistant.persist.bind(assistant);
  let failFirstWrite=true;
  assistant.persist=(...args)=>{
    if(failFirstWrite){
      failFirstWrite=false;
      return Promise.reject(Error('simulated disk write failure'));
    }
    return persist(...args);
  };

  await assistant.summarize(workId);
  assert.equal(assistant.active.has(workId),false);
  assert.equal((await assistant.view(identity)).status,'error');

  await assistant.summarize(workId);
  assert.equal(calls,1);
  assert.equal((await assistant.view(identity)).summaryRevision,(await assistant.view(identity)).sourceRevision);
});

test('Work synthesis uses a background deadline without capping reasoning output and records the attempt',async t=>{
  const {assistant}=await fixture(t,{run:async(config,_instructions,prompt,_signal,options,timeout)=>{
    assert.equal(config.timeoutSeconds,30);
    assert.equal(options.maxOutputTokens,undefined);
    assert.deepEqual(timeout,{stepMs:600000,totalMs:600000});
    return {text:JSON.stringify(summaryFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:8,outputTokens:4}};
  }});
  assistant.config=async()=>({baseURL:'http://fixture.invalid/v1',model:'fixture',timeoutSeconds:30});
  const input={root:'/work/background-summary'};
  const collected=await assistant.ingest({...input,sessionId:'session',messages:[{id:'m1',role:'user',content:'完整汇总这个 Work 的多会话讨论，并保留引用。'}]},{schedule:false});
  await assistant.summarize(collected.workId);
  const result=await assistant.view(input);
  assert.equal(result.status,'idle');assert.ok(result.summary);assert.ok(result.lastAttemptAt>0);assert.ok(result.updatedAt>=result.lastAttemptAt);
});

test('summary failures preserve sanitized model diagnostics and never expose arbitrary upstream text',async t=>{
  let failure=Object.assign(Error('辅助模型请求超时或已取消'),{publicMessage:'辅助模型请求超时或已取消'});
  const {assistant,directory}=await fixture(t,{run:async()=>{throw failure;}});
  const identity={root:'/work/diagnostics'};
  const collected=await assistant.ingest({...identity,sessionId:'session',messages:[{id:'m1',role:'user',content:'需要整理当前工作中尚未完成的事项。'}]},{schedule:false});
  await assistant.summarize(collected.workId);
  let result=await assistant.view(identity);
  assert.equal(result.error,'辅助模型请求超时或已取消');assert.ok(result.lastAttemptAt>0);assert.equal(result.updatedAt,0);
  failure=Error('PRIVATE_PROMPT API_KEY_SECRET arbitrary response');
  await assistant.summarize(collected.workId);result=await assistant.view(identity);
  assert.equal(result.status,'error');assert.ok(!/PRIVATE_PROMPT|API_KEY_SECRET/.test(result.error));
  const saved=await fs.readFile(path.join(directory,collected.workId+'.json'),'utf8');assert.ok(!saved.includes('API_KEY_SECRET'));
  assistant.config=async()=>{throw Error('已保存的 API Key 无法解密，请重新填写');};
  await assistant.summarize(collected.workId);assert.equal((await assistant.view(identity)).error,'已保存的 API Key 无法解密，请重新填写');
});

test('truncated model output remains a failed attempt and cannot masquerade as a validated summary',async t=>{
  const {assistant}=await fixture(t,{run:async()=>({text:'{"overview":',finishReason:'length',totalUsage:{inputTokens:10,outputTokens:4096}})});
  const identity={root:'/work/truncated-summary'};
  const collected=await assistant.ingest({...identity,sessionId:'session',messages:[{id:'m1',role:'user',content:'汇总任务当前的决定和下一步计划。'}]},{schedule:false});
  await assistant.summarize(collected.workId);const result=await assistant.view(identity);
  assert.match(result.error,/截断/);assert.equal(result.summary,null);assert.equal(result.summaryRevision,0);assert.equal(result.usedTokens,4106);
});

test('opening a legacy failed summary retries the new protocol once, without a polling retry loop',async t=>{
  let calls=0;
  const {assistant,directory}=await fixture(t,{run:async(_config,_instructions,prompt)=>{
    calls++;
    return {text:JSON.stringify(summaryFor(prompt,{quote:'这段原文中不存在的伪造引用'})),finishReason:'stop',totalUsage:{inputTokens:5,outputTokens:3}};
  }});
  const identity={root:'/work/legacy-failure'};
  const snapshot=await assistant.ingest({...identity,sessionId:'session',messages:[{id:'m1',role:'user',content:'旧版本的摘要失败后需要自动恢复一次。'}]},{schedule:false});
  const {state,identity:resolved}=await assistant.load(identity);
  state.status='error';state.error='Work 摘要暂未生成，请检查辅助模型设置和连接';
  delete state.summaryFormatVersion;
  await assistant.persist(resolved,state);
  assistant.states.delete(snapshot.workId);
  assert.equal((await assistant.view(identity)).status,'collecting');
  await until(async()=> (await assistant.view(identity)).status==='error');
  for(let i=0;i<4;i++)await assistant.view(identity);
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(calls,1);
  const saved=JSON.parse(await fs.readFile(path.join(directory,snapshot.workId+'.json'),'utf8'));
  assert.equal(saved.summaryFormatVersion,2);
  assistant.states.delete(snapshot.workId);
  assert.equal((await assistant.view(identity)).status,'error');
  assert.equal(calls,1,'restart must not silently retry an already attempted v2 failure');
});

test('a direct history ingest that finishes loading after close does not mutate or persist',async t=>{
  const {assistant,directory}=await fixture(t,{run:async()=>{throw Error('unexpected model call');}});
  let release;
  let loadStarted;
  const loadGate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{loadStarted=resolve;});
  const load=assistant.load.bind(assistant);
  assistant.load=async input=>{
    loadStarted();
    await loadGate;
    return load(input);
  };
  const pending=assistant.ingest({root:'/work/late-history',sessionId:'session-1',messages:[{
    id:'message-1',role:'user',timestamp:1,content:'这是需要被阻止的迟到历史导入。'
  }]},{schedule:false});
  await started;
  await assistant.close();
  release();
  await assert.rejects(pending,/已关闭/);
  assert.deepEqual(await fs.readdir(directory),[]);
});
