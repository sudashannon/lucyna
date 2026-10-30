const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { listWorks, wslUnc, steleCall, OmpSession, defaultOmp } = require('./backend.cjs');
const { importSession, completeImportedFork, validateImportedSession, listWslSessions, listImportedSessions, validateNativeSession, listNativeSessions } = require('./history.cjs');
const { prepare: prepareModel } = require('./windows-provider.cjs');
const runtime=require('./runtime-config.cjs');
const { installWorkSteleMcp, installWorkSkillDirectory, installWorkCommandMirrors } = require('./work-stele.cjs');
const { ensureOwnedAgentDir } = require('./profile.cjs');
const {configureAppIdentity}=require('./app-identity.cjs');
const {installTaskbarIdentity}=require('./windows-taskbar.cjs');
const { TerminalManager } = require('./terminal-manager.cjs');
const { SessionManager } = require('./session-manager.cjs');
const { WslSessionHistory } = require('./wsl-session-history.cjs');
const { HistoryTrash } = require('./history-trash.cjs');
const {planDeletion,publicPlan}=require('./history-deletion.cjs');
const {acquireHistoryLease}=require('./history-lease.cjs');
const {invalidateWslHistory}=require('./history.cjs');
const {PetController}=require('./pet/controller.cjs');
const {FeedbackController}=require('./feedback/controller.cjs');
const {applicationIcon}=require('./app-icon.cjs');
const windowChrome=require('./window-chrome.cjs');
const { listDirectory, previewKind, IMAGE_MIME, within } = require('./file-browser.cjs');
const {SettingsStore, checkSettings, validateSettings, historyLocations, sessionDirectory, windowsSessionPath} = require('./client-settings.cjs');
const knowledge = require('./knowledge-service.cjs').createKnowledgeService();
const workDetails = require('./work-details.cjs').createWorkDetails({listWorks});
const {WorkRunner}=require('./work-runner.cjs');
const {AuxiliarySettings}=require('./auxiliary-settings.cjs');
const {AuxiliaryAgent}=require('./auxiliary-agent.cjs');
const {SessionTitles}=require('./session-titles.cjs');

