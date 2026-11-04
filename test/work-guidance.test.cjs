const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {WorkAssistant}=require('../src/work-assistant.cjs');
const {WorkGuidance}=require('../src/work-guidance.cjs');

function completionFor(prompt,assetLimit=1){
  const input=JSON.parse(prompt);
  const source=input.sources.find(item=>item.role==='user');
  const completions=source?[{
    text:'，先保留构建日志并列出未决问题。',
    reason:'沿用此前确认的工作顺序。',
    basis:'inferred',
    sources:[{
      sessionId:source.sessionId,
      messageId:source.messageId,
      role:source.role,
      quote:source.text.slice(0,Math.min(80,source.text.length))
    }]
  }]:[];
  return {
    completions,
    assets:input.assets.slice(0,assetLimit).map(asset=>({id:asset.id,reason:'资料名称与当前构建日志任务相符。'}))
  };
}

async function waitUntil(predicate,timeoutMs=2500){
  const start=Date.now();
  while(Date.now()-start<timeoutMs){
    if(await predicate())return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('等待 Work 提示状态超时');
}

async function fixture(t,{run,minIntervalMs=0,assets,readAsset,configVersion}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-work-guidance-'));
  const defaultAsset={
    id:'asset-build-log',path:'notes/构建日志.md',title:'构建日志整理',kind:'note',
    version:'catalog-v1',origin:'work-file',snapshot:true,modifiedAt:'2026-11-04T00:00:00Z'
  };
  let version=0;
  const assistant=new WorkAssistant({
    directory:path.join(directory,'assistant'),
    localScope:'guidance-fixture-user',
    debounceMs:60000,
    agent:{run:async()=>{throw Error('Work summary is not expected in this fixture');}},
    config:async()=>({baseURL:'http://fixture.invalid/v1',model:'fixture'})
  });
  const guidance=new WorkGuidance({
    assistant,
    agent:{run:run||(async(_config,_instructions,prompt)=>({
      text:JSON.stringify(completionFor(prompt)),
      finishReason:'stop',
      totalUsage:{inputTokens:12,outputTokens:5}
    }))},
    config:async()=>({baseURL:'http://fixture.invalid/v1',model:'fixture'}),
    configVersion:configVersion||(()=>version),
    resolveWork:async()=>true,
    listAssets:async()=>({available:true,assets:assets||[defaultAsset]}),
    readAsset:readAsset||(async(identity,asset)=>({
      ...asset,...identity,snapshotVersion:'snapshot-v1',sourceHash:'a'.repeat(64),
      content:'这是用户选中后才读取的资料快照正文。',truncated:false
    })),
    minIntervalMs
  });
  t.after(async()=>{
    await guidance.close();
    await assistant.close();
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {assistant,guidance,directory,setVersion:value=>{version=value;},defaultAsset};
}

async function seed(assistant,root='/work/demo'){
  await assistant.ingest({root,sessionId:'journal-build',title:'构建日志',messages:[{
    id:'user-build',role:'user',timestamp:1,
    content:'用户确认先整理构建日志，再修改代码，并保留未决问题。'
  }]},{schedule:false});
  await assistant.ingest({root,sessionId:'journal-follow-up',title:'后续交接',messages:[{
    id:'assistant-follow-up',role:'assistant',timestamp:2,
    content:'下一次会话应沿用已经确认的构建日志整理顺序。'
  }]},{schedule:false});
}

test('suggestions cite current multi-session evidence and send only shortlisted asset metadata',async t=>{
  let promptSeen='',agentCalls=0;
  const rows=[
    {id:'asset-build',path:'notes/构建日志.md',title:'构建日志整理',kind:'note',version:'v1',origin:'work-file',snapshot:true},
    {id:'asset-db',path:'scripts/database-migration.py',title:'数据库迁移脚本',kind:'script',version:'v1',origin:'work-file',snapshot:false}
  ];
  const {assistant,guidance,directory}=await fixture(t,{
    assets:rows,
    run:async(_config,_instructions,prompt)=>{
      agentCalls++;promptSeen=prompt;
      const payload=JSON.parse(prompt);
      assert.equal(payload.sources.length,2);
      assert.deepEqual(payload.assets.map(item=>item.id),['asset-build']);
      assert.ok(payload.assets.every(item=>!Object.hasOwn(item,'content')));
      return {text:JSON.stringify(completionFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:12,outputTokens:5}};
    }
  });
  await seed(assistant);
  const draft='请沿用构建日志的处理顺序';
  const result=await guidance.call('suggest',{
    root:'/work/demo',sessionKey:'draft-key-one',revision:5,draft,caret:draft.length
  });
  const evidence=await assistant.evidence({root:'/work/demo'});
  assert.equal(result.status,'complete',result.error);
  assert.equal(result.sourceRevision,evidence.sourceRevision);
  assert.match(result.draftHash,/^[a-f0-9]{64}$/);
  assert.equal(result.completions.length,1);
  assert.equal(result.completions[0].basis,'inferred');
  assert.equal(result.completions[0].sources[0].quote,'用户确认先整理构建日志，再修改代码，并保留未决问题。');
  assert.deepEqual(result.assets.map(item=>item.id),['asset-build']);
  assert.equal(result.draft,undefined);
  assert.equal(agentCalls,1);
  assert.ok(promptSeen.includes(draft));

  await guidance.close();
  for(const filename of await fs.readdir(path.join(directory,'assistant'))){
    const contents=await fs.readFile(path.join(directory,'assistant',filename),'utf8');
    assert.ok(!contents.includes(draft),'draft text must not be persisted by Work guidance');
  }
});

test('completion insertion preserves model whitespace and newlines around the caret',async t=>{
  const insertion=' compare the build output \n';
  const {assistant,guidance}=await fixture(t,{run:async(_config,_instructions,prompt)=>{
    const output=completionFor(prompt);
    output.completions[0].text=insertion;
    return {text:JSON.stringify(output),finishReason:'stop',totalUsage:{inputTokens:1,outputTokens:1}};
  }});
  await seed(assistant);
  const draft='Build logsummary',caret='Build log'.length;
  const result=await guidance.call('suggest',{
    root:'/work/demo',sessionKey:'whitespace-key',revision:1,draft,caret
  });
  assert.equal(result.status,'complete',result.error);
  assert.equal(result.completions[0].text,insertion);
  assert.equal(draft.slice(0,caret)+result.completions[0].text+draft.slice(caret),
    'Build log compare the build output \nsummary');
});

test('known private draft content is blocked before the model call',async t=>{
  let calls=0;
  const {assistant,guidance}=await fixture(t,{run:async()=>{calls++;throw Error('must not run');}});
  await seed(assistant);
  const draft='请用 api_key=Abc123456_secret 继续工作';
  const result=await guidance.call('suggest',{
    root:'/work/demo',sessionKey:'private-draft',revision:1,draft,caret:draft.length
  });
  assert.equal(result.status,'error');
  assert.match(result.error,/疑似凭据/);
  assert.equal(calls,0);
  assert.equal(result.draft,undefined);
});

test('Work assistant pause blocks suggestions, and auxiliary configuration changes cancel active calls',async t=>{
  let calls=0;
  const {assistant,guidance}=await fixture(t,{run:async(_config,_instructions,prompt,signal)=>{
    calls++;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(resolve,100);
      signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('aborted'));},{once:true});
    });
    return {text:JSON.stringify(completionFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:1,outputTokens:1}};
  }});
  await seed(assistant);
  const draft='请继续整理构建日志';
  await assistant.configure({root:'/work/demo'},{enabled:false});
  const paused=await guidance.call('suggest',{
    root:'/work/demo',sessionKey:'pause-key',revision:1,draft,caret:draft.length
  });
  assert.equal(paused.status,'paused');
  assert.equal(calls,0);

  await assistant.configure({root:'/work/demo'},{enabled:true});
  const pending=guidance.call('suggest',{
    root:'/work/demo',sessionKey:'pause-key',revision:2,draft:draft+'并保留未决项',caret:draft.length+6
  });
  await waitUntil(()=>calls===1);
  await guidance.configurationChanged();
  assert.equal((await pending).status,'stale');
  assert.equal(calls,1);
});

