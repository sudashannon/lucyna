// Real main, preload, renderer, WSL Work inventory and journal validation.
// The native process is a fixture so the test never calls a model.
const electron=require('electron'),{app,BrowserWindow}=electron,Module=require('node:module');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const local=JSON.parse(fs.readFileSync(process.env.LUCYNA_CONFIG||'runtime.local.json','utf8'));
const prefix=['-d',local.distro,'-u',local.user,'--exec'];
const temp=execFileSync('wsl.exe',[...prefix,'mktemp','-d','/tmp/lucyna-create-work.XXXXXXXX'],{encoding:'utf8'}).trim();
assert.match(temp,/^\/tmp\/lucyna-create-work\.[A-Za-z0-9]+$/);
const base=temp+'/develop',root=base+'/first-work',agent=temp+'/agent';
const out=path.resolve('.runtime/work-creation-desktop-'+Date.now()),profile=path.join(out,'profile');
fs.mkdirSync(profile,{recursive:true});
process.env.LUCYNA_USERDATA=profile;
process.env.LUCYNA_CONFIG=path.join(out,'runtime.json');
fs.writeFileSync(process.env.LUCYNA_CONFIG,JSON.stringify({distro:local.distro,user:local.user,home:local.home,
  skillDirectory:local.skillDirectory,workRoot:base,wslAgentDir:agent,defaultRuntime:'wsl'}));
const {windowsSessionPath}=require('../src/client-settings.cjs');
const native=p=>windowsSessionPath(p);
fs.mkdirSync(native(agent+'/commands'),{recursive:true});
fs.writeFileSync(native(agent+'/commands/work-start.md'),'# Fixture command\n');
app.disableHardwareAcceleration();
require('./desktop-log.cjs').installDesktopLog(out);

