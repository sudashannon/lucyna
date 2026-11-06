// Production renderer plus the real WorkAssistant service and a deterministic local agent.
// The service data, fake agent, and UI profile are isolated under this test run's .runtime folder.
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {WorkAssistant}=require('../src/work-assistant.cjs');
const {withSummaryReconciliation}=require('./work-summary-fixture.test.cjs');
const out=path.resolve('.runtime/work-assistant-desktop-'+Date.now()),profile=path.join(out,'profile');
fs.mkdirSync(profile,{recursive:true});
require('./desktop-log.cjs').installDesktopLog(out);
require('../src/app-identity.cjs').configureAppIdentity(app,{LUCYNA_USERDATA:profile});
app.disableHardwareAcceleration();

const root='/demo/work-assistant',secondRoot='/demo/work-assistant-second';
const baseTime=Date.UTC(2026,10,3,4,5,0);
const message='先整理多个 OMP 会话中关于构建流程的目标，再明确待验证步骤。';
const detail=(workRoot,name)=>({root:workRoot,name,content:`# ${name}\n\n## 目标\n- 归并多个会话中的工作信息\n`,modifiedAt:baseTime,fetchedAt:baseTime,kind:'work',issues:[],warnings:[],members:[],assets:[{path:'notes/构建流程.md',name:'构建流程.md',title:'构建流程笔记',kind:'note',indexed:true,size:2048,modifiedAt:baseTime}]});
const material={id:'isolated-material-1',root,relative:'notes/构建流程.md',title:'构建流程笔记',category:'work-note',metadata:{createdAt:new Date(baseTime).toISOString(),sourceHash:'a'.repeat(64),snapshot:true,policy:{label:'Work 专属资料',reason:'Work 内部文本快照'}}};
let win,holdReplyRoot='',releaseReply=null,promptCalls=0,malformedSummaryResponses=0;
const notifications=[];
const citationSessionFile='C:\\fixture\\citation-session.jsonl';
const citationEntry={sessionFile:citationSessionFile,agentDir:'/fixture/agent',runtime:'wsl',title:'构建流程讨论'};
const citationMessages=Array.from({length:110},(_,index)=>({
  type:'message',id:index===12?'user-message-001':`fixture-message-${index}`,
  timestamp:baseTime+index*60000,
  message:{role:index%2===0?'user':'assistant',timestamp:baseTime+index*60000,
    content:index===12?message:index%2===0?`第 ${index} 条用户记录支持定位较早的时间轴出处。`:`第 ${index} 条助手记录保留在会话时间轴中。`}
}));
const summaryRequests=[];
const summaryFixtureSources=payload=>(payload.messages||[]).filter(item=>item.role==='user'&&item.excerpts?.[0]);
const allPriorSummaryHandles=payload=>{
  const handles=[];
  if(payload.previousSummary?.overview?.id)handles.push('overview');
  for(const [section,prefix]of [['goals','g'],['decisions','d'],['progress','p'],['openQuestions','q'],['nextSteps','n']]){
    (payload.previousSummary?.[section]||[]).forEach((item,index)=>handles.push(item.id||`${prefix}${index+1}`));
  }
  return handles;
};
const assistant=new WorkAssistant({
  directory:path.join(out,'assistant-state'),debounceMs:60000,
  config:async()=>({baseURL:'http://deterministic.local',model:'fixture-agent'}),
  agent:{run:withSummaryReconciliation(async(_model,_instructions,input)=>{
    const payload=JSON.parse(input);
    summaryRequests.push(payload);
    if(malformedSummaryResponses>0){malformedSummaryResponses--;return {finishReason:'stop',text:'{"overview":',totalUsage:{inputTokens:2,outputTokens:1}};}
    const source=payload.messages.find(item=>item.messageId==='user-message-001')||payload.messages.find(item=>item.role==='user')||payload.messages[0];
    const citation={evidenceId:source.excerpts[0].evidenceId};
    if(payload.analysis?.mode==='incremental')return {finishReason:'stop',text:JSON.stringify({
      overview:{text:'增量消息已并入构建流程摘要。',sources:[citation]},changes:[]
    }),totalUsage:{inputTokens:9,outputTokens:6}};
    if(payload.analysis?.mode==='full'&&payload.previousSummary){
      return {finishReason:'stop',text:JSON.stringify({keep:allPriorSummaryHandles(payload),changes:[]}),totalUsage:{inputTokens:5,outputTokens:4}};
    }
    const summarySources=summaryFixtureSources(payload);
    const longSuggestions=Array.from({length:10},(_,index)=>{
      const text=`隔离 UI 样例 ${String(index+1).padStart(2,'0')}：${'在对应工作范围内检查实际输入与输出，记录核对方法、复现步骤和待确认结果，并根据已取得的证据整理下一步处理方式。'.repeat(index+1)}第 ${index+1} 项继续保留自己的引用，供界面检查展开阅读和原文跳转。`;
      const sourceCount=2+index%5;
      const sources=Array.from({length:Math.min(sourceCount,summarySources.length)},(_,offset)=>summarySources[(index*3+offset)%summarySources.length]);
      return {text,sources:sources.map(row=>({evidenceId:row.excerpts[0].evidenceId}))};
    });
    return {finishReason:'stop',text:JSON.stringify({
      overview:{text:'多个会话都在推进构建流程；下一步先核对执行环境和留出检查。',sources:[citation,citation]},
      changes:[
        {section:'goals',upsert:[{text:'归并会话中的构建目标与检查步骤。',sources:[citation]}],remove:[]},
        {section:'decisions',upsert:[{text:'将留出检查保持独立，结果由用户确认。',sources:[citation]}],remove:[]},
        {section:'progress',upsert:[{text:'已收集一条本机历史会话及其可见消息。',sources:[citation]}],remove:[]},
        {section:'openQuestions',upsert:[{text:'目标环境中的编译器版本尚未确认。',sources:[citation]}],remove:[]},
        {section:'nextSteps',upsert:longSuggestions,remove:[]}
      ]
    }),totalUsage:{inputTokens:31,outputTokens:22}};
  })},
  notify:event=>{
    const snapshot=event?.view||event;
    if(!snapshot?.root)return;
    notifications.push(snapshot);
    if(win&&!win.isDestroyed())win.webContents.send('work:assistant-event',snapshot);
  }
});

