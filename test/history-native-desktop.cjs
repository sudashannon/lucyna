// Opt-in native acceptance: real OMP and model, isolated Electron profile.
// Creates one clearly named test journal in the selected WSL work's native store.
// Never opens a user's existing journal, merges copies, or changes work files.
// electron test/history-native-desktop.cjs --work=/absolute/configured/work
const electron=require('electron'),{app,BrowserWindow}=electron,Module=require('node:module');
const path=require('node:path'),fs=require('node:fs/promises'),sync=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=process.argv.find(a=>a.startsWith('--work='))?.slice(7);
if(!root||!root.startsWith('/'))throw Error('Specify --work=/absolute/configured/work for the opt-in test');
const out=path.resolve('.runtime','history-native-'+Date.now()),profile=path.join(out,'profile'),main=path.resolve('src/main.cjs');
sync.mkdirSync(profile,{recursive:true});process.env.LUCYNA_USERDATA=profile;
const {defaults,windowsSessionPath,wslSessionPath}=require('../src/client-settings.cjs');
const settings={...defaults(),runtime:'wsl'};sync.writeFileSync(path.join(profile,'client-settings.json'),JSON.stringify(settings));
app.disableHardwareAcceleration();
const backend=require('../src/backend.cjs'),native=[],events=[];let win,seed;
class Window extends BrowserWindow{constructor(o){super({...o,show:false,webPreferences:{...o.webPreferences,offscreen:true,backgroundThrottling:false}});win||=this;}show(){}}
class Tracked extends backend.OmpSession{constructor(send){super(e=>{events.push({type:e.type,id:e.clientSessionId});send(e);});native.push(this);}async start(options){console.log('START',JSON.stringify({resume:options.resume,fork:!!options.fork,agentDir:options.agentDir,runtime:options.settings.runtime}));return super.start(options);}}
const load=Module._load;Module._load=function(name,parent,isMain){if(parent?.filename===main){if(name==='electron')return{...electron,BrowserWindow:Window};if(name==='./backend.cjs')return{...backend,OmpSession:Tracked};}return load.call(this,name,parent,isMain);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),js=code=>win.webContents.executeJavaScript(code);
async function until(code,label,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){if(win&&!win.webContents.isLoading()&&await js(code))return;await pause(150);}throw Error('Timeout '+label+' '+await js('document.querySelector(".notice")?.textContent||""'));}
const hash=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const active=()=>js('document.querySelector(".app-shell").dataset.sessionId');
const state=async()=>js(`window.desktop.request('get_state',{},${JSON.stringify(await active())})`);
const history=()=>js(`window.desktop.listHistory(${JSON.stringify(root)})`);
async function refresh(){await history();await js('document.querySelector("button[aria-label=刷新历史会话]").click()');await pause(250);}
async function row(title,copy=false,origin='WSL 原生'){await js(`(()=>{const item=Array.from(document.querySelectorAll('#tool-panel-history .history-item')).find(n=>n.querySelector('.history-label>span').textContent===${JSON.stringify(title)}&&n.querySelector('small').textContent.includes(${JSON.stringify(origin)}));if(!item)throw Error('History row missing');item.querySelector(${JSON.stringify(copy?'.history-copy':'.history-row')}).click();})()`);await pause(250);}
async function connected(){await until('document.querySelector(".composer-footnote")?.textContent.includes("会话已连接")','connected');}
async function submit(message){await js('document.querySelector("#message-input").focus()');await win.webContents.insertText(message);await js('document.querySelector("button[aria-label=发送消息]").click()');await until('!!document.querySelector(".stop-button")','prompt accepted');await until('!document.querySelector(".stop-button")','prompt settled',120000);}
require(main);Module._load=load;
app.whenReady().then(async()=>{
 const checks=[],timer=setTimeout(()=>{console.error('Deadline');void Promise.allSettled([seed,...native].filter(Boolean).map(s=>s.close())).finally(()=>app.exit(2));},300000);
 let result={},failure;
 try{
  const stamp=crypto.randomUUID().slice(0,8),seedText='Lucyna 原地续聊验收 '+stamp+'：请只回复 NATIVE_ORIGINAL_OK。不要调用工具，不读写工作区文件。';
  let ready,settled;const readyWait=new Promise(resolve=>ready=resolve),done=new Promise(resolve=>settled=resolve);
  seed=new backend.OmpSession(e=>{if(e.type==='ready')ready();if(e.type==='prompt_result')settled(e);});
  await seed.start({root,agentDir:settings.wslAgentDir,settings});await readyWait;
  await seed.request('prompt',{message:seedText});assert.equal((await done).status,'completed');
  const originalState=await seed.request('get_state'),source=windowsSessionPath(originalState.sessionFile),originalId=originalState.sessionId;
  await seed.close();const originalBytes=await fs.readFile(source),beforeHash=await hash(source);
  assert.ok(wslSessionPath(source).startsWith(settings.wslAgentDir+'/sessions/'));
  assert.equal(sync.existsSync(path.join(profile,'wsl-session-links')),false,'original predates client registration');
  const {WslSessionHistory}=require('../src/wsl-session-history.cjs'),resolver=new WslSessionHistory(profile);
  await assert.rejects(resolver.resolve(settings.wslAgentDir,source,root+'-other',settings.wslAgentDir),/其他工作根/);
  await assert.rejects(resolver.resolve(settings.wslAgentDir+'/other',source,root,settings.wslAgentDir));
  assert.equal(sync.existsSync(path.join(profile,'wsl-session-links')),false,'rejected access writes no pointer');assert.equal(await hash(source),beforeHash);
  checks.push('Wrong-work and unregistered-profile access is rejected without modifying source or registering a pointer.');
  console.log('PASS native OMP created an independent test history outside the client profile');
  await until('document.querySelectorAll(".work-row").length>0','work list');
  await js(`Array.from(document.querySelectorAll('.work-row')).find(b=>b.textContent.trim()===${JSON.stringify(root.split('/').at(-1))}).click()`);
  await js('document.querySelector("button[aria-label=展开工具面板]")?.click()');await until('!!document.querySelector("#tab-history")','history panel');await js('document.querySelector("#tab-history").click()');
  await until(`window.desktop.listHistory(${JSON.stringify(root)}).then(h=>h.sessions.some(e=>e.sessionFile===${JSON.stringify(source)}))`,'unregistered native history discovered');
  let entry=(await history()).sessions.find(e=>e.sessionFile===source);assert.equal(entry.sourceKind,'native-wsl');assert.equal(entry.agentDir,settings.wslAgentDir);
  assert.equal(await hash(source),beforeHash,'history listing is read-only');await refresh();
  await row(entry.title||entry.id);await connected();let opened=await state();
  assert.equal(opened.sessionId,originalId);assert.equal(opened.sessionFile,source);assert.equal(sync.existsSync(path.join(profile,'history-wsl')),false);
  assert.ok(native[0].child.spawnargs.includes('--resume'));assert.ok(!native[0].child.spawnargs.includes('--session-dir'));
  await submit('Lucyna 原地续聊验收：请只回复 NATIVE_RESUME_OK。不要调用工具，不读写工作区文件。');opened=await state();
  assert.equal(opened.sessionId,originalId);assert.equal(opened.sessionFile,source);
  const messages=await js(`window.desktop.request('get_messages',{},${JSON.stringify(await active())})`);assert.ok(messages.messages.some(m=>m.role==='assistant'&&JSON.stringify(m).includes('NATIVE_RESUME_OK')));
  const appended=await fs.readFile(source);assert.ok(appended.length>originalBytes.length);assert.ok(appended.includes(Buffer.from(seedText)));
  assert.equal(sync.existsSync(path.join(profile,'history-wsl')),false,'native continuation never creates a Windows copy');
  checks.push('Unregistered WSL history opens and continues at the original file and session ID, without Windows copy.');console.log('PASS original file, native ID, loaded history and real-model continuation');
  const originalClient=await active();await js(`window.desktop.close(${JSON.stringify(originalClient)})`);await until('!document.querySelector(".composer-footnote")?.textContent.includes("会话已连接")','original stopped');
  const afterOriginalHash=await hash(source);entry=(await history()).managed.find(e=>e.sessionFile===source);await refresh();
  await row(entry.title||entry.id,true);await connected();const copyState=await state(),copyClient=await active();
  assert.notEqual(copyState.sessionFile,source);assert.notEqual(copyState.sessionId,originalId);assert.ok(copyState.sessionFile.startsWith(path.join(profile,'history-wsl')));assert.equal(await hash(source),afterOriginalHash);
  assert.ok(native.at(-1).child.spawnargs.includes('--fork'));
  assert.ok((await js(`window.desktop.request('get_messages',{},${JSON.stringify(copyClient)})`)).messages.some(m=>JSON.stringify(m).includes('NATIVE_RESUME_OK')));
  checks.push('Explicit copy uses native pack/unpack and fork, gets an independent ID, retains history and leaves the closed original byte-for-byte unchanged.');console.log('PASS explicit copy and original hash preserved');
  await js(`window.desktop.close(${JSON.stringify(copyClient)})`);await refresh();await row(entry.title||entry.id,false,'已有副本');await connected();
  assert.equal((await state()).sessionFile,copyState.sessionFile);assert.ok(!native.at(-1).child.spawnargs.includes('--fork'));checks.push('An existing copy reopens at the same journal and does not fork or copy again.');
  await refresh();await row(entry.title||entry.id);await connected();assert.equal((await state()).sessionFile,source);assert.notEqual(await active(),copyClient);
  assert.equal((await js('window.desktop.listConnections()')).length,2);checks.push('Clicking the original returns to its writer, not the copy with the same provenance.');
  await assert.rejects(js(`window.desktop.start({root:${JSON.stringify(root)},clientSessionId:'duplicate-check',resume:${JSON.stringify(source)},agentDir:${JSON.stringify(settings.wslAgentDir)},runtime:'wsl'})`),/已在另一/);
  checks.push('A duplicate writer for the same native journal is rejected.');
  // Close only this isolated client's writers before a cross-runtime copy.
  for(const connection of await js('window.desktop.listConnections()'))await js(`window.desktop.close(${JSON.stringify(connection.id)})`);
  const beforeTransfer=await hash(source);
  await js('document.querySelector("button[aria-label=设置]").click()');await until('document.querySelectorAll(".runtime-options button").length===2','runtime settings');
  await js('document.querySelectorAll(".runtime-options button")[1].click()');await js('Array.from(document.querySelectorAll(".settings-modal button")).find(b=>b.textContent==="保存默认设置").click()');
  await until('!document.querySelector(".settings-modal")','settings saved');assert.equal((await js('window.desktop.getSettings()')).settings.runtime,'windows');
  await refresh();await row(entry.title||entry.id);await connected();const windows=await state();
  assert.ok(windows.sessionFile.startsWith(path.join(profile,'history')));assert.notEqual(windows.sessionFile,source);assert.equal(await hash(source),beforeTransfer);
  assert.ok(native.at(-1).child.spawnfile.toLowerCase().endsWith('omp.exe'));
  checks.push('Windows mode creates a separate native transfer copy while the WSL source stays unchanged.');console.log('PASS cross-runtime native Windows copy');
  result={passed:true,checks,source,originalId,copy:copyState.sessionFile,windowsCopy:windows.sessionFile};
 }catch(error){failure=error;result={passed:false,checks,error:error.stack,openSessions:await js('localStorage.getItem("omp.openSessions.v1")').catch(()=>null)};console.error(error.stack);}
 finally{clearTimeout(timer);await Promise.allSettled([seed,...native].filter(Boolean).map(s=>s.close()));await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log('REPORT '+out);app.exit(failure?1:0);}
});
