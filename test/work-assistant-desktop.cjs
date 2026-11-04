// Production renderer plus the real WorkAssistant service and a deterministic local agent.
// The service data, fake agent, and UI profile are isolated under this test run's .runtime folder.
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {WorkAssistant}=require('../src/work-assistant.cjs');
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
let win,holdReplyRoot='',releaseReply=null,promptCalls=0;
const notifications=[];
const assistant=new WorkAssistant({
  directory:path.join(out,'assistant-state'),debounceMs:60000,
  config:async()=>({baseURL:'http://deterministic.local',model:'fixture-agent'}),
  agent:{run:async(_model,_instructions,input)=>{
    const payload=JSON.parse(input),source=payload.messages.find(item=>item.role==='user')||payload.messages[0];
    const citation={sessionId:source.sessionId,messageId:source.messageId,role:source.role,quote:source.text.slice(0,96)};
    return {finishReason:'stop',text:JSON.stringify({
      overview:{text:'多个会话都在推进构建流程；下一步先核对执行环境和留出检查。',sources:[citation]},
      goals:[{text:'归并会话中的构建目标与检查步骤。',sources:[citation]}],
      decisions:[{text:'将留出检查保持独立，结果由用户确认。',sources:[citation]}],
      progress:[{text:'已收集一条本机历史会话及其可见消息。',sources:[citation]}],
      openQuestions:[{text:'目标环境中的编译器版本尚未确认。',sources:[citation]}],
      nextSteps:[{text:'读取实际环境后再运行固定检查。',sources:[citation]}]
    }),totalUsage:{inputTokens:31,outputTokens:22}};
  }},
  notify:event=>{
    const snapshot=event?.view||event;
    if(!snapshot?.root)return;
    notifications.push(snapshot);
    if(win&&!win.isDestroyed())win.webContents.send('work:assistant-event',snapshot);
  }
});

const preload=path.join(out,'preload.cjs');
fs.writeFileSync(preload,`const{contextBridge,ipcRenderer}=require('electron');const c=(n,...a)=>ipcRenderer.invoke(n,...a);contextBridge.exposeInMainWorld('desktop',{
 mode:'desktop',listWorks:()=>c('works'),listConnections:async()=>[],readWork:(root,hostId)=>c('read',root,hostId),workDetails:(root,hostId)=>c('details',root,hostId),workGit:(...a)=>c('git',...a),listHistory:async()=>({sessions:[],managed:[]}),getSettings:async()=>({settings:{runtime:'wsl'},workspace:{root:'/demo'}}),copyText:async()=>{},onEvent:()=>()=>{},onTerminal:()=>()=>{},readPreview:(r,p)=>c('preview',r,p),listFiles:async()=>({directory:'',entries:[],total:0,nextOffset:null}),start:async()=>({}),request:(...a)=>c('request',...a),close:async()=>{},petContext:async()=>{},workAssistant:(operation,input)=>c('work-assistant',operation,input),onWorkAssistant:fn=>{const listener=(_event,snapshot)=>fn(snapshot);ipcRenderer.on('work:assistant-event',listener);return()=>ipcRenderer.removeListener('work:assistant-event',listener);},workRun:(operation,input)=>c('work-run',operation,input),knowledgeRequest:(kind,args)=>c('knowledge',kind,args)
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
ipcMain.handle('request',(_event,type)=>{if(type==='prompt')promptCalls++;return {};});
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
    pass('Work助手 is the default Work tab and shows an honest empty state');

    await assistant.ingest({root,sessionId:'fixture-session-001',title:'构建流程讨论',lastActivityAt:baseTime+60000,messages:[
      {id:'user-message-001',role:'user',timestamp:baseTime,content:message},
      {id:'assistant-message-001',role:'assistant',timestamp:baseTime+30000,content:[{type:'text',text:'我会先核对本地构建环境，再确认未决的留出检查。'}]}
    ]});
    await until('document.querySelector(".work-assistant-coverage")?.textContent.includes("1 条会话已纳入资料")');
    assert.ok(notifications.some(value=>value.root===root&&typeof value.sourceRevision==='number'&&typeof value.updatedAt==='number'));
    await button('.work-assistant-controls button','更新摘要');
    await until('document.querySelector(".work-assistant-overview")?.textContent.includes("多个会话都在推进构建流程")');
    await until('document.querySelector(".work-assistant-group")?.textContent.includes("当前目标")');
    const generated=await assistant.view({root});
    assert.equal(typeof generated.sessions[0].lastActivityAt,'number');
    assert.equal(typeof generated.sources[0].at,'number');
    assert.equal(typeof generated.historyCoverage.checkedAt,'number');
    assert.equal(generated.summaryRevision,generated.sourceRevision);
    await click('.work-assistant-overview .work-assistant-citation summary');
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
    for(const theme of ['blue','classic','folio','pixel']){await chooseTheme(theme);await shot(`summary-${theme}-light`);}
    pass('summary layout renders in all four established visual themes');

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