const preload=path.join(out,'preload.cjs');
fs.writeFileSync(preload,`const{contextBridge,ipcRenderer}=require('electron');const c=(n,...a)=>ipcRenderer.invoke(n,...a);const events=new Set();contextBridge.exposeInMainWorld('desktop',{
 mode:'desktop',listWorks:()=>c('works'),listConnections:async()=>[],readWork:(root,hostId)=>c('read',root,hostId),workDetails:(root,hostId)=>c('details',root,hostId),workGit:(...a)=>c('git',...a),listHistory:async()=>({sessions:[${JSON.stringify(citationEntry)}],managed:[]}),getSettings:async()=>({settings:{runtime:'wsl'},workspace:{root:'/demo'}}),copyText:async()=>{},onEvent:fn=>{events.add(fn);return()=>events.delete(fn);},onTerminal:()=>()=>{},readPreview:(r,p)=>c('preview',r,p),listFiles:async()=>({directory:'',entries:[],total:0,nextOffset:null}),start:async options=>{setTimeout(()=>{for(const fn of events)fn({type:'ready',clientSessionId:options.clientSessionId});},0);return{runtime:'wsl',agentDir:'/fixture/agent'};},request:(...a)=>c('request',...a),close:async()=>{},petContext:async()=>{},workAssistant:(operation,input)=>c('work-assistant',operation,input),workAssistantSource:input=>c('work:assistant-source',input),onWorkAssistant:fn=>{const listener=(_event,snapshot)=>fn(snapshot);ipcRenderer.on('work:assistant-event',listener);return()=>ipcRenderer.removeListener('work:assistant-event',listener);},workRun:(operation,input)=>c('work-run',operation,input),knowledgeRequest:(kind,args)=>c('knowledge',kind,args)
});`);

