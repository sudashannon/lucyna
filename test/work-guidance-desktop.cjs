// Production renderer with isolated real WorkAssistant/Guidance/Workflow services.
// All evidence, assets, model responses and desktop profile are deterministic test fixtures.
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {WorkAssistant}=require('../src/work-assistant.cjs');
const {WorkGuidance}=require('../src/work-guidance.cjs');
const {WorkWorkflow}=require('../src/work-workflow.cjs');
const out=path.resolve('.runtime/work-guidance-desktop-'+Date.now()),profile=path.join(out,'profile');
fs.mkdirSync(profile,{recursive:true});require('./desktop-log.cjs').installDesktopLog(out);
require('../src/app-identity.cjs').configureAppIdentity(app,{LUCYNA_USERDATA:profile});app.disableHardwareAcceleration();
const traceFile=path.join(out,'fixture-trace.log'),trace=(label,value='')=>fs.appendFileSync(traceFile,`${Date.now()} ${label} ${String(value)}\n`);
process.on('uncaughtException',error=>trace('uncaughtException',error?.stack||error));
process.on('unhandledRejection',error=>trace('unhandledRejection',error?.stack||error));
app.on('will-quit',()=>trace('will-quit'));

const root='/fixture/work-guidance',secondRoot='/fixture/work-guidance-second',baseTime=Date.UTC(2026,10,4,2,0,0);
const sourceText='Please verify the build output before marking the task complete.';
const assistantText='The next step is to verify the build output.';
const recordText='# Work\n\n## Build process\nVerify the build output before marking the task complete.\n';
const sourceQuote=sourceText;
const asset={id:'asset-build-log',path:'notes/build-log.md',title:'Build log checklist',kind:'note',version:'catalog-v1',origin:'saved',snapshot:true,modifiedAt:String(baseTime),size:180};
let win,lateRelease=null,heldDraft='',holdWorkflowDraftResponse=false,releaseWorkflowDraftResponse=null,heldWorkflowDraftSnapshot=null;
let promptCalls=0,workflowModelCalls=0,failWorkflowOnce=true,emptyWorkflowOnce=false,guidanceOps=[],guidanceTrace=[],workflowSnapshots=[];
const suggestionCalls=[],consoleErrors=[];
const send=(channel,value)=>{if(win&&!win.isDestroyed())win.webContents.send(channel,value);};
const model={run:async(_config,instructions,input)=>{
  const payload=JSON.parse(input);
  if(instructions.startsWith('You propose short text insertions')){
    suggestionCalls.push(payload.draft);
    if(payload.draft.toLowerCase().includes('late draft')){
      heldDraft=payload.draft;
      await new Promise(resolve=>{lateRelease=resolve;});
    }
    if(payload.draft.toLowerCase().includes('changed draft'))return {finishReason:'stop',text:JSON.stringify({completions:[],assets:[]}),totalUsage:{inputTokens:1,outputTokens:1}};
    const source=payload.sources.find(item=>item.role==='user'&&item.text.includes(sourceQuote));
    return {finishReason:'stop',text:JSON.stringify({
      completions:[{text:'compare the build output ',reason:'接上会话中尚待核对的构建步骤。',basis:'inferred',sources:[{sessionId:source.sessionId,messageId:source.messageId,role:source.role,quote:sourceQuote}]}],
      assets:payload.assets.some(item=>item.id===asset.id)?[{id:asset.id,reason:'标题与当前草稿中的 build log 主题相符。'}]:[]
    }),totalUsage:{inputTokens:13,outputTokens:7}};
  }
  if(instructions.startsWith('You identify a very small number')){
    workflowModelCalls++;
    if(failWorkflowOnce){failWorkflowOnce=false;throw Object.assign(Error('fixture internal failure'),{publicMessage:'fixture 辅助模型连接失败'});}
    if(emptyWorkflowOnce){emptyWorkflowOnce=false;return {finishReason:'stop',text:JSON.stringify({reminders:[]}),totalUsage:{inputTokens:4,outputTokens:2}};}
    const source=payload.conversations.find(item=>item.role==='assistant');
    return {finishReason:'stop',text:JSON.stringify({reminders:[{kind:'handover',key:'build-output-follow-up',title:'继续核对构建输出',reason:'会话中仍有一项明确的后续核对步骤。',draftText:'Continue by verifying the build output.',sources:[{evidenceId:source.excerpts[0].evidenceId}]}]}),totalUsage:{inputTokens:8,outputTokens:5}};
  }
  if(instructions.startsWith('Summarize one Work')){
    const source=payload.messages.find(item=>item.role==='user')||payload.messages[0];
    const citation={evidenceId:source.excerpts[0].evidenceId};
    return {finishReason:'stop',text:JSON.stringify({overview:{text:'当前跨会话工作在核对构建输出。',sources:[citation]},goals:[],decisions:[],progress:[],openQuestions:[],nextSteps:[]}),totalUsage:{inputTokens:5,outputTokens:5}};
  }
  throw Error('Unexpected deterministic model request');
}};
let guidance,workflow;
const assistant=new WorkAssistant({directory:path.join(out,'assistant-state'),agent:model,debounceMs:60000,
  config:async()=>({baseURL:'http://fixture.invalid',model:'deterministic-local'}),configVersion:()=>1,
  notify:snapshot=>{send('work:assistant-event',snapshot);void guidance?.sourceChanged(snapshot);void workflow?.observe(snapshot);}
});
const resolveWork=async()=>{};
guidance=new WorkGuidance({assistant,agent:model,config:async()=>({baseURL:'http://fixture.invalid',model:'deterministic-local'}),configVersion:()=>1,
  resolveWork,listAssets:async identity=>identity.root===root?{available:true,assets:[asset],notice:''}:{available:true,assets:[]},
  readAsset:async(identity,current)=>({id:current.id,root:identity.root,path:current.path,title:current.title,version:current.version,origin:current.origin,snapshot:true,
    snapshotVersion:'snapshot-7',sourceHash:crypto.createHash('sha256').update('snapshot-7 body').digest('hex'),content:'Build process: verify installed tools before accepting the output. Then archive the final build log.\n\n| Item | Result |\n| --- | --- |\n| Tools | Verified |',truncated:false}),
  minIntervalMs:0
});
workflow=new WorkWorkflow({directory:path.join(out,'workflow-state'),assistant,agent:model,config:async()=>({baseURL:'http://fixture.invalid',model:'deterministic-local'}),configVersion:()=>1,
  resolveWork,debounceMs:60000,readRecord:async()=>({available:true,path:'SESSION.md',text:recordText,version:crypto.createHash('sha256').update(recordText).digest('hex'),truncated:false}),
  notify:snapshot=>{workflowSnapshots.push(snapshot);if(workflowSnapshots.length>100)workflowSnapshots.shift();send('work:workflow-event',snapshot);}
});

