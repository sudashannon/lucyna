// Real main/preload/renderer and native journal validation; isolated disk data.
// Only the OMP process and unrelated services are fixtures. No model requests.
const electron=require('electron'),{app,BrowserWindow}=electron,Module=require('node:module');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const out=path.resolve('.runtime/work-history-access-'+Date.now()),profile=path.join(out,'profile'),main=path.resolve('src/main.cjs');
fs.mkdirSync(profile,{recursive:true});process.env.LUCYNA_USERDATA=profile;app.disableHardwareAcceleration();
require('./desktop-log.cjs').installDesktopLog(out);
const backend=require('../src/backend.cjs'),{defaults,historyLocations}=require('../src/client-settings.cjs');
fs.writeFileSync(path.join(profile,'client-settings.json'),JSON.stringify({...defaults(),runtime:'wsl'}));
const root=require('../src/runtime-config.cjs').workRoot+'/history-git-fixture',peer=root+'-peer',workspace=path.join(out,'workspace');
fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'SESSION.md'),'# Fixture Work\n- 状态: active\n');
const agent=historyLocations(profile,'wsl').agentDir,journal=path.join(agent,'sessions','fixture','original.jsonl');
fs.mkdirSync(path.dirname(journal),{recursive:true});fs.writeFileSync(journal,JSON.stringify({type:'session',id:'fixture-original',cwd:root})+'\n'+JSON.stringify({type:'message',message:{role:'user',content:'原始 IMU 会话记录'}})+'\n');
const hash=()=>createHash('sha256').update(fs.readFileSync(journal)).digest('hex'),before=hash(),calls=[];let missing=false,win;
const issue={code:'git_top',severity:'error',member:'qcom-build',message:'fatal: not a git repository: /missing/qcom-build.git/worktrees/qcom-build2'};
const works=()=>[{root,name:'rx101-head-imu-workflow',rootAvailable:!missing,kind:'invalid',error:missing?'missing directory':issue.message,issues:missing?[{code:'root_invalid',severity:'error',message:'missing directory'}]:[issue]},{root:peer,name:'healthy-work',kind:'work',rootAvailable:true}];
class NativeFixture{
 constructor(send){this.send=send;this.child=null;this.ready=false;}
 async start(options){calls.push({type:'start',resume:options.resume});this.file=options.resume;this.child={};this.ready=true;setImmediate(()=>this.send({type:'ready'}));return{runtime:'wsl'};}
 async request(type){calls.push({type});if(type==='prompt')throw Error('Model prompt forbidden');return type==='get_state'?{sessionId:'fixture-original',sessionFile:this.file,sessionName:'原始 IMU 会话记录',isSettled:true}:{};}
 async messages(){calls.push({type:'get_messages'});return{messages:[{role:'user',content:'原始 IMU 会话记录'},{role:'assistant',content:'HISTORY_FROM_ORIGINAL_JOURNAL'}]};}
 async close(){this.child=null;this.ready=false;this.send({type:'process_exit',code:0});}
}
class Window extends BrowserWindow{constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}});win||=this;}show(){}}
class Runner{startAutomatic(){}observe(){}async stopAutomatic(){}async interactive(_root,callback){return callback();}async admit(_root,callback){return callback();}async call(operation){return operation==='list'?[]:{enabled:false,status:'paused',profile:null};}}
class Pet{constructor(){this.settings={reducedMotion:true};}async init(){}ingest(){}context(){}shouldKeepAlive(){return false;}dispose(){}snapshot(){return{settings:require('../src/pet/state.cjs').defaults(),warning:''};}}
class Feedback{async init(){}context(){}dispose(){}snapshot(){return{settings:require('../src/feedback/settings.cjs').defaults(),warning:''};}}
const load=Module._load;Module._load=function(name,parent,isMain){
 if(parent?.filename===main){
  if(name==='electron')return{...electron,BrowserWindow:Window};
  if(name==='./backend.cjs')return{...backend,listWorks:async()=>works(),wslUnc:()=>workspace,OmpSession:NativeFixture};
  if(name==='./history.cjs')return{...load.call(this,name,parent,isMain),listWslSessions:async()=>({sessions:[],total:0})};
  if(name==='./work-runner.cjs')return{WorkRunner:Runner};
  if(name==='./pet/controller.cjs')return{PetController:Pet};if(name==='./feedback/controller.cjs')return{FeedbackController:Feedback};
  if(name==='./knowledge-managed.cjs')return{createManagedKnowledge:()=>async()=>({})};
  if(name==='./work-details.cjs')return{createWorkDetails:()=>async selected=>({root:selected,content:'# Fixture',members:[],assets:[],issues:[issue],warnings:[]})};
 }
 return load.call(this,name,parent,isMain);
};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),js=code=>win.webContents.executeJavaScript(code,true),click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function until(code){const end=Date.now()+15000;while(Date.now()<end){if(win&&!win.webContents.isLoading()&&await js(`Boolean(${code})`))return;await pause(40);}throw Error('Timeout '+code);}
async function shot(name){await js('document.fonts.ready');await pause(120);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
require(main);Module._load=load;
app.whenReady().then(async()=>{const timer=setTimeout(()=>app.exit(2),90000);try{
 await until('document.querySelectorAll(".work-row").length===2');await click('.work-row');await until('document.querySelectorAll(".recent-sessions .history-row").length===1');
 assert.ok(await js('document.querySelector(".work-health-notice").textContent.includes("会话仍可读取和继续")'));assert.equal(await js('document.querySelector("#message-input").disabled'),false);
 const history=await js(`window.desktop.listHistory(${JSON.stringify(root)})`);assert.equal(history.managed[0].sessionFile,journal);assert.equal(await js(`window.desktop.readWork(${JSON.stringify(root)})`),'# Fixture Work\n- 状态: active\n');
 await shot('git-error-history-light');await click('.work-health-notice button');await until('document.querySelector(".work-diagnostics-modal")');assert.ok(await js('document.querySelector(".work-check-list").textContent.includes("not a git repository")'));await click('button[aria-label="关闭弹窗"]');
 await click('.recent-sessions .history-row');await until('document.querySelector(".transcript")?.textContent.includes("HISTORY_FROM_ORIGINAL_JOURNAL")');
 assert.equal(calls.find(call=>call.type==='start').resume,journal);assert.equal(hash(),before);assert.equal(calls.filter(call=>call.type==='prompt').length,0);
 await assert.rejects(js(`window.desktop.start({root:${JSON.stringify(root)},clientSessionId:'duplicate',resume:${JSON.stringify(journal)},agentDir:${JSON.stringify(agent)},runtime:'wsl'})`),/另一.*(会话|连接)/);
 await assert.rejects(js(`window.desktop.start({root:${JSON.stringify(peer)},clientSessionId:'wrong-work',resume:${JSON.stringify(journal)},agentDir:${JSON.stringify(agent)},runtime:'wsl'})`),/其他工作根/);
 await assert.rejects(js('window.desktop.listHistory("/not-in-the-workspace")'),/无效工作根/);
 await js('document.querySelector("#message-input").focus()');await win.webContents.insertText('保留草稿，不发送');const active=await js('document.querySelector(".app-shell").dataset.sessionId');
 await click('.work-group:nth-child(2) .work-row');await click(`.sidebar [data-session="${active}"]`);assert.equal(await js('document.querySelector("#message-input").value'),'保留草稿，不发送');
 await shot('resumed-light');win.setSize(960,640);await click('button[aria-label="切换深色外观"]');await shot('resumed-narrow-dark');
 missing=true;await click('button[aria-label="刷新工作区"]');await until('document.querySelector(".notice")?.textContent.includes("工作目录暂不可用")');assert.equal(await js('document.querySelector("#message-input").disabled'),true);
 assert.equal(hash(),before);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,calls,journalUnchanged:hash()===before},null,2));console.log('PASS real main IPC lists and resumes an original journal despite a broken Git member; root, provenance and duplicate-writer guards remain');console.log('ARTIFACTS '+out);clearTimeout(timer);app.exit(0);
 }catch(error){console.error(error);await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:error.stack,calls},null,2));clearTimeout(timer);app.exit(1);}});
