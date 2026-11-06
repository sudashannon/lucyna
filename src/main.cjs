if(process.argv.includes('--knowledge-service')){require('./knowledge-host.cjs').main();return;}
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const {createHash} = require('node:crypto');
const { spawn } = require('node:child_process');
const { listWorks, wslUnc, OmpSession, defaultOmp, WORK_ROOT, WORK_HELPER } = require('./backend.cjs');
const {requireWorkRoot}=require('./work-access.cjs');
const { importSession, completeImportedFork, validateImportedSession, listWslSessions, listImportedSessions, validateNativeSession, listNativeSessions } = require('./history.cjs');
const { prepare: prepareModel } = require('./windows-provider.cjs');
const runtime=require('./runtime-config.cjs');
const { installWorkSteleMcp, installWorkSkillDirectory, installWorkCommandMirrors } = require('./work-stele.cjs');
const { ensureOwnedAgentDir } = require('./profile.cjs');
const {configureAppIdentity}=require('./app-identity.cjs');
const {installTaskbarIdentity}=require('./windows-taskbar.cjs');
const { TerminalManager } = require('./terminal-manager.cjs');
const { SessionManager } = require('./session-manager.cjs');
const {TurnChanges} = require('./turn-changes.cjs');
const {CodeReviewService} = require('./code-review.cjs');
const {createNativeReviewEngine} = require('./code-review-engine.cjs');
const { WslSessionHistory } = require('./wsl-session-history.cjs');
const { HistoryTrash } = require('./history-trash.cjs');
const {planDeletion,publicPlan}=require('./history-deletion.cjs');
const {acquireHistoryLease}=require('./history-lease.cjs');
const {invalidateWslHistory}=require('./history.cjs');
const {PetController}=require('./pet/controller.cjs');
const {FeedbackController}=require('./feedback/controller.cjs');
const {applicationIcon}=require('./app-icon.cjs');
const windowChrome=require('./window-chrome.cjs');
const { listDirectory } = require('./file-browser.cjs');
const {readWorkspacePreview} = require('./workspace-preview.cjs');
const {SettingsStore, checkSettings, validateSettings, historyLocations, sessionDirectory, windowsSessionPath} = require('./client-settings.cjs');
let knowledge;
const workDetails = require('./work-details.cjs').createWorkDetails({listWorks});
const {WorkRunner}=require('./work-runner.cjs');
const {AuxiliarySettings}=require('./auxiliary-settings.cjs');
const {AuxiliaryAgent}=require('./auxiliary-agent.cjs');
const {SessionTitles}=require('./session-titles.cjs');
const {RemoteDesktop}=require('./hosts/desktop.cjs');
const {WorkAssistant}=require('./work-assistant.cjs');
const {WorkAssistantAccess,journalIdentity,readAssistantJournal}=require('./work-assistant-sources.cjs');
const {WorkGuidance}=require('./work-guidance.cjs');
const {WorkGuidanceAssets}=require('./work-guidance-assets.cjs');
const {WorkWorkflow}=require('./work-workflow.cjs');