test('invalid citations fail closed, charge returned usage, and do not retry by themselves',async t=>{
  let calls=0;
  const {assistant,guidance}=await fixture(t,{run:async(_config,_instructions,prompt)=>{
    calls++;
    const output=completionFor(prompt);
    output.completions[0].sources[0].quote='此引用不是会话原文';
    return {text:JSON.stringify(output),finishReason:'stop',totalUsage:{inputTokens:7,outputTokens:4}};
  }});
  await seed(assistant);
  const draft='请补上构建日志与未决事项';
  const result=await guidance.call('suggest',{
    root:'/work/demo',sessionKey:'bad-citation',revision:3,draft,caret:draft.length
  });
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(result.status,'error');
  assert.match(result.error,/出处未通过核对/);
  assert.equal(result.usedTokens,11);
  assert.equal(calls,1);
});

test('newer typing cancels in-flight and pending suggestions, retaining only the newest draft',async t=>{
  const calls=[];
  let active=0,maxActive=0;
  const {assistant,guidance}=await fixture(t,{run:async(_config,_instructions,prompt,signal)=>{
    const payload=JSON.parse(prompt);
    calls.push(payload.draft);
    active++;
    maxActive=Math.max(maxActive,active);
    try{
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(resolve,70);
        signal.addEventListener('abort',()=>{
          clearTimeout(timer);
          reject(Error('aborted'));
        },{once:true});
      });
      return {text:JSON.stringify(completionFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:1,outputTokens:1}};
    }finally{active--;}
  }});
  await seed(assistant);
  const identity={root:'/work/demo',sessionKey:'same-draft-key'};
  const firstDraft='第一版构建日志处理提示';
  const first=guidance.call('suggest',{...identity,revision:1,draft:firstDraft,caret:firstDraft.length});
  await waitUntil(()=>calls.length===1);
  const middleDraft='中间版构建日志处理提示';
  const middle=guidance.call('suggest',{...identity,revision:2,draft:middleDraft,caret:middleDraft.length});
  const latestDraft='最新确认先归纳构建日志问题';
  const latest=guidance.call('suggest',{...identity,revision:3,draft:latestDraft,caret:latestDraft.length});
  const [oldResult,middleResult,latestResult]=await Promise.all([first,middle,latest]);
  assert.equal(oldResult.status,'cancelled');
  assert.equal(middleResult.status,'cancelled');
  assert.equal(latestResult.status,'complete');
  assert.deepEqual(calls,[firstDraft,latestDraft]);
  assert.equal(maxActive,1);
});