const main=path.resolve('src/main.cjs'),backend=require('../src/backend.cjs'),calls=[];
let win;
class NativeFixture {
  constructor(send){this.send=send;this.child=null;this.ready=false;this.id=randomUUID();this.history=[];}
  async start(options){
    assert.ok(options.creation);assert.equal(options.root,base);
    calls.push({type:'start'});
    this.cwd=base;this.file=agent+'/sessions/base/'+this.id+'.jsonl';this.writeJournal();
    this.child={};this.ready=true;
    setImmediate(()=>this.send({type:'ready'}));
    return {runtime:'wsl'};
  }
  writeJournal(){
    fs.mkdirSync(path.dirname(native(this.file)),{recursive:true});
    fs.writeFileSync(native(this.file),JSON.stringify({type:'session',id:this.id,cwd:this.cwd})+'\n');
  }
  async request(type,data){
    if(type==='get_state')return {sessionId:this.id,sessionFile:this.file,isSettled:!this.running,queuedMessages:[]};
    if(type==='get_available_commands')return {commands:[{name:'work-start',source:'file'}]};
    if(type!=='prompt')return {};
    calls.push({type:'prompt',message:data.message});
    if(data.message.startsWith('/move ')){
      assert.equal(data.message,'/move '+root);
      const original=this.file;
      this.cwd=root;this.file=agent+'/sessions/first-work/'+this.id+'.jsonl';this.writeJournal();
      fs.unlinkSync(native(original));
      return {agentInvoked:false};
    }
    assert.equal(data.message,'/work-start 验证空工作区建根');
    this.running=true;
    this.history.push({role:'user',content:data.message});
    setImmediate(()=>{
      this.send({type:'agent_start'});
      this.send({type:'extension_ui_request',id:'approve-create',method:'confirm',title:'建根计划',message:'确认创建这个 Work？'});
    });
    return {agentInvoked:true};
  }
  sendFrame(data){
    assert.equal(data.id,'approve-create');assert.equal(data.confirmed,true);
    setImmediate(()=>{
      fs.mkdirSync(native(root));
      fs.writeFileSync(native(root+'/SESSION.md'),'# First Work\n- 状态: active\n');
      fs.writeFileSync(native(root+'/work.json'),'{"version":1,"members":[]}\n');
      fs.writeFileSync(native(root+'/SESSION-'+this.id+'.md'),'# 本次建根会话\n');
      const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:'Work 已校验。\n/move '+root+'\n迁入后发送 /work-continue。'}]};
      this.history.push(message);this.running=false;
      this.send({type:'message_end',messageId:'handoff',message});
      this.send({type:'prompt_result',status:'completed',sessionSettled:true});
      this.send({type:'session_settled'});
    });
  }
  async messages(){return {messages:this.history};}
  async close(){this.child=null;this.ready=false;}
}
class Window extends BrowserWindow{
  constructor(options){super({...options,show:false,minWidth:0,minHeight:0,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}});win||=this;}
  show(){}
}
class Runner{
  startAutomatic(){}observe(){}async stopAutomatic(){}
  async interactive(_root,run){return run();}
  async call(){return [];}
}
class Pet{constructor(){this.settings={reducedMotion:true};}async init(){}ingest(){}context(){}shouldKeepAlive(){return false;}dispose(){}}
class Feedback{async init(){}dispose(){}context(){}snapshot(){return {settings:require('../src/feedback/settings.cjs').defaults(),warning:''};}}
const load=Module._load;
Module._load=function(name,parent,isMain){
  if(parent?.filename===main){
    if(name==='electron')return {...electron,BrowserWindow:Window};
    if(name==='./backend.cjs')return {...backend,OmpSession:NativeFixture};
    if(name==='./work-runner.cjs')return {WorkRunner:Runner};
    if(name==='./pet/controller.cjs')return {PetController:Pet};
    if(name==='./feedback/controller.cjs')return {FeedbackController:Feedback};
    if(name==='./knowledge-managed.cjs')return {createManagedKnowledge:()=>async()=>({})};
  }
  return load.call(this,name,parent,isMain);
};
require(main);Module._load=load;

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
const press=(selector,label)=>js(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(button=>button.textContent.trim()===${JSON.stringify(label)}).click()`);
async function until(condition){
  const end=Date.now()+30000;
  while(Date.now()<end){
    if(win&&!win.webContents.isLoading()&&await js('Boolean('+condition+')').catch(()=>false))return;
    await pause(50);
  }
  throw Error('Timeout '+condition);
}
async function capture(name){
  await js('document.fonts.ready');
  await pause(160);
  assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
  fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());
}
function cleanup(){
  const target=fs.realpathSync(native(temp)),parent=fs.realpathSync(native('/tmp'));
  assert.equal(path.dirname(target),parent);
  assert.match(path.basename(target),/^lucyna-create-work\.[A-Za-z0-9]+$/);
  fs.rmSync(target,{recursive:true,force:true});
}
app.whenReady().then(async()=>{
  const timer=setTimeout(()=>app.exit(2),100000);
  try{
    await until('Array.from(document.querySelectorAll(".work-section-actions button")).some(button=>button.textContent.trim()==="新建 Work"&&!button.disabled)');
    assert.equal(await js('document.querySelectorAll(".work-row").length'),0);
    assert.equal(await js('document.querySelectorAll(".notice[role=alert]").length'),0);
    assert.equal(fs.existsSync(native(base)),false);
    await press('.work-section-actions button','新建 Work');
    await until('document.querySelector(".work-creation-field textarea")');
    await js('document.querySelector(".work-creation-field textarea").focus()');
    await win.webContents.insertText('验证空工作区建根');
    await capture('new-work');
    await press('.modal-actions button','交给 OMP');
    await until('document.querySelector(".modal")?.textContent.includes("建根计划")');
    const id=await js('document.querySelector(".app-shell").dataset.sessionId');
    assert.equal(fs.existsSync(native(root)),false);
    assert.equal(calls.filter(call=>call.type==='prompt').length,1);
    await press('.modal-actions button','确认');
    await until('document.querySelector(".work-row[aria-current=page]")?.textContent.includes("first-work")');
    assert.equal(await js('document.querySelector(".app-shell").dataset.sessionId'),id);
    assert.equal(await js('document.querySelector("#message-input").disabled'),false);
    assert.ok(await js('document.querySelector(".transcript")?.textContent.includes("Work 已校验")'));
    await capture('handoff');
    win.webContents.reload();
    await until('document.querySelector(".work-row[aria-current=page]")?.textContent.includes("first-work") && document.querySelector(".transcript")?.textContent.includes("Work 已校验")');
    assert.equal(await js('document.querySelector(".app-shell").dataset.sessionId'),id);
    assert.deepEqual(calls.map(call=>call.message||call.type),['start','/work-start 验证空工作区建根','/move '+root]);
    win.setContentSize(640,760);
    await until('Math.abs(innerWidth-640)<=2 && document.querySelector("button[aria-label=\\\"新建 Work\\\"]")');
    await js(`Array.from(document.querySelectorAll('button[aria-label="切换深色外观"]')).find(button=>button.getClientRects().length).click()`);
    await js(`document.querySelector('button[aria-label="新建 Work"]').click()`);
    await until('document.querySelector(".work-creation-field textarea") && document.documentElement.dataset.theme==="dark"');
    await capture('new-work-narrow-dark');
    console.log('PASS empty WSL root, explicit approval, same-session handoff and renderer reload',out);
    clearTimeout(timer);cleanup();app.exit(0);
  }catch(error){console.error(error);await capture('failure').catch(()=>{});clearTimeout(timer);try{cleanup();}catch(e){console.error(e.message);}app.exit(1);}
});