const fixture={
  [root]:{root,name:'assistant-demo',content:'# Assistant demo\n- 状态: active\n',modifiedAt:new Date(baseTime).toISOString(),fetchedAt:new Date(baseTime).toISOString(),kind:'work',issues:[],warnings:[],members:[],assets:detail(root,'assistant-demo').assets},
  [secondRoot]:{...detail(secondRoot,'second-work'),assets:[]}
};
ipcMain.handle('works',()=>Object.values(fixture).map(({root,name})=>({root,name,kind:'work'})));
ipcMain.handle('read',(_event,workRoot)=>fixture[workRoot]?.content||'');
ipcMain.handle('details',(_event,workRoot)=>fixture[workRoot]);
ipcMain.handle('preview',(_event,workRoot,file)=>({kind:'markdown',path:file,name:file.split('/').at(-1),content:fixture[workRoot]?.content||'Fixture preview'}));
ipcMain.handle('git',()=>({kind:'diff',text:''}));
let workAssistantSourceCalls=0;
ipcMain.handle('work:assistant-source',(_event,input)=>{
  workAssistantSourceCalls++;
  const sourceMessage=citationMessages.find(item=>item.id===input?.messageId);
  if(input?.root!==root||input?.sessionId!=='fixture-session-001'||!sourceMessage)throw Error(`摘要来源不存在或已从 Work 历史中移除：${JSON.stringify(input)}`);
  return {root,sessionId:input.sessionId,messageId:input.messageId,nativeMessageId:sourceMessage.id,role:sourceMessage.message.role,
    text:typeof sourceMessage.message.content==='string'?sourceMessage.message.content:message,at:sourceMessage.timestamp,entry:citationEntry};
});
ipcMain.handle('request',(_event,type)=>{
  if(type==='prompt'){promptCalls++;return {};}
  if(type==='get_messages')return {messages:citationMessages};
  if(type==='get_state')return {sessionFile:citationSessionFile,sessionId:'fixture-session-001',isSettled:true};
  return {};
});
ipcMain.handle('work-run',(_event,operation)=>{
  if(operation==='list')return [];
  if(operation==='get')return {run:null,events:[]};
  if(operation==='automatic-status')return {enabled:false,status:'disabled',label:'已暂停',message:'演示隔离状态',profile:null,preparation:null,runsToday:0,dailyLimit:4,idleSeconds:0,cooldownSeconds:600};
  return {};
});
ipcMain.handle('knowledge',async(_event,kind,args={})=>{
  if(kind==='workAssetList')return [];
  if(kind==='workAssetCapture')return {...material,root:args.root,relative:args.path};
  if(kind==='workAssetRead')return {...material,content:'编译流程：先确认 Python 与编译器版本，再执行本地检查。\n不要把未验证的输出当作通过。',base64:undefined};
  if(kind==='consolidationStatus')return {enabled:false,status:'disabled',label:'已暂停',message:'隔离测试状态',idleSeconds:0,cooldownSeconds:600,usedTokens:0,sourceCount:0,factCount:0,currentSource:'',skipped:[],history:[]};
  return {};
});
ipcMain.handle('work-assistant',async(_event,operation,args)=>{
  let snapshot;
  if(operation==='status')snapshot=await assistant.view(args);
  else if(operation==='refresh')snapshot=await assistant.refresh(args);
  else if(operation==='configure')snapshot=await assistant.configure(args,{enabled:args.enabled});
  else if(operation==='history'){
    await assistant.setHistoryCoverage(args,{available:2,loaded:1,skipped:1,limited:true,warnings:['跳过一条无效的本机历史记录'],checkedAt:Date.now()});
    snapshot=await assistant.view(args);
  }else throw Error('Unknown WorkAssistant operation');
  if(operation==='refresh'&&args.root===holdReplyRoot){holdReplyRoot='';await new Promise(resolve=>{releaseReply=resolve;});}
  return snapshot;
});

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),js=code=>win.webContents.executeJavaScript(code,true);
const click=selector=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing selector '+${JSON.stringify(selector)});e.click();})()`);
const button=(selector,label)=>js(`(()=>{const e=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(item=>item.textContent.trim().startsWith(${JSON.stringify(label)}));if(!e)throw Error('Missing button '+${JSON.stringify(label)});e.click();})()`);
async function until(condition,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await js('Boolean('+condition+')').catch(()=>false))return;await pause(70);}throw Error('Timeout: '+condition);}
async function untilReplyHeld(timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(releaseReply)return;await pause(25);}throw Error('Timed out waiting for delayed WorkAssistant response');}
const checks=[],consoleErrors=[];
async function shot(name){await js('document.fonts.ready');await pause(180);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),`${name}: horizontal overflow`);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
const pass=value=>{checks.push(value);console.log('PASS '+value);};
const chooseTheme=async theme=>{
  await js(`(()=>{const e=document.querySelector('select[aria-label="视觉主题"]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(e,${JSON.stringify(theme)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`document.documentElement.dataset.visualTheme===${JSON.stringify(theme)}`);
};
async function positionSummaryReader(){
  await js(`(()=>{const reader=document.querySelector('.work-summary-reader'),content=reader?.closest('.panel-content'),tabs=document.querySelector('.work-details>.wd-tabs');
    if(!reader||!content||!tabs)throw Error('Cannot position the summary reader below the sticky Work tabs');
    const readerTop=reader.getBoundingClientRect().top,tabsBottom=tabs.getBoundingClientRect().bottom;
    content.scrollTop+=readerTop-(tabsBottom+18);})()`);
  await pause(160);
}
const continueButton='.work-assistant-continue button';
const continueButtonStyle=`(()=>{
  const button=document.querySelector(${JSON.stringify(continueButton)});
  const style=getComputedStyle(button),face=getComputedStyle(button,'::before');
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
  const pixel=(...colors)=>{
    context.clearRect(0,0,1,1);
    for(const color of colors){context.fillStyle=color;context.fillRect(0,0,1,1);}
    return Array.from(context.getImageData(0,0,1,1).data);
  };
  const surface=getComputedStyle(button.closest('.tools-panel')).backgroundColor;
  return {disabled:button.disabled,opacity:style.opacity,faceAlpha:pixel(face.backgroundColor)[3],
    foreground:pixel(style.color),background:pixel(surface,face.backgroundColor),
    hint:document.getElementById(button.getAttribute('aria-describedby'))?.textContent};
})()`;
const luminance=rgb=>rgb.slice(0,3).reduce((sum,value,index)=>{
  const channel=value/255;
  const linear=channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4;
  return sum+linear*[0.2126,0.7152,0.0722][index];
},0);

app.whenReady().then(async()=>{
  const timer=setTimeout(()=>app.exit(2),100000);
  try{
    win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)consoleErrors.push(message);});
    await win.loadFile(path.resolve('dist/renderer/index.html'));
    await until('document.querySelectorAll(".work-row").length===2');
    await click('.work-row');await click('#tab-work');
    await until('document.querySelector(".work-assistant")');
    assert.ok(await js('document.querySelector(".work-details>.wd-tabs button[aria-pressed=true]").textContent.includes("Work 助手")'));
    await until('document.querySelector(".work-assistant-empty")');
    assert.equal(await js('!!document.querySelector(".work-assistant-analysis")'),false,
      'an unstarted summary does not show zero as an actual analysis count');
    pass('Work助手 is the default Work tab and shows an honest empty state');

    const fixtureEvidence=Array.from({length:12},(_,index)=>({
      id:`fixture-message-${index*2}`,role:'user',timestamp:baseTime+index*120000,
      content:`第 ${index+1} 条隔离用户证据用于核对工作流程和建议来源。`
    }));
    await assistant.ingest({root,sessionId:'fixture-session-001',title:'构建流程讨论',lastActivityAt:baseTime+12*120000,messages:[
      ...fixtureEvidence,
      {id:'user-message-001',role:'user',timestamp:baseTime,content:message},
      {id:'assistant-message-001',role:'assistant',timestamp:baseTime+30000,content:[{type:'text',text:'我会先核对本地构建环境，再确认未决的留出检查。'}]}
    ]});
    await until('document.querySelector(".work-assistant-coverage")?.textContent.includes("1 条会话已纳入资料")');
    assert.ok(notifications.some(value=>value.root===root&&typeof value.sourceRevision==='number'&&typeof value.updatedAt==='number'));
    malformedSummaryResponses=2;
    await button('.work-assistant-controls button','更新摘要');
    await until('document.querySelector(".work-assistant-status")?.textContent.includes("摘要生成失败")');
    const generationFailure=await assistant.view({root});
    assert.equal(generationFailure.summary,null,'a malformed first response does not create a summary');
    assert.equal(await js('document.querySelector(".work-assistant-heading").nextElementSibling?.classList.contains("work-assistant-summary-error")'),true,
      'the first summary failure is placed immediately after its heading');
    const generationErrorText=await js('document.querySelector(".work-assistant-summary-error")?.textContent||""');
    assert.ok(generationErrorText.includes(generationFailure.error),generationErrorText);
    assert.equal(await js(`Array.from(document.querySelectorAll(".work-assistant [role=alert]")).filter(note=>note.textContent.includes(${JSON.stringify(generationFailure.error)})).length`),1,
      'the summary cause is shown once instead of repeating below the workflow card');
    assert.equal(await js('document.querySelector(".work-assistant-empty")?.textContent.match(/修复设置|检查配置|连接/)!==null'),false,
      'the empty error state does not blame configuration or connectivity');
    assert.equal(await js('Array.from(document.querySelectorAll(".work-assistant-controls button")).some(item=>/更新摘要|重试摘要/.test(item.textContent))'),false,
      'the nearby retry is the only summary retry entry during an error');
    await shot('summary-generation-error');
    await button('.work-assistant-summary-error button','重试摘要');
    await until('document.querySelector(".work-assistant-overview")?.textContent.includes("多个会话都在推进构建流程")');
    await until('document.querySelector(".work-assistant-group:not([hidden]) h4")?.textContent.includes("建议下一步")');
    const generated=await assistant.view({root});
    assert.equal(generated.summary.nextSteps.length,10,'the UI fixture gives the reader ten independently addressable next steps');
    assert.ok(generated.summary.nextSteps.every(item=>item.sources.length>=2&&item.sources.length<=6
      &&new Set(item.sources.map(source=>source.messageId)).size===item.sources.length),
    'each fixture suggestion cites two to six distinct messages');
    assert.equal(typeof generated.sessions[0].lastActivityAt,'number');
    assert.equal(typeof generated.sources[0].at,'number');
    assert.equal(typeof generated.historyCoverage.checkedAt,'number');
    assert.equal(generated.summaryRevision,generated.sourceRevision);
    assert.ok(generated.analysis&&Number.isSafeInteger(generated.analysis.contextMessages),
      'summary records the number of unique messages actually sent across analysis rounds');
    assert.ok(generated.analysis.contextMessages>0);
    assert.ok(await js(`document.querySelector('[aria-label="摘要更新范围"]')?.textContent.includes(${JSON.stringify(`${generated.analysis.contextMessages} 条消息`)})`),
      'the UI reports actual analysis messages rather than loaded-message coverage');
    assert.equal(await js('document.querySelector(".work-assistant-coverage")?.textContent.includes("进入本次摘要上下文")'),false,
      'stored coverage totals are not presented as the actual model context count');
    const readerState=await js(`(()=>{
      const tabs=Array.from(document.querySelectorAll('.work-summary-tabs [role="tab"]'));
      const active=document.querySelector('.work-assistant-group:not([hidden])');
      const items=Array.from(document.querySelectorAll('.work-summary-list .work-assistant-item'));
      const activeButton=tabs.find(tab=>tab.getAttribute('aria-selected')==='true');
      return {reader:!!document.querySelector('.work-summary-reader'),tabs:tabs.map(tab=>({label:tab.getAttribute('aria-label'),selected:tab.getAttribute('aria-selected')})),
        activeHeading:active?.querySelector('h4')?.textContent.trim(),renderedPanels:document.querySelectorAll('.work-assistant-group:not([hidden])').length,
        inactiveHaveNoContent:Array.from(document.querySelectorAll('.work-assistant-group[hidden]')).every(panel=>!panel.textContent.trim()),
        listCount:items.length,activeLabel:activeButton?.getAttribute('aria-label'),longText:items.at(-1)?.querySelector('.work-summary-text p')?.textContent,
        longTextButton:items.at(-1)?.querySelector('.work-summary-text-toggle')?.textContent.trim(),firstCitation:items[0]?.querySelector('.work-assistant-citation-link')?.getAttribute('aria-label'),
        firstCitationVisibleText:items[0]?.querySelector('.work-assistant-citation-link')?.textContent.trim(),firstQuote:items[0]?.querySelector('blockquote')?.textContent||''};
    })()`);
    assert.equal(readerState.reader,true,'the dedicated summary reader renders');
    assert.equal(readerState.tabs.length,5,'all five summary categories have tabs');
    assert.deepEqual(readerState.tabs.map(tab=>tab.label),['建议下一步，10 条','未决问题，1 条','决定与方向，1 条','当前目标，1 条','进展记录，1 条']);
    assert.equal(readerState.tabs[0].selected,'true','the populated next-step category is selected initially');
    assert.equal(readerState.activeHeading,'建议下一步10 条');
    assert.equal(readerState.renderedPanels,1,'only the selected summary category is visible');
    assert.equal(readerState.inactiveHaveNoContent,true,'hidden categories do not duplicate summary text in the page');
    assert.equal(readerState.listCount,4,'the initial list shows four suggestions');
    assert.equal(readerState.activeLabel,'建议下一步，10 条');
    assert.ok(readerState.longText?.length>200,'the initial visible test suggestions include long, distinct content');
    assert.equal(readerState.longTextButton,'展开内容','long text starts collapsed behind an accessible control');
    assert.match(readerState.firstCitation,/在时间轴定位 构建流程讨论 · 你 · .+/,'citation accessibility label includes the full session title, role, and time');
    assert.ok(readerState.firstCitationVisibleText.includes('查看原文'),'the first source is shown as a compact direct-jump link');
    assert.equal(readerState.firstQuote,'','citation source quotes are not expanded into the summary');
    await js(`(()=>{const tabs=document.querySelectorAll('.work-summary-tabs [role="tab"]');tabs[0].focus();tabs[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));})()`);
    assert.equal(await js('document.activeElement?.getAttribute("aria-label")'),'未决问题，1 条','ArrowRight moves focus and selection to the next category');
    assert.equal(await js('document.querySelector(".work-summary-tabs [role=tab][aria-selected=true]")?.getAttribute("aria-label")'),'未决问题，1 条');
    await js(`(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})))()`);
    assert.equal(await js('document.activeElement?.getAttribute("aria-label")'),'进展记录，1 条','End moves focus to the last category');
    await js(`(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})))()`);
    assert.equal(await js('document.activeElement?.getAttribute("aria-label")'),'建议下一步，10 条','Home returns focus to the first category');
    await js(`(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})))()`);
    assert.equal(await js('document.activeElement?.getAttribute("aria-label")'),'进展记录，1 条','ArrowLeft wraps from the first category to the last');
    await js(`(()=>document.querySelector('.work-summary-tabs [role="tab"][aria-label^="建议下一步"]').click())()`);
    await button('.work-summary-show-more','展开其余 6 条');
    assert.equal(await js('document.querySelectorAll(".work-summary-list .work-assistant-item").length'),10,'show more reveals every remaining suggestion');
    const sourceDisclosure=await js(`(()=>{const details=document.querySelector('.work-summary-list .work-assistant-item .work-summary-more-sources');return {summary:details?.querySelector('summary')?.textContent.trim(),label:details?.querySelector('summary')?.getAttribute('aria-label'),open:details?.open};})()`);
    assert.equal(sourceDisclosure.summary,'另 1 条出处');
    assert.equal(sourceDisclosure.label,'查看其余 1 条出处');
    assert.equal(sourceDisclosure.open,false,'additional citations stay collapsed by default');
    await click('.work-summary-list .work-assistant-item .work-summary-more-sources summary');
    assert.equal(await js('document.querySelector(".work-summary-list .work-assistant-item .work-summary-more-sources")?.querySelectorAll(".work-assistant-citation-link").length'),1,
      'the details disclosure makes the remaining source link accessible on demand');
    assert.equal(await js('!!document.querySelector(".work-summary-list .work-assistant-item .work-summary-more-sources blockquote")'),false,
      'additional sources link to the timeline without exposing full message text');
    const clampStyle=await js('getComputedStyle(document.querySelector(".work-summary-list .work-assistant-item .work-summary-text p")).webkitLineClamp');
    assert.equal(clampStyle,'3','suggestion text starts clamped to three lines');
    await button('.work-summary-list .work-assistant-item .work-summary-text-toggle','展开内容');
    assert.equal(await js('document.querySelector(".work-summary-list .work-assistant-item .work-summary-text-toggle")?.textContent.includes("收起内容")'),true,
      'the long suggestion expands and exposes a matching collapse control');
    await button('.work-summary-list .work-assistant-item .work-summary-text-toggle','收起内容');
    await button('.work-summary-show-more','收起到 4 条');
    assert.equal(await js('document.querySelectorAll(".work-summary-list .work-assistant-item").length'),4,'the list returns to its four-item default');
    await js(`(()=>document.querySelector('.work-summary-tabs [role="tab"][aria-label^="当前目标"]').click())()`);
    assert.ok(await js('document.querySelector(".work-assistant-group:not([hidden])")?.textContent.includes("归并会话中的构建目标与检查步骤")'),
      'selecting the goals tab reveals its summary item');
    await js(`(()=>document.querySelector('.work-summary-tabs [role="tab"][aria-label^="建议下一步"]').click())()`);
    await js("(()=>{const details=document.querySelector('.work-summary-more-sources');if(details)details.open=false;})()");
    await chooseTheme('blue');await js("document.documentElement.dataset.theme='light'");
    win.setSize(1440,1300);
    await positionSummaryReader();
    const readerRect=await js(`(()=>{const box=document.querySelector('.work-summary-reader').getBoundingClientRect(),tabs=document.querySelector('.work-details>.wd-tabs').getBoundingClientRect();return {x:Math.floor(box.left),y:Math.floor(box.top),width:Math.ceil(box.width),height:Math.ceil(box.height),stickyBottom:Math.ceil(tabs.bottom),viewport:innerHeight};})()`);
    assert.ok(readerRect.y>=readerRect.stickyBottom+12&&readerRect.y+readerRect.height<=readerRect.viewport,`focused reader crop fits below sticky tabs: ${JSON.stringify(readerRect)}`);
    const readerImage=await win.webContents.capturePage({x:readerRect.x,y:readerRect.y,width:readerRect.width,height:readerRect.height});
    fs.writeFileSync(path.join(out,'summary-reader-focus-blue-light.png'),readerImage.toPNG());
    pass('summary reader shows counts, supports keyboard navigation and on-demand text/source expansion');
    await until(`!document.querySelector(${JSON.stringify(continueButton)}).disabled`);
    const enabledContinue=await js(continueButtonStyle);
    assert.equal(enabledContinue.faceAlpha,255);
    assert.match(enabledContinue.hint,/只加入当前 OMP 输入框草稿/);
    assert.equal(await js('document.querySelectorAll(".work-assistant-overview .work-assistant-citation-link").length'),1,
      'repeated citations to the same message should collapse to one timeline link');
    assert.equal(await js('!!document.querySelector(".work-assistant-overview .work-assistant-citation blockquote")'),false,
      'summary citations should not expand long message text');
    assert.equal(await js('!!document.getElementById("message-user-message-001")'),false,
      'the cited message starts outside the last-80 transcript window');
    await js('document.querySelector(".work-assistant-overview .work-assistant-citation-link").scrollIntoView({block:"center",inline:"nearest"})');
    await shot('summary-citation-links');
    const unknownSource=await js(`window.desktop.workAssistantSource({root:${JSON.stringify(root)},sessionId:'fixture-session-001',messageId:'invented-message'}).then(()=>false,error=>error.message.includes('不存在'))`);
    assert.equal(unknownSource,true,'unknown Work/message identities must be rejected before navigation');
    assert.equal(workAssistantSourceCalls,1,'the rejected unknown ID is checked by the source resolver');
    await button('.work-assistant-overview .work-assistant-citation-link','查看原文');
    await until('document.querySelector(".message.timeline-target")?.id==="message-user-message-001"');
    await shot('citation-timeline-target');
    assert.ok(await js('Array.from(document.querySelectorAll(".conversation-timeline .timeline-entry")).some(entry=>entry.getAttribute("aria-current")==="location"&&entry.textContent.includes("先整理多个 OMP 会话"))'));
    assert.equal(workAssistantSourceCalls,2,'the rejected unknown ID and successful timeline lookup each reach the resolver');
    assert.equal(promptCalls,0,'timeline navigation must not submit to OMP');
    pass('summary citations open the source conversation and jump to its exact message in the timeline');
    await assistant.ingest({root,sessionId:'fixture-session-001',title:'构建流程讨论',lastActivityAt:baseTime+26*60000,messages:[{
      id:'user-message-002',role:'user',timestamp:baseTime+25*60000,content:'新增决定：构建检查先确认目标环境的工具版本。'
    }]},{schedule:false});
    await until('document.querySelector(".work-assistant-warning")?.textContent.includes("新会话内容已纳入资料")');
    await button('.work-assistant-controls button','更新摘要');
    await until('document.querySelector(".work-assistant-overview")?.textContent.includes("增量消息已并入构建流程摘要")');
    const incrementalRequest=summaryRequests.at(-1);
    assert.equal(incrementalRequest.analysis.mode,'incremental','a new user-only message selects the incremental summary path');
    assert.deepEqual(incrementalRequest.messages.map(item=>item.messageId),['user-message-002'],
      'the incremental request sends only the changed user message, with no assumed assistant partner message');
    await js(`(()=>document.querySelector('.work-summary-tabs [role="tab"][aria-label^="当前目标"]').click())()`);
    assert.equal(await js('document.querySelector(".work-assistant-group:not([hidden])")?.textContent.includes("归并会话中的构建目标与检查步骤")'),true,
      'an empty section patch preserves unchanged summary items');
    await js(`(()=>document.querySelector('.work-summary-tabs [role="tab"][aria-label^="建议下一步"]').click())()`);
    const incrementalSnapshot=await assistant.view({root});
    assert.equal(incrementalSnapshot.analysis.mode,'incremental');
    assert.equal(incrementalSnapshot.analysis.contextMessages,1);
    assert.equal(await js('document.querySelector("[aria-label=摘要更新范围]")?.textContent.includes("1 条消息")'),true);
    pass('one changed user message updates the prior summary incrementally and reports the actual batch count');

    malformedSummaryResponses=2;
    await assistant.ingest({root,sessionId:'fixture-session-001',title:'构建流程讨论',lastActivityAt:baseTime+28*60000,messages:[{
      id:'user-message-003',role:'user',timestamp:baseTime+27*60000,content:'新增核对项：确认构建产物归档路径。'
    }]},{schedule:false});
    await until('document.querySelector(".work-assistant-warning[role=status]")?.textContent.includes("新会话内容已纳入资料")');
    await button('.work-assistant-controls button','更新摘要');
    await until('document.querySelector(".work-assistant-status")?.textContent.includes("摘要更新失败")');
    const updateFailure=await assistant.view({root});
    assert.ok(updateFailure.summary?.overview?.text,'a failed update keeps the previous summary visible');
    assert.equal(await js('document.querySelector(".work-assistant-heading").nextElementSibling?.classList.contains("work-assistant-summary-error")'),true);
    const updateErrorText=await js('document.querySelector(".work-assistant-summary-error")?.textContent||""');
    assert.ok(updateErrorText.includes(updateFailure.error));
    assert.equal(await js(`Array.from(document.querySelectorAll(".work-assistant [role=alert]")).filter(note=>note.textContent.includes(${JSON.stringify(updateFailure.error)})).length`),1,
      'the failed update reason is not repeated below the workflow card');
    await js('document.querySelector(".work-assistant-summary-error").scrollIntoView({block:"center",inline:"nearest"})');
    await shot('summary-update-error');
    await button('.work-assistant-summary-error button','重试摘要');
    await until('document.querySelector(".work-assistant-status")?.textContent.includes("已更新")');
    const recoveredSummary=await assistant.view({root});
    assert.equal(recoveredSummary.summaryRevision,recoveredSummary.sourceRevision,'retry clears the error after the latest changes are summarized');
    pass('summary update failures preserve the old summary, explain the failure beside the heading, and retry in place');

    await click('.work-assistant-sessions summary');
    const sessionTime=await js('document.querySelector(".work-assistant-sessions").textContent');
    assert.ok(/\d{1,2}[\/月]/.test(sessionTime),sessionTime);
    await shot('summary-blue-light');
    pass('real WorkAssistant emits millisecond timestamps, cited summary, and direct snapshot updates to the UI');

    await button('.work-assistant-controls button','补齐本机历史');
    await until('document.querySelector(".work-assistant-coverage")?.textContent.includes("1 / 2 条本机历史已读取")');
    assert.ok(await js('Array.from(document.querySelectorAll(".work-assistant-warning")).some(note=>note.textContent.includes("1 条本机历史未能读取"))'));
    assert.ok(await js('document.querySelector(".work-assistant-coverage-details")?.textContent.includes("跳过一条无效的本机历史记录")'));
    await shot('history-coverage');
    pass('history coverage shows counts, skipped items, and explicit scan limits');

    await button('.work-details>.wd-tabs button','资产');
    await until('document.querySelector(".wd-assets")&&document.querySelector(".wd-asset-cite")');
    await button('.wd-asset-cite','引用到草稿');
    await until('document.querySelector(".wd-citation-modal")');
    await shot('asset-citation-modal');
    await js(`(()=>{const field=document.querySelector('#work-citation-preview');field.focus();field.setSelectionRange(0,0);})()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});
    await until('!document.querySelector(".wd-citation-modal .wd-actions button").disabled');
    await button('.wd-citation-modal .wd-actions button','引用选中片段');
    await until('!document.querySelector(".wd-citation-modal")');
    const draft=await js('document.querySelector("#message-input")?.value||""');
    assert.ok(draft.includes('notes/构建流程.md'));
    assert.ok(draft.includes('编译流程：先确认 Python 与编译器版本'));
    assert.equal(promptCalls,0,'citing a Work asset must not invoke OMP');
    pass('asset citation reads a saved snapshot, inserts only the selected source excerpt into the draft, and sends nothing');

    await button('.work-details>.wd-tabs button','Work 助手');
    win.setSize(1440,1300);
    await positionSummaryReader();
    for(const theme of ['blue','classic','folio','pixel']){
      await chooseTheme(theme);
      for(const mode of ['light','dark']){
        await js(`document.documentElement.dataset.theme=${JSON.stringify(mode)}`);
        await positionSummaryReader();
        await shot(`summary-reader-${theme}-${mode}`);
      }
    }
    await chooseTheme('blue');await js("document.documentElement.dataset.theme='light'");
    const narrowStates=[];
    for(const width of [360,390,420]){
      const state=await js(`(()=>{const reader=document.querySelector('.work-summary-reader');reader.style.width='${width}px';reader.style.maxWidth='100%';const panel=reader.closest('.work-assistant');return {width:${width},client:reader.clientWidth,scroll:reader.scrollWidth,panelClient:panel?.clientWidth,panelScroll:panel?.scrollWidth};})()`);
      assert.ok(state.client<=width&&state.scroll<=state.client,`${width}px reader has no horizontal content overflow: ${JSON.stringify(state)}`);
      narrowStates.push(state);
      if(width===390){await positionSummaryReader();await shot('summary-reader-narrow-390');}
    }
    await js("(()=>{const reader=document.querySelector('.work-summary-reader');reader.style.width='';reader.style.maxWidth='';})()");
    pass('summary reader renders in all eight visual appearances and fits 360, 390, and 420px panels');

    await button('.work-details>.wd-tabs button','后台任务');
    await until('document.querySelector(".wr-advanced-evolution")&&document.querySelector(".wr-readiness")');
    assert.equal(await js('document.querySelector(".wr-advanced-evolution").open'),false);
    assert.ok(await js('Array.from(document.querySelectorAll(".work-runs button")).some(item=>item.textContent.trim()==="新建后台任务")'));
    await shot('runs-default');
    await button('.work-runs .wr-advanced-evolution>summary','高级实验 · 局部文件进化');
    assert.equal(await js('document.querySelector(".wr-advanced-evolution").open'),true);
    assert.ok(await js('document.querySelector(".wr-automatic").getAttribute("aria-label")==="自动进化"'));
    pass('ordinary task entry remains visible while local-file evolution is disclosed as an advanced experiment');

    // An in-flight Work A response must not replace Work B or its draft after switching.
    await button('.work-details>.wd-tabs button','Work 助手');
    await until('document.querySelector(".work-assistant-controls")');
    holdReplyRoot=root;
    await button('.work-assistant-controls button','更新摘要');
    await untilReplyHeld();
    for(const theme of ['blue','classic','folio','pixel']){
      await chooseTheme(theme);
      for(const mode of ['light','dark']){
        await js(`document.documentElement.dataset.theme=${JSON.stringify(mode)}`);
        await pause(180);
        const state=await js(continueButtonStyle);
        assert.equal(state.disabled,true);
        assert.equal(state.opacity,'1',`${theme} ${mode} must keep text fully opaque`);
        assert.ok(state.faceAlpha>0&&state.faceAlpha<32,`${theme} ${mode} should use a quiet disabled face`);
        assert.match(state.hint,/正在处理/);
        const levels=[luminance(state.foreground),luminance(state.background)];
        const contrast=(Math.max(...levels)+0.05)/(Math.min(...levels)+0.05);
        assert.ok(contrast>=4.5,`${theme} ${mode} disabled label contrast is ${contrast.toFixed(2)}:1`);
      }
    }
    await chooseTheme('blue');
    await js(`document.documentElement.dataset.theme='light'; document.querySelector(${JSON.stringify(continueButton)}).scrollIntoView({block:'center'});`);
    await shot('continue-disabled-blue');
    pass('shared disabled CTA stays readable in all eight appearances and explains why the action is unavailable');
    await button('.work-row','second-work');
    await click('#tab-work');
    await until('document.querySelector(".wd-identity strong")?.textContent.includes("second-work")');
    await until('document.querySelector(".work-assistant-empty")');
    releaseReply();releaseReply=null;
    await pause(250);
    assert.ok(await js('document.querySelector(".work-assistant").textContent.includes("还没有可整理的会话")'));
    assert.ok(!(await js('document.querySelector(".work-assistant").textContent.includes("多个会话都在推进构建流程")')));
    assert.equal(promptCalls,0);
    await shot('switched-work');
    pass('late Work A refresh result cannot populate Work B or send a prompt');

    win.setSize(960,680);
    await until('innerWidth<1280&&document.querySelector("#tools-panel").hidden');
    await click('button[aria-label="展开工具面板"]');
    await until('!document.querySelector("#tools-panel").hidden');
    await shot('compact-work-assistant');
    await button('.work-row','assistant-demo');await click('#tab-work');
    await until('document.querySelector("#tools-panel").hidden');
    await click('button[aria-label="展开工具面板"]');
    await until('!document.querySelector("#tools-panel").hidden');
    await until('document.querySelector(".work-summary-tabs [role=tab][aria-selected=true]")?.getAttribute("aria-label")==="建议下一步，10 条"');
    await until('document.querySelector(".work-assistant-overview .work-assistant-citation-link")?.getClientRects().length>0');
    await js('document.querySelector(".work-assistant-overview .work-assistant-citation-link").scrollIntoView({block:"center",inline:"nearest"})');
    await shot('compact-citation-links');
    assert.deepEqual(consoleErrors,[]);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,isolated:true,checks,notifications:notifications.length,generated:{sourceRevision:generated.sourceRevision,summaryRevision:generated.summaryRevision,updatedAt:generated.updatedAt},screenshots:fs.readdirSync(out).filter(name=>name.endsWith('.png'))},null,2));
    console.log('ARTIFACTS '+out);
    clearTimeout(timer);await assistant.close();app.exit(0);
  }catch(error){
    console.error(error);
    if(win&&!win.isDestroyed())await shot('failure').catch(()=>{});
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:error.stack,checks,notifications:notifications.length,consoleErrors},null,2));
    console.log('ARTIFACTS '+out);clearTimeout(timer);await assistant.close().catch(()=>{});app.exit(1);
  }
});