test('cancelling a stuck asset catalog releases the serial pump and close',async t=>{
  let stuckCatalogCalls=0,modelCalls=0;
  const {assistant,guidance}=await fixture(t,{run:async(_config,_instructions,prompt)=>{
    modelCalls++;
    return {text:JSON.stringify(completionFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:1,outputTokens:1}};
  }});
  await seed(assistant,'/work/stuck-catalog');
  await seed(assistant,'/work/next-work');
  guidance.listAssets=async({root})=>{
    if(root==='/work/stuck-catalog'){
      stuckCatalogCalls++;
      return new Promise(()=>{});
    }
    return {available:false,assets:[],notice:'无资料'};
  };
  const draft='继续整理构建日志';
  const stuckIdentity={root:'/work/stuck-catalog',sessionKey:'stuck-catalog-key'};
  const stuck=guidance.call('suggest',{
    ...stuckIdentity,revision:1,draft,caret:draft.length
  });
  await waitUntil(()=>stuckCatalogCalls===1);
  const cancelled=await guidance.call('cancel',{
    ...stuckIdentity,revision:1
  });
  assert.equal(cancelled.status,'cancelled');
  assert.equal((await stuck).status,'cancelled');

  const next=await guidance.call('suggest',{
    root:'/work/next-work',sessionKey:'next-work-key',revision:1,draft,caret:draft.length
  });
  assert.equal(next.status,'complete');
  assert.equal(modelCalls,1);
  const closed=await Promise.race([
    guidance.close().then(()=>true),
    new Promise(resolve=>setTimeout(()=>resolve(false),300))
  ]);
  assert.equal(closed,true,'close must not wait for the unresolved catalog Promise');
});

test('a Work source revision invalidates running suggestions and issued material requests',async t=>{
  let calls=0,readCount=0;
  const {assistant,guidance}=await fixture(t,{run:async(_config,_instructions,prompt,signal)=>{
    calls++;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(resolve,100);
      signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('aborted'));},{once:true});
    });
    return {text:JSON.stringify(completionFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:1,outputTokens:1}};
  },readAsset:async(identity,asset)=>{
    readCount++;
    return {...asset,...identity,content:'已选择的快照。',snapshotVersion:'snap-v1',sourceHash:'a'.repeat(64),truncated:false};
  }});
  await seed(assistant);
  const draft='请继续整理构建日志';
  const pending=guidance.call('suggest',{
    root:'/work/demo',sessionKey:'source-change',revision:1,draft,caret:draft.length
  });
  await waitUntil(()=>calls===1);
  await assistant.ingest({root:'/work/demo',sessionId:'journal-build',messages:[{
    id:'new-user',role:'user',timestamp:3,content:'后来决定增加一次构建失败原因复核。'
  }]},{schedule:false});
  guidance.sourceChanged(await assistant.view({root:'/work/demo'}));
  const result=await pending;
  assert.equal(result.status,'stale');
  await assert.rejects(guidance.call('material',{
    root:'/work/demo',sessionKey:'source-change',requestId:result.requestId,assetId:'asset-build-log'
  }));
  assert.equal(readCount,0);
});

