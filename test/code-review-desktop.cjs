// Production renderer + production preload + real review service. All Work/model data is synthetic.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {CodeReviewService}=require('../src/code-review.cjs');
const out=path.resolve('.runtime/code-review-desktop-'+Date.now());fs.mkdirSync(out,{recursive:true});
app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
require('./desktop-log.cjs').installDesktopLog(out);
const root='/home/demo/work/review',sessionId='review-session',timestamp=1800000000000,messageId='user-'+timestamp;
const patch='diff --git a/src/authorize.ts b/src/authorize.ts\nindex 1111111..2222222 100644\n--- a/src/authorize.ts\n+++ b/src/authorize.ts\n@@ -1,3 +1,2 @@\n-export function authorize(user) {\n-  return Boolean(user);\n-}\n+export const authorize = () => true;\n+export const version = 2;\n';
let win,mode='ok',modelCalls=0;const requests=[],errors=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
async function until(code,label,timeout=18000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await js(`Boolean(${code})`))return;await pause(60);}throw Error('Timeout: '+label);}
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const button=(label,scope='.code-review')=>js(`Array.from(document.querySelectorAll(${JSON.stringify(scope+' button')})).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
async function shot(name){await js('document.fonts.ready');await pause(100);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
const service=new CodeReviewService({directory:path.join(out,'reviews'),
  resolveSource:async source=>({key:JSON.stringify(source),root,source,load:async()=>({capturedAt:timestamp,
    files:[{member:'app',path:'src/authorize.ts',scope:source.kind==='turn'?'turn':source.scope==='unstaged'?'unstaged':'staged',patch}],warnings:[],partial:false})}),
  config:async()=>({baseURL:'https://fixture.invalid',model:'fixture-review',protocol:'chat-completions'}),
  engine:{id:'native-fixture',version:'1',review:async(_config,snapshot,signal)=>{
    modelCalls++;if(mode==='hold')await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>setTimeout(()=>reject(signal.reason),250),{once:true});});
    if(mode==='fail')throw Object.assign(Error('模拟模型 JSON 不完整'),{publicMessage:'模拟模型 JSON 不完整，请重试'});
    return {findings:[{fileId:snapshot.files[0].id,severity:'high',title:'授权检查变为无条件通过',body:'未登录请求同样返回 true，调用方据此放行时会绕过权限判断。',evidence:'export const authorize = () => true;',lineStart:1,lineEnd:1,suggestion:'恢复对用户与权限条件的检查。'}],usage:{inputTokens:50,outputTokens:35}};
  }},
});
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>app.exit(2),100000);
 try{
  const handle=(name,fn)=>ipcMain.handle(name,(_, ...args)=>fn(...args));
  handle('works:list',()=>[{root,name:'代码审查演示',kind:'work'}]);
  handle('omp:list',()=>[{id:sessionId,root,sessionFile:'/demo/review.jsonl',runtime:'wsl',ready:true,busy:false}]);
  handle('settings:get',()=>({settings:require('../src/client-settings.cjs').defaults()}));
  handle('feedback:get',()=>({settings:require('../src/feedback/settings.cjs').defaults(),warning:''}));
  handle('pet:context',()=>{});handle('session:list',()=>({sessions:[],managed:[]}));handle('work:run',()=>[]);
  handle('work:read',()=>'# 审查演示\n');
  handle('work:details',()=>({root,name:'代码审查演示',members:[{name:'app',path:root+'/repos/app',repo:'/demo/app.git',branch:'codex/review',head:'a'.repeat(40),counts:{staged:1,unstaged:1,untracked:0,conflicts:0}}],assets:[],issues:[],warnings:[],content:'# 演示'}));
  handle('work:git',(_root,member,action,options)=>{
    if(action==='changes')return {files:[{path:'src/authorize.ts',code:'MM',staged:true,unstaged:true}],counts:{staged:1,unstaged:1,untracked:0,conflicts:0}};
    if(action==='diff')return {text:patch.replace('version = 2','version = 99 /* live workspace */')};
    return {};
  });
  handle('omp:request',(type,data,id)=>{
    requests.push({type,id});
    if(type==='get_state')return {sessionName:'本地审查任务',sessionFile:'/demo/review.jsonl',isSettled:true};
    if(type==='get_messages')return {messages:[{role:'user',timestamp,content:'调整授权检查，保留未登录请求的限制。'},{role:'assistant',timestamp:timestamp+1000,content:'已完成改动，可审查本轮差异。'}]};
    return {};
  });
  handle('turn-changes:list',()=>[{messageId,files:1,partial:false}]);
  handle('turn-changes:read',()=>({messageId,startedAt:timestamp,finishedAt:timestamp+1000,files:[{member:'app',path:'src/authorize.ts',patch}],warnings:[]}));
  handle('code-review:start',source=>service.start(source));handle('code-review:list',source=>service.list(source));
  handle('code-review:read',id=>service.read(id));handle('code-review:cancel',id=>service.cancel(id));handle('code-review:finding',(...args)=>service.updateFinding(...args));
  win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{preload:path.resolve('src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await win.loadFile(path.resolve('dist/renderer/index.html'));
  await until('document.querySelector(".work-row")','Work visible');await click('.work-row');
  await until('document.querySelector(".turn-review-action")','turn entry');await click('.turn-review-action');
  await until('document.querySelector(".turn-changes .code-review")','review panel');
  await button('审查本轮改动');
  await until('document.querySelector(".turn-changes .code-review-status")?.dataset.state==="completed"','completed review');
  await until('document.querySelector(".code-review-finding-toggle")','finding');
  assert.equal(modelCalls,1);assert.ok(await js('!document.querySelector(".code-review").textContent.includes("无效")'));
  await shot('turn-findings-light');
  await click('.code-review-finding-toggle');await button('定位代码');
  await until('document.querySelector(".code-review-focused-line")','validated line highlight');
  assert.ok(await js('document.querySelector(".code-review-diff").textContent.includes("version = 2")'));
  assert.ok(await js('!document.querySelector(".code-review-diff").textContent.includes("live workspace")'));
  await js('document.querySelector("#message-input").focus()');await win.webContents.insertText('保留已有草稿。');
  await button('加入修复草稿');
  assert.ok(await js('document.querySelector("#message-input").value.includes("保留已有草稿")&&document.querySelector("#message-input").value.includes("授权检查变为无条件通过")'));
  assert.equal(requests.filter(r=>r.type==='prompt').length,0,'draft never sends itself');
  await button('忽略');await until('document.querySelector(".code-review-finding")?.dataset.status==="ignored"','ignore');
  await button('恢复');await until('document.querySelector(".code-review-finding")?.dataset.status==="open"','restore finding');
  await shot('turn-location-light');
  await click('.turn-changes .panel-title .text-action');
  await until('document.querySelector("#tool-panel-changes .code-review")','workspace review');
  await until('Array.from(document.querySelectorAll("#tool-panel-changes .code-review button")).some(b=>b.textContent.trim()==="审查未提交改动"&&!b.disabled)','workspace entry ready');
  mode='hold';await button('审查未提交改动','#tool-panel-changes .code-review');
  await until('document.querySelector("#tool-panel-changes .code-review-status")?.dataset.state==="running"','running workspace');
  await button('停止','#tool-panel-changes .code-review');
  await until('document.querySelector("#tool-panel-changes .code-review-status")?.dataset.state==="cancelled"','cancel confirmed');
  assert.ok(await js('!document.querySelector("#tool-panel-changes .code-review-clean")'));
  mode='fail';await button('重新审查未提交改动','#tool-panel-changes .code-review');
  await until('document.querySelector("#tool-panel-changes .code-review-status")?.dataset.state==="failed"','model failure');
  assert.ok(await js('document.querySelector("#tool-panel-changes .code-review-error-text").textContent.includes("JSON")&&!document.querySelector("#tool-panel-changes .code-review-clean")'));
  await shot('workspace-failure-light');
  await click('.turn-review-action');await until('document.querySelector(".turn-changes .code-review-finding-toggle")','stored finding restored');
  await click('button[aria-label="切换深色外观"]');win.setContentSize(760,860);await pause(200);
  await click('.turn-review-action');await pause(100); // compact layout opens the tools drawer
  if(!await js('Boolean(document.querySelector(".turn-changes")?.getClientRects().length)'))await click('.turn-review-action');
  await until('document.querySelector(".turn-changes .code-review")?.getClientRects().length','narrow review visible');
  assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),'no page overflow');
  await shot('turn-findings-narrow-dark');
  assert.deepEqual(errors,[]);
  await service.close();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,modelCalls,requests,errors},null,2));
  console.log('PASS code review UI: both entries, evidence location, preserved draft, ignore/restore, stop, failure and narrow dark layout. '+out);
  clearTimeout(timer);app.exit(0);
 }catch(error){console.error(error.stack);await shot('failure').catch(()=>{});clearTimeout(timer);app.exit(1);}
});