let window, sessions, pet, feedback, selectedHistory, listedHistory = new Map(), terminal, runtimeMutation = false;
let windowsPreparation = Promise.resolve();
let remote;
configureAppIdentity(app);
knowledge=require('./knowledge-managed.cjs').createManagedKnowledge({directory:path.join(app.getPath('userData'),'knowledge'),workAssets:require('./work-knowledge.cjs').createWorkKnowledge({listWorks,details:workDetails,wslUnc,distro:runtime.distro}),chooseDirectory:async()=>{const result=await dialog.showOpenDialog(window,{title:'导入知识库文件夹',properties:['openDirectory']});return result.canceled?null:result.filePaths[0];}});
// Shortcut launches reveal the existing workbench instead of opening its
// IndexedDB again, including while the companion keeps the client alive.
if (!require('./single-instance.cjs').claimInstance(app, () => window)) return;
installTaskbarIdentity(app);
const settingsStore = new SettingsStore(app.getPath('userData'));
const auxiliarySettings=new AuxiliarySettings(app.getPath('userData'),safeStorage);
const auxiliaryAgent=new AuxiliaryAgent(auxiliarySettings);
const sessionTitles=new SessionTitles(auxiliaryAgent,auxiliarySettings);
let workGuidance,workWorkflow;
const workAssistant=new WorkAssistant({
  directory:path.join(app.getPath('userData'),'work-assistant'),agent:auxiliaryAgent,
  localScope:JSON.stringify([runtime.distro,runtime.user]),
  configVersion:()=>auxiliarySettings.revision,
  config:()=>auxiliarySettings.resolve(),
  notify:snapshot=>{
    if(window&&!window.isDestroyed())window.webContents.send('work:assistant-event',snapshot);
    void Promise.resolve().then(()=>workGuidance?.sourceChanged(snapshot)).catch(error=>console.error('Work guidance:',error.message));
    void Promise.resolve().then(()=>workWorkflow?.observe(snapshot)).catch(error=>console.error('Work workflow:',error.message));
  },
});
async function resolveAssistantWork({root,hostId}) {
  if(hostId){
    const profile=await remote.registry.get(hostId);
    if(profile.root!==root)throw Error('Work 不属于所选主机');
    return;
  }
  requireWorkRoot(await listWorks(),root);
}
async function readAssistantRecord(identity) {
  await resolveAssistantWork(identity);
  let text;
  try {
    if(identity.hostId){
      const entry=remote.connections.get(identity.hostId);
      if(remote.paused.has(identity.hostId)||!entry?.connection.child||entry.profile.root!==identity.root){
        return {available:false,reason:'远端当前未连接，流程提醒仅参考已收集的会话。'};
      }
      const workspace=await entry.connection.request('workspace.inspect',{
        root:identity.root,omp:entry.profile.omp,agentDir:entry.profile.agentDir,
      });
      text=workspace.document;
    }else{
      text=(await readWorkspacePreview(wslUnc(identity.root),'SESSION.md',undefined,identity.root)).content;
    }
    if(typeof text!=='string'||!text.trim())return {available:false,reason:'当前未读取到 SESSION.md，仅参考会话生成交接建议。'};
    if(require('./work-knowledge-policy.cjs').sensitiveDocument(text))return {available:false,reason:'Work 记录含疑似凭据，已排除在流程分析之外。'};
    return {available:true,path:'SESSION.md',text:text.slice(0,48000),truncated:text.length>48000,
      version:createHash('sha256').update(text).digest('hex')};
  }catch{return {available:false,reason:'SESSION.md 暂不可读，流程提醒仅参考已收集的会话。'};}
}
const guidanceAssets=new WorkGuidanceAssets({resolveWork:resolveAssistantWork,details:workDetails,knowledge});
workGuidance=new WorkGuidance({assistant:workAssistant,agent:auxiliaryAgent,
  config:()=>auxiliarySettings.resolve(),configVersion:()=>auxiliarySettings.revision,
  resolveWork:resolveAssistantWork,listAssets:identity=>guidanceAssets.list(identity),
  readAsset:(identity,asset)=>guidanceAssets.read(identity,asset),
});
workWorkflow=new WorkWorkflow({directory:path.join(app.getPath('userData'),'work-workflow'),
  assistant:workAssistant,agent:auxiliaryAgent,config:()=>auxiliarySettings.resolve(),
  configVersion:()=>auxiliarySettings.revision,resolveWork:resolveAssistantWork,readRecord:readAssistantRecord,
  notify:snapshot=>{if(window&&!window.isDestroyed())window.webContents.send('work:workflow-event',snapshot);},
});
function assistantSource(id) {
  const remoteSession=remote?.active.get(id);
  if(remoteSession){
    const record=remoteSession.session.record;
    if(!record?.journal)return null;
    return {root:remoteSession.saved.root,hostId:remoteSession.saved.hostId,
      sessionId:journalIdentity(record.journal),title:remoteSession.assistantTitle||'',messageRevision:remoteSession.assistantMessageRevision||0};
  }
  const record=sessions?.records.get(id);
  if(!record?.sessionFile||record.creation)return null;
  return {root:record.root,sessionId:journalIdentity(record.sessionFile),title:record.assistantTitle||'',messageRevision:record.assistantMessageRevision||0};
}
function observeAssistant(event) {
  const record=remote?.active.get(event.clientSessionId)||sessions?.records.get(event.clientSessionId);
  if(record&&event.type==='message_end')record.assistantMessageRevision=(record.assistantMessageRevision||0)+1;
  if(record&&['session_info_update','session_state','session_metadata'].includes(event.type)) {
    const title=event.sessionName||event.title||(!record.assistantTitle&&event.titleHint);
    if(typeof title==='string'&&title.trim())record.assistantTitle=title.slice(0,240);
  }
  const source=assistantSource(event.clientSessionId);
  if(!source)return;
  void Promise.resolve(workAssistant.observe({...event,workRoot:source.root,hostId:source.hostId,
    sessionId:source.sessionId,sessionTitle:event.title||source.title})).catch(error=>console.error('Work assistant:',error.message));
}
const nativeWslHistory = new WslSessionHistory(app.getPath('userData'));
const historyTrash = new HistoryTrash(app.getPath('userData'));
const turnChanges = new TurnChanges({directory:path.join(app.getPath('userData'),'turn-changes'),runtime});
const codeReview = new CodeReviewService({
  directory:path.join(app.getPath('userData'),'code-reviews'),
  engine:createNativeReviewEngine(auxiliaryAgent),
  config:async()=>{try{return await auxiliarySettings.resolve();}catch(error){throw Object.assign(error,{publicMessage:error.message});}},
  resolveSource:async source=>{
    const localScope=JSON.stringify([runtime.distro,runtime.user]);
    if(source.kind==='workspace'){
      requireWorkRoot(await listWorks(),source.root);
      return {source,root:source.root,key:JSON.stringify([localScope,source]),
        load:signal=>require('./code-review-snapshot.cjs').captureWorkspace(source,signal)};
    }
    const record=sessions?.records.get(source.sessionId);
    if(!record?.sessionFile||record.creation||remote?.active.has(source.sessionId))throw Error('请先打开本机 Work 中的目标会话');
    const owner={root:record.root,sessionFile:record.sessionFile};
    requireWorkRoot(await listWorks(),owner.root);
    return {source,root:owner.root,key:JSON.stringify([localScope,owner.root,journalIdentity(owner.sessionFile),source.messageId]),
      load:async signal=>{
        signal.throwIfAborted();
        const snapshot=await turnChanges.read(owner,source.messageId);
        if(!snapshot)throw Object.assign(Error('本轮改动记录已不存在，请审查当前未提交代码'),{publicMessage:'本轮改动记录已不存在，请审查当前未提交代码'});
        signal.throwIfAborted();
        return {...snapshot,capturedAt:snapshot.finishedAt,files:snapshot.files.map(file=>({...file,scope:'turn'}))};
      }};
  },
});
const workRunner = new WorkRunner({listWorks,connections:()=>sessions?.list()||[],settings:()=>settingsStore.get(),auxiliary:()=>auxiliarySettings.resolve()});
const consolidation=new (require('./knowledge-consolidation-client.cjs').ConsolidationClient)({knowledge,listWorks,wslUnc,auxiliary:()=>auxiliarySettings.resolve(),busy:root=>workRunner.admissions.has(root)||(sessions?.list()||[]).some(c=>c.root===root&&(!c.ready||c.questions?.length||(workRunner.activity.get(c.id)??c.busy)))});
const {WorkCreation}=require('./work-creation.cjs');
const {boundedExec}=require('./bounded-exec.cjs');
const workCreation = new WorkCreation({
  directory:path.join(app.getPath('userData'),'work-creations'),base:WORK_ROOT,listWorks,
  initialize:async agentDir=>{
    try{await Promise.all([fs.access(windowsSessionPath(agentDir+'/commands/work-start.md')),fs.access(windowsSessionPath(WORK_HELPER))]);}
    catch{throw Error('请在本机 WSL OMP 配置中安装 /work-start 和 worktree-session 技能');}
    await boundedExec('wsl.exe',[...runtime.wslPrefix,'--exec','mkdir','-p','--',WORK_ROOT]);
  },
  verify:async root=>{
    const result=JSON.parse(await boundedExec('wsl.exe',[...runtime.wslPrefix,'--exec','python3','-B',WORK_HELPER,'verify',root]));
    if(result.root!==root||!Array.isArray(result.members))throw Error('WSL Work 校验返回的目录与交接路径不符');
  },
  admit:(root,run)=>workRunner.interactive(root,run),
});
const gitWorkspace = require('./git-service.cjs').createGitService({listWorks,runnerState:workRunner.state,lifecycle:(root,run)=>workRunner.interactive(root,async()=>{
  if(sessions?.list().some(c=>c.root===root)||[...(terminal?.records.values()||[])].some(t=>t.record?.root===root))throw Error('此 Work 仍有会话或终端连接，请先结束后再管理工作树');
  return run();
})});
const onlyMain = event => { if (!window || event.sender !== window.webContents) throw new Error('Unauthorized IPC sender'); };
async function readBounded(filePath, limit, label) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('请选择普通文件');
    if (stat.size > limit) throw new Error(`${label}超过限制`);
    const chunks = [], chunk = Buffer.alloc(64 * 1024); let total = 0, position = 0;
    while (total <= limit) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, limit + 1 - total), position);
      if (!bytesRead) break;
      total += bytesRead; position += bytesRead;
      if (total > limit) throw new Error(`${label}超过限制`);
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ show:!process.argv.includes('--hidden'), width: 1440, height: 900, minWidth: 960, minHeight: 640, title: 'Lucyna · 工作台', icon: applicationIcon, backgroundColor: '#f9f9f8', ...windowChrome.windowOptions(), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments:windowChrome.enabled()?['--lucyna-titlebar']:[] } });
  if(windowChrome.enabled())windowChrome.installWindowChrome(window);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file://')) event.preventDefault(); });
  sessions = new SessionManager({titles:sessionTitles,turnChanges,create: send => new OmpSession(send), onState:async record=>{
    if(record.creation)return workCreation.remember(record);
    if(record.forkSource){
      record.forkTask ||= completeImportedFork(record.importRoot,record.agentDir,record.forkSource,record.sessionFile,record.root);
      try{await record.forkTask;record.forkSource=undefined;}finally{record.forkTask=undefined;}
    }
    await nativeWslHistory.remember(record);
  }, send: e => { workRunner.observe(e);observeAssistant(e);pet?.ingest(e); if (window && !window.isDestroyed()) window.webContents.send('omp:event', e); }});
  workRunner.startAutomatic();
  consolidation.start();
  pet=new PetController({directory:app.getPath('userData'),getMain:()=>window,getSessions:()=>sessions,onQuit:()=>app.quit(),onState:snapshot=>feedback?.observe(snapshot)});
  await pet.init().catch(error=>{console.error('Desktop companion:',error.message);});
  feedback=new FeedbackController({directory:app.getPath('userData'),getMain:()=>window,onChange:settings=>{pet.feedbackReducedMotion=settings.reducedMotion;pet.schedule();}});
  await feedback.init(pet.settings.reducedMotion);
  window.on('close',event=>{if(!quitting&&pet?.shouldKeepAlive()){event.preventDefault();window.hide();}});
  window.on('closed',()=>{if(!quitting)app.quit();});
  const handle = (name, fn) => ipcMain.handle(name, (e, ...args) => { onlyMain(e); return fn(...args); });
  remote = new RemoteDesktop({directory:app.getPath('userData'),
    send:event=>{observeAssistant(event);pet?.ingest(event);if(window&&!window.isDestroyed())window.webContents.send('omp:event',event);},
    notify:event=>{if(window&&!window.isDestroyed())window.webContents.send('host:event',event);}});
  handle('host:list',()=>remote.list());
  handle('host:save',input=>remote.save(input));
  handle('host:connect',id=>remote.reconnect(id).then(()=>remote.list()));
  handle('host:update',id=>remote.updateHost(id));
  handle('host:cancel',id=>remote.cancel(id));
  handle('host:disconnect',id=>remote.disconnectHost(id));
  handle('host:remove',id=>remote.remove(id));
  handle('host:reconnect-session',id=>remote.reconnectSession(id));
  handle('host:detach-session',id=>remote.detach(id));
  handle('host:operation',(id,clear)=>remote.operation(id,clear===true));
  handle('pet:get',()=>pet.snapshot());
  handle('pet:settings',patch=>pet.save(patch));
  handle('pet:context',context=>{pet.context(context);feedback.context(context);});
  handle('pet:reset-position',()=>pet.recover({resetPosition:true,reveal:true}));
  handle('feedback:get',()=>feedback.snapshot());
  handle('feedback:settings',patch=>feedback.save(patch));
  handle('feedback:preview',input=>feedback.preview(input));
  handle('feedback:stop-preview',()=>feedback.stopPreview());
  handle('settings:get', async () => ({settings:await settingsStore.get(),storage:app.getPath('userData'),workspace:{distro:runtime.distro,user:runtime.user,root:runtime.workRoot}}));
  handle('settings:check', checkSettings);
  handle('auxiliary:get',()=>auxiliarySettings.get());
  handle('auxiliary:save',async input=>{
    const settings=await auxiliarySettings.save(input);
    for(const record of sessions.records.values())sessionTitles.refresh(record,sessions);
    await Promise.all([workGuidance.configurationChanged(),workWorkflow.configurationChanged(),workAssistant.configurationChanged()]);
    return settings;
  });
  handle('auxiliary:check',input=>auxiliaryAgent.check(input));
  handle('settings:save', async input => {
    const next=validateSettings(input);
    if(runtimeMutation) throw new Error('设置正在保存，请稍候');
    runtimeMutation=true;
    try {await checkSettings(next);const settings=await settingsStore.save(next);selectedHistory=null;listedHistory.clear();return settings;}
    finally {runtimeMutation=false;}
  });
  handle('works:list', async () => {
    const [local,hosts]=await Promise.allSettled([listWorks({refresh:true}),remote.works()]);
    if(hosts.status==='rejected')throw hosts.reason;
    if(local.status==='rejected'&&!hosts.value.length)throw local.reason;
    return [...(local.status==='fulfilled'?local.value:[]),...hosts.value];
  });
  handle('work:details', async (root,hostId) => {
    if(hostId)return remote.workspaceCall(hostId,root,'workspace.details');
    const detail=await workDetails(root);
    guidanceAssets.observe({root},detail);
    return detail;
  });
  handle('work:create-session', id=>{
    if(typeof id!=='string')throw Error('无效客户端会话标识');
    return sessions.start(id,async(startNative,signal,progress)=>{
      progress('正在准备 WSL 建根会话');
      const defaults=await settingsStore.get();
      const options=await workCreation.prepare(id,{...defaults,runtime:'wsl'});
      signal.throwIfAborted();
      const start=()=>startNative({...options,model:defaults.runtime==='wsl'?defaults.model||undefined:undefined});
      return options.creationWork?workRunner.interactive(options.root,start,signal):start();
    },{root:WORK_ROOT});
  });
  handle('work:finish-creation',id=>sessions.finishWork(id,workCreation));
  handle('work:run', (operation,data) => workRunner.call(operation,data));
  handle('work:git', (root, member, action, options,hostId) => hostId?remote.workspaceCall(hostId,root,'workspace.git.read',{member,action,options}):workDetails(root, member, action, options));
  handle('turn-changes:list', id => turnChanges.list(sessions.records.get(id)));
  handle('turn-changes:read', (id, messageId) => turnChanges.read(sessions.records.get(id), messageId));
  handle('code-review:start',source=>codeReview.start(source));
  handle('code-review:list',source=>codeReview.list(source));
  handle('code-review:read',id=>codeReview.read(id));
  handle('code-review:cancel',id=>codeReview.cancel(id));
  handle('code-review:finding',(id,findingId,status)=>codeReview.updateFinding(id,findingId,status));
  handle('workspace:git', (root,member,action,options,hostId)=>{
    require('./git-service.cjs').validate(root,member,action,options||{});
    if(hostId&&(action==='disk'||options?.lfsMode!==undefined))throw Error('此功能当前仅支持本机 WSL 工作区');
    return hostId?remote.workspaceCall(hostId,root,'workspace.git',{member,action,options}):gitWorkspace(root,member,action,options);
  });
  handle('clipboard:write-text', async text => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new Error('复制内容超过 4 MiB，请分段复制');
    await clipboard.writeText(text);
  });
  handle('work:read', async (root,hostId) => { if(hostId)return remote.readWork(root,hostId);const works = await listWorks(); requireWorkRoot(works,root); return (await readBounded(path.join(wslUnc(root), 'SESSION.md'), 512 * 1024, 'SESSION.md')).toString('utf8'); });
  handle('stele:context', async query => { if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('请输入查询内容');const response=await knowledge.runtime.call('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:require('node:crypto').randomUUID(),method:'tools/call',params:{name:'wiki_context',arguments:{query:query.trim()}}}});if(response.error||response.result?.isError)throw Error(response.error?.message||'知识上下文读取失败');return response.result; });
  handle('stele:knowledge', (kind,args) => kind.startsWith('consolidation')?consolidation.call(kind,args):knowledge(kind,args,event=>{if(window&&!window.isDestroyed())window.webContents.send('stele:knowledge-event',{requestId:args?.requestId,event});}));
  handle('stele:save-file', async (name,bytes) => {
    if(typeof name!=='string'||name.length>255||!(bytes instanceof Uint8Array)||bytes.length>64*1024*1024)throw Error('无效的知识导出内容');
    const result=await dialog.showSaveDialog(window,{defaultPath:path.basename(name)});
    if(result.canceled||!result.filePath)return false;
    await fs.writeFile(result.filePath,bytes);return true;
  });
  handle('omp:start', async options => {
    if (!options || typeof options.root !== 'string') throw new Error('请选择工作根');
    if(options.hostId)return remote.start(options);
    return sessions.start(options.clientSessionId, (startNative,signal,progress)=>{
    progress('正在检查后台任务');
    return workRunner.interactive(options.root,async()=>{
    progress('正在校验工作区');
    const defaults=await settingsStore.get();
    const settings={...defaults,runtime:options.resume&&['wsl','windows'].includes(options.runtime)?options.runtime:defaults.runtime};
    const locations=historyLocations(app.getPath('userData'),settings.runtime);
    const works = await listWorks();
    requireWorkRoot(works,options.root);
    const safe = { root: options.root, settings, model: typeof options.model === 'string' && options.model.length <= 200 ? options.model : settings.model || undefined };
    if(settings.runtime==='wsl'&&!options.resume&&!options.agentDir){
      // Let native OMP choose its cwd-derived bucket. Never override new WSL
      // journals with the client's Windows hash directory.
      safe.agentDir=settings.wslAgentDir;safe.nativeHistory=true;
      return await startNative(safe);
    }
    if (options.resume || options.agentDir) {
      progress('正在校验历史会话');
      if (typeof options.resume !== 'string' || typeof options.agentDir !== 'string') throw new Error('请从当前工作区历史列表打开会话，或显式导入副本');
      if(settings.runtime==='wsl'&&options.agentDir.startsWith('/')){
        const restored=await nativeWslHistory.resolve(options.agentDir,options.resume,options.root,settings.wslAgentDir);
        safe.resume=restored.sessionFile;safe.resumeId=restored.id;safe.agentDir=restored.agentDir;safe.executionRoot=restored.executionRoot;safe.nativeHistory=true;
        safe.settings={...settings,wslAgentDir:restored.agentDir};
        return await startNative(safe);
      }
      const nativeDir = locations.agentDir;
      const imported = path.resolve(options.agentDir).toLowerCase() === path.resolve(nativeDir).toLowerCase()
        ? await validateNativeSession(nativeDir, options.resume, options.root)
        : await validateImportedSession(locations.historyDir, options.agentDir, options.resume, options.root);
      safe.resume = imported.sessionFile; safe.resumeId=imported.id; safe.agentDir = imported.agentDir;
      safe.executionRoot = imported.executionRoot;
      if(imported.forkPending){safe.fork=true;safe.importRoot=locations.historyDir;}
    }
    if (!safe.agentDir) safe.agentDir = locations.agentDir;
    safe.agentDir = await ensureOwnedAgentDir(app.getPath('userData'), safe.agentDir);
    safe.sessionDir=sessionDirectory(safe.agentDir,safe.executionRoot || safe.root);
    if(settings.runtime==='wsl') return await startNative(safe);
    // Preparing the shared Windows profile is serialized, native model runs are not.
    const previous=windowsPreparation;let releasePreparation;
    windowsPreparation=new Promise(resolve=>{releasePreparation=resolve;});
    await previous;
    try {
    signal.throwIfAborted();
    progress('正在准备 Windows 配置');
    if(runtime.installWorkIntegration){
      const managed=await knowledge('libraryStatus');
      await installWorkSteleMcp(safe.agentDir,{knowledgeClient:{command:managed.mcp.command,profile:knowledge.runtime.directory}});
      await installWorkSkillDirectory(safe.agentDir);
      await installWorkCommandMirrors(safe.agentDir);
    }
    const auth = await prepareModel(safe.agentDir);
    safe.model ||= auth.status.model;
    safe.env = auth.env;
    try { return await startNative(safe); }
    finally { auth.release(); safe.env = undefined; }
    } finally {releasePreparation();}
    },signal);
    },{root:options.root});
  });
  handle('omp:prepare-text', (id,files) => {if(remote.owns(id))throw Error('远端文本文件附件尚未接入，请使用内联文本；草稿已保留');return sessions.prepareTextAttachments(id,files);});
  handle('omp:request', async (type, data, id) => {
    const {validateTaskRequest,selectTaskHistory}=require('./task-rpc.cjs');
    if (!validateTaskRequest(type,data) && !['get_state', 'get_messages', 'prompt', 'abort', 'abort_and_restore_queue', 'remove_queued_message', 'get_available_commands', 'get_available_models', 'set_model', 'set_ask_dialog'].includes(type)) throw new Error('Unsupported command');
    const transport=remote.owns(id)?remote:sessions;
    if(type==='get_background_task_history')return selectTaskHistory(await transport.request(id,'get_entries'),data.taskIds);
    const expectedSource=type==='get_messages'&&assistantSource(id);
    const result=await transport.request(id,type,data);
    const source=type==='get_messages'&&assistantSource(id);
    if(source&&expectedSource&&source.sessionId===expectedSource.sessionId&&source.root===expectedSource.root
      &&source.hostId===expectedSource.hostId&&Array.isArray(result?.messages)) {
      void workAssistant.ingest({...source,messages:result.messages,authoritative:source.messageRevision===expectedSource.messageRevision}).catch(error=>console.error('Work assistant history:',error.message));
    }
    return result;
  });
  handle('omp:terminate',id=>remote.owns(id)?remote.close(id):sessions.terminate(id));
  handle('omp:ui-response', (data,id) => { if (!data || data.type !== 'extension_ui_response' || typeof data.id !== 'string') throw new Error('Invalid UI response'); return remote.owns(id)?remote.respond(id,data):sessions.respond(id,data); });
  handle('omp:close', id => remote.owns(id)?remote.close(id):sessions.close(id));
  handle('omp:list', () => [...sessions.list(),...remote.listConnections()]);
  handle('omp:path', async () => {const s=await settingsStore.get();return s.runtime==='wsl'?s.wslExecutable:s.windowsExecutable;});
  handle('session:choose', async () => { const r = await dialog.showOpenDialog(window, { title: '选择 OMP 会话并导入副本（原件保留）', filters: [{ name: 'OMP session', extensions: ['jsonl'] }], properties: ['openFile'] }); selectedHistory = r.canceled ? null : r.filePaths[0]; return selectedHistory; });
  async function sessionHistory(root,hostId) {
    if(hostId)return remote.history(root,hostId);
    const works = await listWorks();
    requireWorkRoot(works,root);
    const settings=await settingsStore.get();
    const collect=async runtime=>{const p=historyLocations(app.getPath('userData'),runtime);return [...await listImportedSessions(p.historyDir,root),...await listNativeSessions(p.agentDir,root)].map(entry=>({...entry,runtime}));};
    const sources = await Promise.allSettled([listWslSessions(root,settings.wslAgentDir), collect('windows'), collect('wsl'),nativeWslHistory.list(root)]);
    const [wsl, win, linux, native] = sources;
    const result = wsl.status === 'fulfilled' ? wsl.value : {sessions: [], total: 0};
    // A late response for another work must not invalidate the current list.
    for (const [source, owner] of listedHistory) if (owner.root === root) listedHistory.delete(source);
    for (const item of result.sessions) listedHistory.set(item.path, {root,runtime:'wsl',entry:item});
    const managed=[...(win.status === 'fulfilled' ? win.value : []),...(linux.status === 'fulfilled' ? linux.value : []),...(native.status==='fulfilled'?native.value:[])];
    const owned=new Set(managed.map(item=>item.sessionFile));
    const originals=result.sessions.filter(item=>!owned.has(item.path));
    for(const item of managed)listedHistory.set(item.sessionFile,{root,runtime:item.runtime,entry:item});
    const trash=await historyTrash.list(root),removed=new Set(trash.map(item=>item.key));
    const visible=item=>!removed.has(historyTrash.key(root,item.sessionFile||item.path));
    return { ...result,sessions:originals.filter(visible), managed:managed.filter(visible),trash, warnings: sources.flatMap((source, i) => source.status === 'rejected' ? [`${['WSL 原始历史', 'Windows 客户端历史', 'WSL 客户端历史','WSL 原生新会话'][i]}读取失败：${source.reason.message}`] : []) };
  }
  handle('session:list',sessionHistory);
  const assistantAccess=new WorkAssistantAccess({
    assistant:workAssistant,
    resolveWork:resolveAssistantWork,
    listHistory:({root,hostId})=>sessionHistory(root,hostId),
    connections:()=>[...(sessions?.list()||[]),...(remote?.listConnections()||[])],
    readHistory:async(entry,{root})=>{
      const source=entry.sessionFile||entry.path,settings=await settingsStore.get();
      const locations=historyLocations(app.getPath('userData'),entry.runtime);
      let verified;
      if(entry.runtime==='wsl'&&entry.agentDir?.startsWith('/'))verified=await nativeWslHistory.resolve(entry.agentDir,source,root,settings.wslAgentDir);
      else if(path.resolve(entry.agentDir||'').toLowerCase()===path.resolve(locations.agentDir).toLowerCase())verified=await validateNativeSession(locations.agentDir,source,root);
      else verified=await validateImportedSession(locations.historyDir,entry.agentDir,source,root);
      const messages=await readAssistantJournal({file:verified.sessionFile,root,nativeId:verified.id});
      const live=[...sessions.records.values()].some(record=>record.session.child&&record.sessionFile&&journalIdentity(record.sessionFile)===journalIdentity(verified.sessionFile));
      return {messages,authoritative:!live};
    },
  });
  handle('work:assistant',async(operation,input)=>{
    const snapshot=await assistantAccess.call(operation,input);
    if(operation==='status')void Promise.resolve(workWorkflow.observe(snapshot)).catch(error=>console.error('Work workflow:',error.message));
    return snapshot;
  });
  handle('work:assistant-source',input=>assistantAccess.resolveSource(input));
  handle('work:guidance',(operation,input)=>workGuidance.call(operation,input));
  handle('work:workflow',(operation,input)=>workWorkflow.call(operation,input));
  const deletionPlan=async(source,root)=>{
    const listed=listedHistory.get(source);
    if(typeof source!=='string'||listed?.root!==root)throw Error('请从当前工作区的历史列表选择会话');
    const works=await listWorks();requireWorkRoot(works,root);
    const settings=await settingsStore.get(),entry=listed.entry,locations=historyLocations(app.getPath('userData'),entry.runtime);
    if((await fs.lstat(windowsSessionPath(source))).isSymbolicLink())throw Error('不能删除符号链接指向的会话');
    let verified;
    if(entry.runtime==='wsl'&&entry.agentDir?.startsWith('/'))verified=await nativeWslHistory.resolve(entry.agentDir,source,root,settings.wslAgentDir);
    else if(path.resolve(entry.agentDir||'').toLowerCase()===path.resolve(locations.agentDir).toLowerCase())verified=await validateNativeSession(locations.agentDir,source,root);
    else verified=await validateImportedSession(locations.historyDir,entry.agentDir,source,root);
    const release=sessions.reserveJournal(verified.sessionFile,verified.id);release();
    const collect=async runtime=>{const p=historyLocations(app.getPath('userData'),runtime);return [...await listImportedSessions(p.historyDir,root),...await listNativeSessions(p.agentDir,root)];};
    const sources=await Promise.allSettled([listWslSessions(root,settings.wslAgentDir,{refresh:true}),collect('windows'),collect('wsl'),nativeWslHistory.list(root)]);
    const catalog=sources.flatMap((result,i)=>result.status==='fulfilled'?(i===0?result.value.identities||result.value.sessions:result.value):[]);
    return planDeletion({root,source:verified.sessionFile,workPath:wslUnc(root),journalRoot:windowsSessionPath(verified.agentDir),entry,catalog,catalogComplete:sources.every(result=>result.status==='fulfilled')});
  };
  handle('session:delete-preview',async(source,root)=>publicPlan(await deletionPlan(source,root)));
  handle('session:delete', async (source,root,token) => {
    return assistantAccess.exclusive({root}, async()=>{
    let plan=await deletionPlan(source,root);
    if(typeof token!=='string'||token!==plan.token)throw Error('文件或关联备忘已变化，请取消后重新确认删除范围');
    const release=sessions.reserveJournal(plan.source,plan.entry.id);let lease;
    try{
      lease=await acquireHistoryLease(plan);lease.check();
      await workAssistant.forgetSession({root},journalIdentity(plan.source));
      await workWorkflow.forgetSession({root},journalIdentity(plan.source));
      // Fingerprints are checked again immediately before each rename.
      const key=await historyTrash.move(plan,{check:()=>lease.check()});listedHistory.delete(source);invalidateWslHistory();
      if(window&&!window.isDestroyed())window.webContents.send('omp:event',{type:'history_deleted',source:plan.source,workRoot:root});
      return key;
    }finally{await lease?.release();release();}
    });
  });
  handle('session:restore', async (root,key) => {
    if(typeof root!=='string'||typeof key!=='string')throw Error('回收站记录不存在');
    const record=(await historyTrash.list(root)).find(item=>item.key===key);if(!record)throw Error('回收站记录不存在');
    if(record.version!==2)return historyTrash.restore(root,key);
    const release=sessions.reserveJournal(record.source,record.entry.id);let lease;
    try{lease=await acquireHistoryLease({...record,files:record.files.flatMap(file=>[file,{...file,path:file.trash}])});lease.check();await historyTrash.restore(root,key,{check:()=>lease.check()});invalidateWslHistory();if(window&&!window.isDestroyed())window.webContents.send('omp:event',{type:'history_restored',source:record.source,workRoot:root});}
    finally{await lease?.release();release();}
  });
  handle('session:import', async (source, root) => {
    if(runtimeMutation) throw new Error('运行时正在准备，请稍候重试');
    runtimeMutation=true;
    try {
    if (!source || (source !== selectedHistory && listedHistory.get(source)?.root !== root)) throw new Error('请通过文件选择器或当前 work 的历史列表选择 session');
    selectedHistory = null;
    const works = await listWorks();
    requireWorkRoot(works,root);
    const settings=await settingsStore.get();
    const locations=historyLocations(app.getPath('userData'),settings.runtime);
    const sourceRuntime=listedHistory.get(source)?.runtime;
    return await importSession({ source, cwd: wslUnc(root), destinationRoot: locations.historyDir, omp: settings.windowsExecutable, workRoot: root, settings, sourceRuntime });
    } finally {runtimeMutation=false;}
  });
  const openExternal = async rawUrl => {
    if (typeof rawUrl !== 'string' || rawUrl.length > 2048) throw new Error('请输入有效网页地址');
    let url;
    try { url = new URL(rawUrl.trim()); } catch { throw new Error('请输入完整的 HTTP(S) 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持不含凭据的 HTTP(S) 地址');
    await shell.openExternal(url.toString());
  };
  handle('external:open', openExternal);
  handle('terminal:open', async root => { const works = await listWorks(); requireWorkRoot(works,root); const p = spawn('wsl.exe', [...runtime.wslPrefix, '--cd', root], { detached: true, stdio: 'ignore', windowsHide: false }); p.unref(); });
  terminal = new TerminalManager({
    listWorks,
    send: event => { if (window && !window.isDestroyed()) window.webContents.send('terminal:event', event); },
    createPty: (root, {cols, rows}) => {
      const env = {};
      for (const key of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
      env.TERM = 'xterm-256color';
      return require('node-pty').spawn('wsl.exe', [...runtime.wslPrefix, '--cd', root], {name: 'xterm-256color', cols, rows, env, useConptyDll: true});
    },
  });
  handle('terminal:start', (root, dimensions) => workRunner.admit(root,()=>terminal.start(root, dimensions)));
  handle('terminal:input', (id, data) => terminal.input(id, data));
  handle('terminal:resize', (id, cols, rows) => terminal.resize(id, cols, rows));
  handle('terminal:close', id => terminal.close(id));
  handle('preview:list', async (root, directory, options,hostId) => {
    if(hostId)return remote.workspaceCall(hostId,root,'workspace.files.list',{directory,options});
    const works = await listWorks();
    requireWorkRoot(works,root);
    const listing=await listDirectory(wslUnc(root), directory, options),base=await fs.realpath(wslUnc(root));
    return {...listing,entries:listing.entries.map(entry=>({...entry,path:path.relative(base,entry.path).split(path.sep).join('/')}))};
  });
  handle('preview:choose-file', async root => {
    const works = await listWorks();
    requireWorkRoot(works,root);
    const workPath = await fs.realpath(wslUnc(root));
    const result = await dialog.showOpenDialog(window, {
      title: '选择当前 work 根中的文件', defaultPath: workPath,
      filters: [{ name: '文档、代码与图片', extensions: ['md', 'markdown', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'txt', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'py', 'js', 'jsx', 'ts', 'tsx', 'sh', 'ps1', 'c', 'cpp', 'h', 'rs', 'go', 'log', 'xml', 'csv', 'css', 'html'] }, {name: '所有文件', extensions: ['*']}],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readPreview(root, result.filePaths[0]);
  });
  async function readPreview(root, reference, basePath,hostId) {
    if(hostId)return remote.workspaceCall(hostId,root,'workspace.files.read',{reference,basePath});
    const works = await listWorks();
    requireWorkRoot(works,root);
    return readWorkspacePreview(wslUnc(root), reference, basePath, root);
  }
  handle('preview:read', readPreview);
  // Older renderers use this channel; keep the same system-browser behavior.
  handle('web:preview', openExternal);
  const rendererFile = process.env.OMP_CINDY_LEGACY_UI === '1'
    ? path.join(__dirname, 'index.html')
    : path.join(__dirname, '..', 'dist', 'renderer', 'index.html');
  await window.loadFile(rendererFile);
});
app.on('window-all-closed', () => app.quit());
let quitting=false;
app.on('before-quit', event => {
  if(quitting)return;
  event.preventDefault();quitting=true;feedback?.dispose();pet?.dispose();terminal?.dispose();
  void Promise.allSettled([sessions?.closeAll(),remote?.shutdown(),codeReview.close()]).finally(async()=>{
    await Promise.allSettled([workGuidance.close(),workWorkflow.close(),turnChanges.drain()]);
    await workAssistant.close();await consolidation.stop();await workRunner.stopAutomatic();app.quit();
  });
});
app.on('before-quit', () => terminal?.dispose());