test('material is bound to Work, recommendation, catalog version and selected snapshot',async t=>{
  let catalogVersion='catalog-v1',readCount=0;
  const asset={id:'asset-build-log',path:'notes/构建日志.md',title:'构建日志整理',kind:'note',
    version:'catalog-v1',origin:'work-file',snapshot:true};
  const {assistant,guidance}=await fixture(t,{
    assets:[asset],
    run:async(_config,_instructions,prompt)=>({
      text:JSON.stringify(completionFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:2,outputTokens:1}
    }),
    readAsset:async(identity,selected)=>{
      readCount++;
      return {...selected,...identity,version:selected.version,snapshotVersion:'immutable-snapshot-4',
        sourceHash:'b'.repeat(64),content:'这是用户明确选择的快照片段。',truncated:false};
    }
  });
  guidance.listAssets=async()=>({available:true,assets:[{...asset,version:catalogVersion}]});
  await seed(assistant);
  const draft='请核对构建日志处理步骤';
  const suggestion=await guidance.call('suggest',{
    root:'/work/demo',sessionKey:'material-key',revision:1,draft,caret:draft.length
  });
  assert.equal(suggestion.status,'complete');
  const foreign=guidance.call('material',{
    root:'/work/other',sessionKey:'material-key',requestId:suggestion.requestId,assetId:asset.id
  });
  await assert.rejects(foreign,/不属于当前 Work/);

  const material=await guidance.call('material',{
    root:'/work/demo',sessionKey:'material-key',requestId:suggestion.requestId,assetId:asset.id
  });
  assert.equal(material.content,'这是用户明确选择的快照片段。');
  assert.equal(material.version,'catalog-v1');
  assert.equal(material.snapshotVersion,'immutable-snapshot-4');
  assert.equal(material.truncated,false);
  assert.equal(readCount,1);

  catalogVersion='catalog-v2';
  await assert.rejects(guidance.call('material',{
    root:'/work/demo',sessionKey:'material-key',requestId:suggestion.requestId,assetId:asset.id
  }),/版本已变化/);
  assert.equal(readCount,1,'stale catalog versions must not be read');
});

test('cache rebinds identical draft content to the new revision without another model call',async t=>{
  let calls=0;
  const {assistant,guidance}=await fixture(t,{run:async(_config,_instructions,prompt)=>{
    calls++;
    return {text:JSON.stringify(completionFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:4,outputTokens:2}};
  }});
  await seed(assistant);
  const draft='请继续沿用构建日志的整理顺序';
  const query={root:'/work/demo',sessionKey:'cache-key',draft,caret:draft.length};
  const first=await guidance.call('suggest',{...query,revision:1});
  const second=await guidance.call('suggest',{...query,revision:2});
  assert.equal(first.status,'complete');
  assert.equal(second.status,'complete');
  assert.equal(second.revision,2);
  assert.notEqual(second.requestId,first.requestId);
  assert.equal(second.cached,true);
  assert.equal(second.usedTokens,0);
  assert.equal(calls,1);
});