const works=[{root,name:'Guidance fixture',kind:'work',content:recordText,assets:[asset],issues:[],warnings:[]},
  {root:secondRoot,name:'Second fixture',kind:'work',content:'# Second Work',assets:[],issues:[],warnings:[]}];
const preload=path.join(out,'preload.cjs');
fs.writeFileSync(preload,`const{contextBridge,ipcRenderer}=require('electron');const c=(n,...a)=>ipcRenderer.invoke(n,...a);const sub=(channel,fn)=>{const listener=(_event,value)=>fn(value);ipcRenderer.on(channel,listener);return()=>ipcRenderer.removeListener(channel,listener);};contextBridge.exposeInMainWorld('desktop',{
 mode:'desktop',listWorks:()=>c('works'),listConnections:async()=>[],readWork:(r,h)=>c('readWork',r,h),workDetails:(r,h)=>c('workDetails',r,h),listHistory:()=>c('history'),
 getSettings:async()=>({settings:{runtime:'wsl'},workspace:{root:'${root}'}}),copyText:async()=>{},onEvent:()=>()=>{},onTerminal:()=>()=>{},readPreview:(r,p)=>c('preview',r,p),listFiles:async()=>({directory:'',entries:[],total:0,nextOffset:null}),
 start:async input=>c('start',input),request:(...a)=>c('request',...a),close:async()=>{},petContext:async()=>{},workAssistant:(op,input)=>c('assistant',op,input),onWorkAssistant:fn=>sub('work:assistant-event',fn),workGuidance:(op,input)=>c('guidance',op,input),workWorkflow:(op,input)=>c('workflow',op,input),onWorkWorkflow:fn=>sub('work:workflow-event',fn),onEvent:fn=>sub('omp:event',fn),
 workRun:(op,input)=>c('work-run',op,input),knowledgeRequest:(op,input)=>c('knowledge',op,input)
});`);
ipcMain.handle('works',()=>works.map(({root,name,kind})=>({root,name,kind})));
ipcMain.handle('readWork',(_event,selected)=>works.find(item=>item.root===selected)?.content||'');
ipcMain.handle('workDetails',(_event,selected)=>{const item=works.find(work=>work.root===selected);return {...item,fetchedAt:baseTime,modifiedAt:baseTime,members:[]};});
ipcMain.handle('history',()=>({sessions:[],managed:[],warnings:[],trash:[]}));
ipcMain.handle('preview',(_event,selected,file)=>({kind:'markdown',path:file,name:path.basename(file),content:works.find(item=>item.root===selected)?.content||''}));
ipcMain.handle('start',(_event,input)=>{setTimeout(()=>send('omp:event',{clientSessionId:input.clientSessionId,type:'ready'}),30);return {runtime:'wsl'};});
ipcMain.handle('request',(_event,type)=>{if(type==='prompt')promptCalls++;if(type==='get_available_commands')return {commands:[],skills:[]};return {};});
ipcMain.handle('assistant',(_event,operation,input)=>operation==='status'?assistant.view(input):operation==='refresh'?assistant.refresh(input):operation==='configure'?assistant.configure(input,{enabled:input.enabled}):operation==='history'?assistant.view(input):Promise.reject(Error('Unknown WorkAssistant operation')));
ipcMain.handle('guidance',async(_event,operation,input)=>{
  guidanceOps.push(operation);
  const trace={operation,input:operation==='suggest'?{root:input.root,hostId:input.hostId,sessionKey:input.sessionKey,revision:input.revision,caret:input.caret,draft:input.draft}:input};
  guidanceTrace.push(trace);
  try{const result=await guidance.call(operation,input);trace.result=operation==='suggest'?{status:result.status,requestId:result.requestId,sourceRevision:result.sourceRevision,completionCount:result.completions?.length,assetCount:result.assets?.length,error:result.error}:result;return result;}
  catch(error){trace.error=String(error?.message||error);throw error;}
});
ipcMain.handle('workflow',async(_event,operation,input)=>{
  const result=await workflow.call(operation,input);
  if(holdWorkflowDraftResponse&&operation==='action'&&input.action==='draft'){
    holdWorkflowDraftResponse=false;
    heldWorkflowDraftSnapshot=result.snapshot;
    await new Promise(resolve=>{releaseWorkflowDraftResponse=resolve;});
  }
  return result;
});
ipcMain.handle('work-run',(operation)=>operation==='list'?[]:operation==='get'?{run:null,events:[]}:operation==='automatic-status'?{enabled:false,status:'disabled',label:'已暂停',message:'隔离测试状态',idleSeconds:0,cooldownSeconds:600}:{});
ipcMain.handle('knowledge',async()=>[]);

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),js=code=>win.webContents.executeJavaScript(code,true);
async function until(condition,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await js('Boolean('+condition+')').catch(()=>false))return;await pause(60);}throw Error('Timeout: '+condition);}
async function untilNative(predicate,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await pause(60);}throw Error('Timeout: native condition');}
async function click(selector,label){
  await js(`(()=>{const all=Array.from(document.querySelectorAll(${JSON.stringify(selector)}));const e=all.find(item=>!${JSON.stringify(label||'')}||item.textContent.trim().includes(${JSON.stringify(label||'')}));e?.scrollIntoView({block:'center',inline:'nearest'});})()`);await pause(50);
  const rect=await js(`(()=>{const all=Array.from(document.querySelectorAll(${JSON.stringify(selector)}));const e=all.find(item=>!${JSON.stringify(label||'')}||item.textContent.trim().includes(${JSON.stringify(label||'')}));if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,disabled:e.disabled||e.getAttribute('aria-disabled')==='true'}})()`);assert.ok(rect,`Missing ${selector} ${label||''}`);assert.equal(rect.disabled,false,`Disabled ${selector} ${label||''}`);win.webContents.sendInputEvent({type:'mouseDown',x:rect.x,y:rect.y,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:rect.x,y:rect.y,button:'left',clickCount:1});await pause(80);
}
function key(keyCode,modifiers=[]){win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});}
async function focusComposer(){
  await js(`(()=>{const input=document.querySelector('#message-input');input.focus();input.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()`);
  await until('document.activeElement?.id==="message-input"');
  await untilNative(async()=>{const state=await inspectDraftAssistance();return state?.props.focused===true;});
}
async function replaceDraft(text){
  await focusComposer();await js(`(()=>{const input=document.querySelector('#message-input'),setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,${JSON.stringify(text)});input.setSelectionRange(${text.length},${text.length});input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(text)}}));})()`);
  await until('document.querySelector("#message-input").value==='+JSON.stringify(text));
}
async function inspectDraftAssistance(){return js(`(()=>{
  const root=document.querySelector('#root'),rootKey=root&&Object.keys(root).find(key=>key.startsWith('__reactContainer$'));
  const initial=rootKey?root[rootKey]:null,stack=initial?[initial]:[],seen=new Set();let found=null;
  while(stack.length){const fiber=stack.pop();if(!fiber||seen.has(fiber))continue;seen.add(fiber);
    const props=fiber.memoizedProps||fiber.pendingProps;
    if(props&&props.typingSequence!==undefined&&props.commandMenuOpen!==undefined&&props.target){found={fiber,props};break;}
    if(fiber.sibling)stack.push(fiber.sibling);if(fiber.child)stack.push(fiber.child);
  }
  if(!found)return null;
  const p=found.props;let hook=found.fiber.memoizedState,index=0,context=null,sourceRevision=null,lastAttempt=null;
  while(hook&&index<24){if(index===0)context=hook.memoizedState;if(index===4)sourceRevision=hook.memoizedState?.current;if(index===8)lastAttempt=hook.memoizedState?.current;hook=hook.next;index++;}
  return {props:{enabled:p.enabled,disabled:p.disabled,focused:p.focused,composing:p.composing,commandMenuOpen:p.commandMenuOpen,caret:p.caret,selectionEnd:p.selectionEnd,typingSequence:p.typingSequence,draft:p.draft,target:p.target},context:context&&{identity:context.identity,ready:context.ready,enabled:context.enabled,hasSources:context.hasSources,sourceRevision:context.sourceRevision,updatedAt:context.updatedAt},sourceRevision,lastAttempt};
})()`) }
async function clickElementText(selector,text){await click(selector,text);}
async function shot(name){await js('document.fonts.ready');await pause(160);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),`${name}: horizontal overflow`);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function selectTextInPreview(start,end){
  await until('document.querySelector(".draft-assistance-preview-body table")');
  await js(`(()=>document.querySelector('.draft-assistance-preview-body')?.scrollIntoView({block:'center'}))()`);await pause(100);
  const selected=await js(`(()=>{const el=document.querySelector('.draft-assistance-preview-body'),input=document.querySelector('#message-input');if(!el)return null;
  const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;
  while((node=walker.nextNode())&&!node.textContent.startsWith('Build process:')){}
  if(!node)return null;
  // A pointer press on the focusable preview moves focus off the textarea
  // before Chromium changes the document selection; retain its insertion caret.
  el.focus({preventScroll:true});const caretBefore=input.selectionStart;
  const range=document.createRange();range.setStart(node,${start});range.setEnd(node,${end});const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  const mouseup=new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window});el.dispatchEvent(mouseup);el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Shift'}));
  return {text:selection.toString(),anchorInside:el.contains(selection.anchorNode),focusInside:el.contains(selection.focusNode),caretBefore,caretAfter:input.selectionStart,activeElement:document.activeElement?.tagName}})()`);
  assert.ok(selected?.text.length>0&&selected.anchorInside&&selected.focusInside&&Number.isSafeInteger(selected.caretBefore)&&selected.caretAfter===selected.caretBefore,`selected excerpt stays inside preview and preserves insertion caret: ${JSON.stringify(selected)}`);
  await until('!Array.from(document.querySelectorAll(".draft-assistance-preview .draft-assistance-actions button")).find(button=>button.textContent.includes("加入所选片段")).disabled');
}
const checks=[];const pass=value=>{checks.push(value);console.log('PASS '+value);};
async function chooseTheme(theme){await js(`(()=>{const e=document.querySelector('select[aria-label="视觉主题"]');if(!e)return;const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(e,${JSON.stringify(theme)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(`document.documentElement.dataset.visualTheme===${JSON.stringify(theme)}`);}

app.whenReady().then(async()=>{
  trace('ready-callback');
  const timer=setTimeout(()=>app.exit(2),120000);
  try{
    trace('before-ingest');
    await assistant.ingest({root,sessionId:'fixture-build-session-01',title:'构建输出核对',lastActivityAt:baseTime+30000,messages:[
      {id:'user-build-01',role:'user',timestamp:baseTime,content:sourceText},
      {id:'assistant-build-01',role:'assistant',timestamp:baseTime+20000,content:assistantText}
    ]});
    trace('after-ingest');
    win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    trace('window-created');
    win.focus();
    win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)consoleErrors.push(message);});
    await win.loadFile(path.resolve('dist/renderer/index.html'));
    await until('document.readyState==="complete"');
    await until('document.querySelectorAll(".work-row").length===2');
    await click('.work-row','Guidance fixture');await click('#tab-work');
    await until('document.querySelector("#message-input")&&document.querySelector(".work-workflow")');
    await until('document.querySelector(".work-assistant-coverage")?.textContent.includes("1 条会话已纳入资料")');
    await until('document.querySelector(".work-workflow-meta")?.textContent.includes("尚无成功分析记录")');
    const uncheckedWorkflow=await js('document.querySelector(".work-workflow").textContent');
    assert.ok(uncheckedWorkflow.includes('这些对话尚未分析')||uncheckedWorkflow.includes('当前 Work 资料尚未完成分析'),uncheckedWorkflow);
    assert.equal(uncheckedWorkflow.includes('暂无待处理的流程提醒'),false,'unanalysed Work evidence must not be presented as a successful empty result');
    assert.equal(uncheckedWorkflow.includes('才会显示检查结果'),false,'automatic analysis must not be described as dependent on a manual click');
    assert.equal(uncheckedWorkflow.includes('时间未记录'),false,'an unchecked workflow must not render an ambiguous missing check timestamp');
    assert.ok(uncheckedWorkflow.includes('尚未开始分析'),'workflow metadata distinguishes no attempt from a missing timestamp');
    assert.ok(workflow.timers.has(assistant.identity({root}).workId),'loading status schedules initial workflow analysis even before a Work summary exists');
    await shot('workflow-unchecked-state');
    pass('loaded conversations are labelled unanalysed and scheduled until an analysis result exists');
    // Slash menus and composing input must not dispatch prompt guidance.
    await focusComposer();await win.webContents.insertText('/work');
    await until('document.querySelector(".command-popover")');await pause(1100);assert.equal(suggestionCalls.length,0);
    await replaceDraft('Build');
    await js(`(()=>document.querySelector('#message-input').dispatchEvent(new CompositionEvent('compositionstart',{data:'',bubbles:true})))()`);
    await win.webContents.insertText(' log');await pause(1100);assert.equal(suggestionCalls.length,0,'IME composition does not start a guidance request');
    await js(`(()=>document.querySelector('#message-input').dispatchEvent(new CompositionEvent('compositionend',{data:' log',bubbles:true})))()`);
    await win.webContents.insertText(' summary');
    await js(`(()=>{const input=document.querySelector('#message-input');input.focus();input.setSelectionRange(0,0);})()`);
    for(let i=0;i<10;i++)key('Right');
    await until('document.querySelector("#message-input").selectionStart===10');
    await until('document.querySelector(".draft-assistance-completion")');
    assert.equal(suggestionCalls.at(-1),'Build log summary');
    await click('.draft-assistance-sources summary');
    await shot('suggestion-blue-light');pass('real typing waits for IME completion, slash command menu suppresses calls, and exact source expands');

    // Explicit completion accepts at the collapsed caret and preserves the suffix.
    await click('.draft-assistance-actions button','加入当前草稿');
    await until('document.querySelector("#message-input").value.includes("compare the build output")');
    assert.equal(await js('document.querySelector("#message-input").value'),'Build log compare the build output summary');
    assert.equal(promptCalls,0);pass('completion inserts at the exact caret, preserves suffix, and does not send');

    // A new user edit requests asset metadata; the immutable body is only read after explicit preview.
    await replaceDraft('Build log compare the build output summary more');await until('document.querySelector(".draft-assistance-asset")');
    await click('.draft-assistance-asset button','预览资料');await until('document.querySelector(".draft-assistance-preview-body .markdown")');
    await selectTextInPreview(0,70);await shot('material-preview-blue');
    await click('.draft-assistance-preview .draft-assistance-actions button','加入所选片段');
    await until('document.querySelector("#message-input").value.includes("来源：saved · notes/build-log.md")');
    const materialDraft=await js('document.querySelector("#message-input").value');
    assert.ok(materialDraft.includes('Build log compare the build output summary more'));
    assert.ok(materialDraft.includes('Build process: verify installed tools before accepting the output.'));
    assert.ok(materialDraft.includes('Work '+root)&&materialDraft.includes('快照 snapshot-7')&&materialDraft.includes('SHA-256 '+crypto.createHash('sha256').update('snapshot-7 body').digest('hex')));
    assert.equal(promptCalls,0);pass('explicit material preview inserts only a selected excerpt with full Work/version/hash provenance');

    // A first failed model call must stay visibly failed, then a retry recovers.
    await click('.work-workflow-heading button','开始分析');
    await until('Array.from(document.querySelectorAll(".work-workflow-warning[role=alert]")).some(note=>note.textContent.includes("fixture 辅助模型连接失败"))');
    const failedWorkflow=await js('document.querySelector(".work-workflow").textContent');
    assert.equal(failedWorkflow.includes('暂无待处理的流程提醒'),false,'workflow model failures cannot be shown as a completed empty analysis');
    assert.ok(failedWorkflow.includes('最近尝试')&&failedWorkflow.includes('尚无成功分析记录'),failedWorkflow);
    assert.equal((await workflow.call('status',{root})).snapshot.currentAnalysis,false,'a failed analysis is never current');
    await shot('workflow-analysis-error');
    pass('model failures show the latest real attempt and preserve an explicit retry path');

    // Retry the workflow analysis and check the revision-bound success time.
    await click('.work-workflow-heading button','重新分析');
    await until('document.querySelector(".work-workflow-reminder")?.textContent.includes("继续核对构建输出")');
    assert.ok(workflowModelCalls>0);await shot('workflow-reminder');
    const firstSuccess=await workflow.call('status',{root});
    assert.ok(firstSuccess.snapshot.lastAttemptAt>0&&firstSuccess.snapshot.lastSuccessAt>=firstSuccess.snapshot.lastAttemptAt,'workflow records the actual analysis attempt and successful result times');
    assert.equal(firstSuccess.snapshot.lastSuccessSourceRevision,firstSuccess.snapshot.sourceRevision,'successful reminder result is bound to the conversation revision analyzed');
    assert.equal(firstSuccess.snapshot.currentAnalysis,true,'successful results are current for the complete Work context');
    await click('.work-workflow-reminder button','加入草稿');
    await until('document.querySelector("#message-input").value.includes("Continue by verifying the build output.")');
    await until('!Array.from(document.querySelectorAll(".work-workflow-reminder .work-workflow-actions button")).some(button=>button.disabled)');
    assert.equal(promptCalls,0);pass('workflow reminder adds a grounded proposal to the active draft without sending');
    const draftBeforeWorkflowRace=await js('document.querySelector("#message-input").value');
    const sourceRevisionBeforeWorkflowRace=(await assistant.view({root})).sourceRevision;
    holdWorkflowDraftResponse=true;
    await click('.work-workflow-reminder button','加入草稿');
    await untilNative(()=>typeof releaseWorkflowDraftResponse==='function');
    await assistant.ingest({root,sessionId:'fixture-build-session-01',title:'构建输出核对',lastActivityAt:baseTime+50000,messages:[{
      id:'user-build-02',role:'user',timestamp:baseTime+40000,content:'While the workflow draft is pending, the build output source changes.'
    }]},{schedule:false});
    await untilNative(()=>workflowSnapshots.some(snapshot=>snapshot.sourceRevision>sourceRevisionBeforeWorkflowRace));
    const changedWorkflowSnapshot=workflowSnapshots.find(snapshot=>snapshot.sourceRevision>sourceRevisionBeforeWorkflowRace);
    assert.ok(heldWorkflowDraftSnapshot?.sourceRevision<changedWorkflowSnapshot.sourceRevision,
      'held workflow action must contain the pre-change source revision');
    await until('Array.from(document.querySelectorAll(".work-workflow-state-label")).some(item=>item.textContent.includes("资料已变化"))');
    releaseWorkflowDraftResponse();releaseWorkflowDraftResponse=null;
    await until('Array.from(document.querySelectorAll(".work-workflow-warning[role=alert]" )).some(item=>item.textContent.includes("已阻止把过期内容加入草稿"))');
    assert.equal(await js('document.querySelector("#message-input").value'),draftBeforeWorkflowRace,'stale workflow draft cannot change the active OMP draft');
    assert.equal(promptCalls,0);pass('workflow draft returned after a source change is rejected without changing the active OMP draft');

    // A valid empty model result is a success only for the current conversation revision.
    emptyWorkflowOnce=true;
    await until('!document.querySelector(".work-workflow-heading button")?.disabled',20000);
    await click('.work-workflow-heading button','重新分析');
    await until('document.querySelector(".work-workflow-empty")?.textContent.includes("已检查当前对话，暂未发现需要处理的流程提醒")');
    const emptySuccess=await workflow.call('status',{root});
    assert.ok(emptySuccess.snapshot.lastSuccessAt>0&&emptySuccess.snapshot.lastSuccessSourceRevision===emptySuccess.snapshot.sourceRevision,'a valid empty result records success for the current conversation revision');
    assert.equal(emptySuccess.snapshot.currentAnalysis,true,'a valid empty result is current for the complete Work context');
    await shot('workflow-success-empty');
    pass('valid empty workflow analysis is shown as checked only after a successful current-revision result');

    // Stale async results are bound to their original draft revision and caret.
    await replaceDraft('late draft');await untilNative(()=>heldDraft==='late draft');
    await replaceDraft('changed draft');
    if(lateRelease){lateRelease();lateRelease=null;}
    await pause(1400);
    assert.equal(await js('document.querySelector("#message-input").value'),'changed draft');
    assert.equal(await js('document.querySelectorAll(".draft-assistance-completion").length'),0,'late candidate cannot overwrite a changed draft');
    pass('late completion is discarded after the draft changes');

    await replaceDraft('Build log summary');await until('document.querySelector(".draft-assistance-completion")');
    for(const theme of ['classic','folio','pixel']){await chooseTheme(theme);await shot(`suggestion-${theme}-light`);}
    win.setSize(960,680);await pause(250);
    await js(`(()=>document.querySelector('#message-input')?.scrollIntoView({block:'start',inline:'nearest'}))()`);
    await pause(180);
    assert.ok(await js(`(()=>{const input=document.querySelector('#message-input'),stage=input?.closest('.chat-stage');return !!input&&!!stage&&input.getBoundingClientRect().top>=stage.getBoundingClientRect().top-1})()`),'narrow draft input must remain visible below the chat scrollport start');
    await shot('narrow-draft-assistance');
    assert.deepEqual(consoleErrors,[]);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,isolated:true,checks,suggestionCalls:suggestionCalls.length,guidanceOps,guidanceTrace,workflowModelCalls,promptCalls,screenshots:fs.readdirSync(out).filter(name=>name.endsWith('.png'))},null,2));
    console.log('ARTIFACTS '+out);clearTimeout(timer);await Promise.allSettled([assistant.close(),guidance.close(),workflow.close()]);app.exit(0);
  }catch(error){
    releaseWorkflowDraftResponse?.();releaseWorkflowDraftResponse=null;
    trace('caught',error?.stack||error);console.error(error);
    const diagnostics=win&&!win.isDestroyed()?{dom:await js(`(()=>{const i=document.querySelector('#message-input');return {activeElement:document.activeElement?.id,documentHasFocus:document.hasFocus(),draft:i?.value,selectionStart:i?.selectionStart,selectionEnd:i?.selectionEnd,assistant:document.querySelector('.work-assistant')?.textContent?.slice(0,300),draftAssistance:document.querySelector('.draft-assistance')?.textContent?.slice(0,300),command:document.querySelector('.command-popover')?.textContent?.slice(0,100)}})()`).catch(()=>null),react:await inspectDraftAssistance().catch(()=>null)}:null;
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:error.stack,checks,suggestionCalls,guidanceOps,guidanceTrace,workflowModelCalls,promptCalls,diagnostics},null,2));
    if(win&&!win.isDestroyed())await shot('failure').catch(()=>{});
    console.log('ARTIFACTS '+out);clearTimeout(timer);await Promise.allSettled([assistant.close(),guidance.close(),workflow.close()]);app.exit(1);
  }
}).catch(error=>{trace('ready-rejected',error?.stack||error);console.error(error);app.exit(1);});