let window, sessions, pet, feedback, selectedHistory, listedHistory = new Map(), terminal, runtimeMutation = false;
let windowsPreparation = Promise.resolve();
configureAppIdentity(app);
// Shortcut launches reveal the existing workbench instead of opening its
// IndexedDB again, including while the companion keeps the client alive.
if (!require('./single-instance.cjs').claimInstance(app, () => window)) return;
installTaskbarIdentity(app);
const settingsStore = new SettingsStore(app.getPath('userData'));
const auxiliarySettings=new AuxiliarySettings(app.getPath('userData'),safeStorage);
const auxiliaryAgent=new AuxiliaryAgent(auxiliarySettings);
const sessionTitles=new SessionTitles(auxiliaryAgent,auxiliarySettings);
const nativeWslHistory = new WslSessionHistory(app.getPath('userData'));
const historyTrash = new HistoryTrash(app.getPath('userData'));
const workRunner = new WorkRunner({listWorks,connections:()=>sessions?.list()||[],settings:()=>settingsStore.get()});
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
  window = new BrowserWindow({ width: 1440, height: 900, minWidth: 960, minHeight: 640, title: 'Lucyna · 工作台', icon: applicationIcon, backgroundColor: '#f9f9f8', ...windowChrome.windowOptions(), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments:windowChrome.enabled()?['--lucyna-titlebar']:[] } });
  if(windowChrome.enabled())windowChrome.installWindowChrome(window);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file://')) event.preventDefault(); });
  sessions = new SessionManager({titles:sessionTitles,create: send => new OmpSession(send), onState:async record=>{
    if(record.forkSource){
      record.forkTask ||= completeImportedFork(record.importRoot,record.agentDir,record.forkSource,record.sessionFile,record.root);
      try{await record.forkTask;record.forkSource=undefined;}finally{record.forkTask=undefined;}
    }
    await nativeWslHistory.remember(record);
  }, send: e => { workRunner.observe(e);pet?.ingest(e); if (window && !window.isDestroyed()) window.webContents.send('omp:event', e); }});
  workRunner.startAutomatic();
  pet=new PetController({directory:app.getPath('userData'),getMain:()=>window,getSessions:()=>sessions,onQuit:()=>app.quit(),onState:snapshot=>feedback?.observe(snapshot)});
  await pet.init().catch(error=>{console.error('Desktop companion:',error.message);});
  feedback=new FeedbackController({directory:app.getPath('userData'),getMain:()=>window,onChange:settings=>{pet.feedbackReducedMotion=settings.reducedMotion;pet.schedule();}});
  await feedback.init(pet.settings.reducedMotion);
  window.on('close',event=>{if(!quitting&&pet?.shouldKeepAlive()){event.preventDefault();window.hide();}});
  window.on('closed',()=>{if(!quitting)app.quit();});
  const handle = (name, fn) => ipcMain.handle(name, (e, ...args) => { onlyMain(e); return fn(...args); });
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
  handle('auxiliary:save',async input=>{const settings=await auxiliarySettings.save(input);for(const record of sessions.records.values())sessionTitles.cancel(record);return settings;});
  handle('auxiliary:check',input=>auxiliaryAgent.check(input));
  handle('settings:save', async input => {
    const next=validateSettings(input);
    if(runtimeMutation) throw new Error('设置正在保存，请稍候');
    runtimeMutation=true;
    try {await checkSettings(next);const settings=await settingsStore.save(next);selectedHistory=null;listedHistory.clear();return settings;}
    finally {runtimeMutation=false;}
  });
  handle('works:list', () => listWorks({refresh: true}));
  handle('work:details', root => workDetails(root));
  handle('work:run', (operation,data) => workRunner.call(operation,data));
  handle('work:git', (root, member, action, options) => workDetails(root, member, action, options));
  handle('clipboard:write-text', async text => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new Error('复制内容超过 4 MiB，请分段复制');
    await clipboard.writeText(text);
  });
  handle('work:read', async root => { const works = await listWorks(); if (!works.some(x => x.root === root && x.kind !== 'invalid')) throw new Error('无效工作根'); return (await readBounded(path.join(wslUnc(root), 'SESSION.md'), 512 * 1024, 'SESSION.md')).toString('utf8'); });
  handle('stele:context', query => { if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('请输入查询内容'); return steleCall('wiki_context', { query: query.trim() }); });
  handle('stele:knowledge', (kind,args) => knowledge(kind,args,event=>{if(window&&!window.isDestroyed())window.webContents.send('stele:knowledge-event',{requestId:args?.requestId,event});}));
  handle('stele:save-file', async (name,bytes) => {
    if(typeof name!=='string'||name.length>255||!(bytes instanceof Uint8Array)||bytes.length>64*1024*1024)throw Error('无效的知识导出内容');
    const result=await dialog.showSaveDialog(window,{defaultPath:path.basename(name)});
    if(result.canceled||!result.filePath)return false;
    await fs.writeFile(result.filePath,bytes);return true;
  });
  handle('omp:start', async options => {
    if (!options || typeof options.root !== 'string') throw new Error('请选择工作根');
    return sessions.start(options.clientSessionId, (startNative,signal,progress)=>{
    progress('正在检查后台任务');
    return workRunner.interactive(options.root,async()=>{
    progress('正在校验工作区');
    const defaults=await settingsStore.get();
    const settings={...defaults,runtime:options.resume&&['wsl','windows'].includes(options.runtime)?options.runtime:defaults.runtime};
    const locations=historyLocations(app.getPath('userData'),settings.runtime);
    const works = await listWorks();
    if (!works.some(x => x.root === options.root && x.kind !== 'invalid')) throw new Error('无效工作根');
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
      await installWorkSteleMcp(safe.agentDir);
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
  handle('omp:prepare-text', (id,files) => sessions.prepareTextAttachments(id,files));
  handle('omp:request', (type, data, id) => { if (!['get_state', 'get_messages', 'prompt', 'abort', 'abort_and_restore_queue', 'remove_queued_message', 'get_available_commands', 'get_available_models', 'set_model', 'set_ask_dialog'].includes(type)) throw new Error('Unsupported command'); return sessions.request(id,type,data); });
  handle('omp:ui-response', (data,id) => { if (!data || data.type !== 'extension_ui_response' || typeof data.id !== 'string') throw new Error('Invalid UI response'); return sessions.respond(id,data); });
  handle('omp:close', id => sessions.close(id));
  handle('omp:list', () => sessions.list());
  handle('omp:path', async () => {const s=await settingsStore.get();return s.runtime==='wsl'?s.wslExecutable:s.windowsExecutable;});
  handle('session:choose', async () => { const r = await dialog.showOpenDialog(window, { title: '选择 OMP 会话并导入副本（原件保留）', filters: [{ name: 'OMP session', extensions: ['jsonl'] }], properties: ['openFile'] }); selectedHistory = r.canceled ? null : r.filePaths[0]; return selectedHistory; });
  handle('session:list', async root => {
    const works = await listWorks();
    if (!works.some(x => x.root === root && x.kind !== 'invalid')) throw new Error('无效工作根');
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
  });
  const deletionPlan=async(source,root)=>{
    const listed=listedHistory.get(source);
    if(typeof source!=='string'||listed?.root!==root)throw Error('请从当前工作区的历史列表选择会话');
    const works=await listWorks();if(!works.some(work=>work.root===root&&work.kind!=='invalid'))throw Error('无效工作根');
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
    let plan=await deletionPlan(source,root);
    if(typeof token!=='string'||token!==plan.token)throw Error('文件或关联备忘已变化，请取消后重新确认删除范围');
    const release=sessions.reserveJournal(plan.source,plan.entry.id);let lease;
    try{
      lease=await acquireHistoryLease(plan);lease.check();
      // Fingerprints are checked again immediately before each rename.
      const key=await historyTrash.move(plan,{check:()=>lease.check()});listedHistory.delete(source);invalidateWslHistory();
      if(window&&!window.isDestroyed())window.webContents.send('omp:event',{type:'history_deleted',source:plan.source,workRoot:root});
      return key;
    }finally{await lease?.release();release();}
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
    if (!works.some(x => x.root === root && x.kind !== 'invalid')) throw new Error('无效工作根');
    const settings=await settingsStore.get();
    const locations=historyLocations(app.getPath('userData'),settings.runtime);
    const sourceRuntime=listedHistory.get(source)?.runtime;
    return await importSession({ source, cwd: wslUnc(root), destinationRoot: locations.historyDir, omp: settings.windowsExecutable, workRoot: root, settings, sourceRuntime });
    } finally {runtimeMutation=false;}
  });
  handle('external:open', async url => { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('仅支持 HTTP(S)'); await shell.openExternal(parsed.toString()); });
  handle('terminal:open', async root => { const works = await listWorks(); if (!works.some(x => x.root === root && x.kind !== 'invalid')) throw new Error('无效工作根'); const p = spawn('wsl.exe', [...runtime.wslPrefix, '--cd', root], { detached: true, stdio: 'ignore', windowsHide: false }); p.unref(); });
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
  handle('terminal:start', (root, dimensions) => terminal.start(root, dimensions));
  handle('terminal:input', (id, data) => terminal.input(id, data));
  handle('terminal:resize', (id, cols, rows) => terminal.resize(id, cols, rows));
  handle('terminal:close', id => terminal.close(id));
  handle('preview:list', async (root, directory, options) => {
    const works = await listWorks();
    if (!works.some(x => x.root === root && x.kind !== 'invalid')) throw new Error('无效工作根');
    return listDirectory(wslUnc(root), directory, options);
  });
  handle('preview:choose-file', async root => {
    const works = await listWorks();
    if (!works.some(x => x.root === root && x.kind !== 'invalid')) throw new Error('无效工作根');
    const workPath = await fs.realpath(wslUnc(root));
    const result = await dialog.showOpenDialog(window, {
      title: '选择当前 work 根中的文件', defaultPath: workPath,
      filters: [{ name: '文档、代码与图片', extensions: ['md', 'markdown', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'txt', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'py', 'js', 'jsx', 'ts', 'tsx', 'sh', 'ps1', 'c', 'cpp', 'h', 'rs', 'go', 'log', 'xml', 'csv', 'css', 'html'] }, {name: '所有文件', extensions: ['*']}],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readPreview(root, result.filePaths[0]);
  });
  async function readPreview(root, reference, basePath) {
    const works = await listWorks();
    if (!works.some(x => x.root === root && x.kind !== 'invalid')) throw new Error('无效工作根');
    if (typeof reference !== 'string' || !reference || reference.includes('\0')) throw new Error('无效文件路径');
    const workPath = await fs.realpath(wslUnc(root));
    const candidate = path.resolve(basePath ? path.dirname(path.resolve(workPath, basePath)) : workPath, reference);
    if (!within(workPath, candidate)) throw new Error('只能预览当前 work 根目录中的文件');
    const selectedPath = await fs.realpath(candidate);
    const relative = path.relative(workPath, selectedPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('只能预览当前 work 根目录中的文件');
    const extension = path.extname(selectedPath).toLowerCase();
    const kind = previewKind(selectedPath);
    if (kind === 'markdown' || kind === 'text') {
      const data = await readBounded(selectedPath, 1024 * 1024, kind === 'markdown' ? 'Markdown 文件' : '文本文件');
      if (data.includes(0)) throw new Error('该文件包含二进制数据，无法作为文本预览');
      return { kind, name: path.basename(selectedPath), path: selectedPath, content: data.toString('utf8') };
    }
    const mime = IMAGE_MIME[extension];
    if (!mime) throw new Error('此文件类型不支持预览');
    const data = await readBounded(selectedPath, 10 * 1024 * 1024, '图片');
    return { kind: 'image', name: path.basename(selectedPath), path: selectedPath, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
  }
  handle('preview:read', readPreview);
  handle('web:preview', async rawUrl => {
    if (typeof rawUrl !== 'string' || rawUrl.length > 2048) throw new Error('请输入有效网页地址');
    let url;
    try { url = new URL(rawUrl.trim()); } catch { throw new Error('请输入完整的 HTTP(S) 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网页预览只支持不含凭据的 HTTP(S) 地址');
    const preview = new BrowserWindow({
      width: 1100, height: 800, minWidth: 640, minHeight: 480, parent: window,
      title: `网页预览 · ${url.hostname}`, icon: applicationIcon,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, partition: `omp-web-preview-${randomUUID()}` }
    });
    const allowHttp = target => { try { return ['http:', 'https:'].includes(new URL(target).protocol); } catch { return false; } };
    preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    preview.webContents.on('will-navigate', (event, target) => { if (!allowHttp(target)) event.preventDefault(); });
    preview.webContents.on('will-redirect', (event, target) => { if (!allowHttp(target)) event.preventDefault(); });
    preview.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    preview.webContents.session.setPermissionCheckHandler(() => false);
    preview.webContents.session.on('will-download', (_event, item) => item.cancel());
    preview.once('ready-to-show', () => preview.show());
    try { await preview.loadURL(url.toString()); }
    catch (error) { if (!preview.isDestroyed()) preview.destroy(); throw new Error(`网页无法打开：${error.message}`); }
  });
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
  void (sessions?.closeAll()||Promise.resolve()).finally(async()=>{await workRunner.stopAutomatic();app.quit();});
});
app.on('before-quit', () => terminal?.dispose());