test('cache misses when recommendation feedback or shortlisted asset versions change',async t=>{
  const prompts=[];
  const {assistant,guidance,defaultAsset}=await fixture(t,{
    run:async(_config,_instructions,prompt)=>{
      prompts.push(JSON.parse(prompt));
      return {text:JSON.stringify(completionFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:1,outputTokens:1}};
    }
  });
  await seed(assistant);
  const draft='请继续整理构建日志并标出待办';
  const identity={root:'/work/demo',sessionKey:'cache-input-key'};
  const first=await guidance.call('suggest',{...identity,revision:1,draft,caret:draft.length});
  const sameInputs=await guidance.call('suggest',{...identity,revision:2,draft,caret:draft.length});
  assert.equal(sameInputs.cached,true);
  assert.equal(prompts.length,1);

  await guidance.call('feedback',{
    ...identity,requestId:sameInputs.requestId,completionId:sameInputs.completions[0].id,feedback:'ignored'
  });
  const afterFeedback=await guidance.call('suggest',{...identity,revision:3,draft,caret:draft.length});
  assert.equal(afterFeedback.cached,undefined);
  assert.equal(prompts.length,2);
  assert.equal(prompts[1].feedback.ignored,1);

  guidance.listAssets=async()=>({available:true,assets:[{...defaultAsset,version:'catalog-v2'}]});
  const afterAssetUpdate=await guidance.call('suggest',{...identity,revision:4,draft,caret:draft.length});
  assert.equal(afterAssetUpdate.cached,undefined);
  assert.equal(prompts.length,3);
  assert.equal(prompts[2].assets[0].version,'catalog-v2');
});

test('feedback is aggregate-only and is included in later Work suggestions',async t=>{
  const prompts=[];
  const {assistant,guidance}=await fixture(t,{run:async(_config,_instructions,prompt)=>{
    prompts.push(JSON.parse(prompt));
    return {text:JSON.stringify(completionFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:1,outputTokens:1}};
  }});
  await seed(assistant);
  const draft='请继续完成构建日志整理';
  const identity={root:'/work/demo',sessionKey:'feedback-key'};
  const first=await guidance.call('suggest',{...identity,revision:1,draft,caret:draft.length});
  const recorded=await guidance.call('feedback',{
    ...identity,requestId:first.requestId,completionId:first.completions[0].id,feedback:'accepted'
  });
  assert.equal(recorded.ok,true);
  await guidance.call('suggest',{...identity,revision:2,draft:draft+'，并标记风险',caret:draft.length+6});
  assert.equal(prompts.length,2);
  assert.equal(prompts[1].feedback.accepted,1);
  assert.equal(Object.hasOwn(prompts[1],'previousDraft'),false);
});

test('the model queue serializes different Works and applies the configured per-Work interval',async t=>{
  let active=0,maxActive=0;
  const started=[];
  const {assistant,guidance}=await fixture(t,{minIntervalMs:50,run:async(_config,_instructions,prompt,signal)=>{
    const payload=JSON.parse(prompt);
    started.push({draft:payload.draft,at:Date.now()});
    active++;
    maxActive=Math.max(maxActive,active);
    try{
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(resolve,25);
        signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('aborted'));},{once:true});
      });
      return {text:JSON.stringify(completionFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:1,outputTokens:1}};
    }finally{active--;}
  }});
  await seed(assistant,'/work/first');
  await seed(assistant,'/work/second');
  const firstDraft='处理构建日志并保留问题';
  const first=guidance.call('suggest',{
    root:'/work/first',sessionKey:'first-draft',revision:1,draft:firstDraft,caret:firstDraft.length
  });
  await waitUntil(()=>started.length===1);
  const secondDraft='处理构建日志并列出下一步';
  const second=guidance.call('suggest',{
    root:'/work/second',sessionKey:'second-draft',revision:1,draft:secondDraft,caret:secondDraft.length
  });
  const [one,two]=await Promise.all([first,second]);
  assert.equal(one.status,'complete');
  assert.equal(two.status,'complete');
  assert.equal(maxActive,1);
  assert.equal(started.length,2);
  assert.deepEqual(started.map(item=>item.draft),[firstDraft,secondDraft]);
});

test('the minimum model interval is enforced between requests for the same Work',async t=>{
  const started=[];
  const {assistant,guidance}=await fixture(t,{minIntervalMs:50,run:async(_config,_instructions,prompt)=>{
    started.push(Date.now());
    return {text:JSON.stringify(completionFor(prompt)),finishReason:'stop',totalUsage:{inputTokens:1,outputTokens:1}};
  }});
  await seed(assistant);
  const firstDraft='整理构建日志并保留问题';
  const first=await guidance.call('suggest',{
    root:'/work/demo',sessionKey:'throttle-key',revision:1,draft:firstDraft,caret:firstDraft.length
  });
  const secondDraft='整理构建日志并列出下一步';
  const second=await guidance.call('suggest',{
    root:'/work/demo',sessionKey:'throttle-key',revision:2,draft:secondDraft,caret:secondDraft.length
  });
  assert.equal(first.status,'complete');
  assert.equal(second.status,'complete');
  assert.equal(started.length,2);
  assert.ok(started[1]-started[0]>=40);
});
