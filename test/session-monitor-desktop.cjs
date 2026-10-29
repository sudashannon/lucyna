// Production renderer + preload; isolated native-event fixtures, no user sessions.
const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=path.resolve('.runtime/session-monitor-'+Date.now());fs.mkdirSync(out,{recursive:true});require('./desktop-log.cjs').installDesktopLog(out);
app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let win;const errors=[],calls=[],checks=[],ids=['older','newer','stopped','failed','running','selected'],settled=new Set(),messages=new Map();
const titles={older:'构建结果 · 较早完成',newer:'测试结果 · 最近完成',stopped:'用户停止',failed:'请求失败',running:'后台长任务',selected:'当前选中但正在查看列表'};
const pause=ms=>new Promise(r=>setTimeout(r,ms)),js=code=>win.webContents.executeJavaScript(code,true),emit=(id,type,data={})=>win.webContents.send('omp:event',{clientSessionId:id,type,...data});
async function until(code,label){const end=Date.now()+12000;while(Date.now()<end){if(await js(`Boolean(${code})`))return;await pause(40);}throw Error('Timeout: '+label);}
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function input(selector,value){await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(80);}
async function finish(id,status='completed',deferred=false){
 const message={id:id+'-answer',role:'assistant',content:[{type:'text',text:titles[id]+'：结果摘要，用于未读列表验收。'}]};messages.set(id,[message]);emit(id,'message_end',{message});
 if(!deferred)settled.add(id);emit(id,'prompt_result',{status,sessionSettled:!deferred,...(status==='error'?{error:{message:'测试错误'}}:{})});await pause(100);
}
async function shot(name){await pause(180);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{const timer=setTimeout(()=>app.exit(2),90000);try{
 const handle=(name,fn)=>ipcMain.handle(name,(_, ...args)=>fn(...args));
 handle('works:list',()=>[{root:'/demo/work',name:'未读结果验收',kind:'work'}]);handle('omp:list',()=>ids.map(id=>({id,root:'/demo/work',agentDir:'/demo/agent',runtime:'wsl',ready:true,busy:true})));
 handle('session:list',()=>({sessions:[],managed:[]}));handle('work:read',()=>'# 隔离测试');handle('work:details',()=>({root:'/demo/work',name:'隔离测试',content:'# 隔离测试',issues:[],warnings:[],members:[],assets:[]}));handle('work:run',()=>[]);
 handle('pet:context',()=>{});handle('settings:get',()=>({settings:require('../src/client-settings.cjs').defaults()}));handle('feedback:get',()=>({settings:require('../src/feedback/settings.cjs').defaults(),warning:''}));
 handle('omp:close',id=>{calls.push({type:'close',id});emit(id,'process_exit',{code:0});});
 handle('omp:request',(type,data,id)=>{calls.push({type,id});if(type==='get_state')return {sessionName:titles[id],sessionFile:'/demo/'+id+'.jsonl',isSettled:settled.has(id)};if(type==='get_messages')return{messages:messages.get(id)||[]};if(type==='abort_and_restore_queue'){settled.add(id);emit(id,'prompt_result',{status:'aborted'});return{followUp:[],steering:[]};}return{};});
 win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{preload:path.resolve('src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 await win.loadFile(path.resolve('dist/renderer/index.html'));await until('document.querySelectorAll(".open-session").length===6','reattach all six connections');
 // Offscreen fixtures emulate focus explicitly; no activation of the user's desktop.
 await js('document.hasFocus=()=>true;window.dispatchEvent(new Event("focus"))');await click('.work-row');await until('document.querySelector(".breadcrumb").textContent.includes("未读结果验收")','work');
 await input('#message-input','未发送草稿，保持原样');await click('button[aria-label="打开活跃会话"]');await until('document.querySelectorAll(".monitor-session").length===6','monitor');
 await click('#monitor-tab-completedUnread');await until('document.querySelector(".monitor-empty h2").textContent.includes("没有已完成未读")','initial empty state');
 await finish('older');await finish('newer');await finish('stopped','aborted');await finish('failed','error');await finish('selected','completed',true);
 await until('document.querySelector("#monitor-tab-completedUnread span").textContent==="2"','only settled successes');
 settled.add('selected');emit('selected','session_settled');await until('document.querySelector("#monitor-tab-completedUnread span").textContent==="3"','selected conversation completes while monitor visible');
 assert.deepEqual(await js('[...document.querySelectorAll(".monitor-session")].map(el=>el.dataset.monitorSession)'),['selected','newer','older']);
 checks.push('Native settlement, newest-first order and exact counts exclude running, stopped and failed tasks. Selected chat completion remains unread while monitor is visible.');
 await input('input[aria-label="搜索活跃会话"]','最近完成');assert.equal(await js('document.querySelectorAll(".monitor-session").length'),1);assert.equal(await js('document.querySelector("#monitor-tab-completedUnread span").textContent'),'3');
 await input('input[aria-label="搜索活跃会话"]','not-found');assert.ok(await js('document.querySelector(".monitor-empty").textContent.includes("没有匹配")'));await input('input[aria-label="搜索活跃会话"]','');
 await click('#monitor-tab-running');assert.deepEqual(await js('[...document.querySelectorAll(".monitor-session")].map(el=>el.dataset.monitorSession)'),['running']);await click('#monitor-tab-completedUnread');
 await shot('completed-unread');
 await click('[data-monitor-session="selected"] .monitor-actions button');await until('document.querySelector(".session-monitor").hidden','open result');assert.equal(await js('document.querySelector("#message-input").value'),'未发送草稿，保持原样');
 await click('button[aria-label="打开活跃会话"]');await until('document.querySelector("#monitor-tab-completedUnread span").textContent==="2"','one read result removed');
 assert.equal(await js('document.querySelector("#monitor-tab-completedUnread").getAttribute("aria-selected")'),'true');
 checks.push('Searching and changing filters preserve unread; opening a result clears only that result and preserves its draft.');
 // A foreground chat becomes unread when it finishes while the window is blurred.
 await click('button[aria-label="打开工作台"]');settled.delete('selected');emit('selected','agent_start');await pause(80);await js('document.hasFocus=()=>false;window.dispatchEvent(new Event("blur"))');await finish('selected');
 await click('button[aria-label="打开活跃会话"]');await js('document.hasFocus=()=>true;window.dispatchEvent(new Event("focus"))');await until('document.querySelector("#monitor-tab-completedUnread span").textContent==="3"','blurred result stays unread on monitor focus');
 await click('[data-monitor-session="selected"] .monitor-session-heading button');await click('button[aria-label="打开活跃会话"]');await until('document.querySelector("#monitor-tab-completedUnread span").textContent==="2"','open after focus marks read');
 checks.push('Window blur preserves unread; returning focus to the monitor does not consume results.');
 // Keyboard tabs and narrow layout remain usable.
 await js('document.querySelector("#monitor-tab-completedUnread").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');await until('document.querySelector("#monitor-tab-attention").getAttribute("aria-selected")==="true"','keyboard tab');
 await click('#monitor-tab-completedUnread');await click('button[aria-label="切换深色外观"]');win.setSize(760,760);await pause(200);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));await shot('completed-unread-narrow-dark');
 // Existing stop stays scoped to the one running native connection.
 await click('#monitor-tab-running');await js('[...document.querySelectorAll(".monitor-actions button")].find(el=>el.textContent==="停止").click()');await until('document.querySelector("#monitor-tab-running span").textContent==="0"','scoped stop');
 assert.deepEqual(calls.filter(c=>c.type==='abort_and_restore_queue'),[{type:'abort_and_restore_queue',id:'running'}]);assert.equal(calls.filter(c=>c.type==='close').length,0);
 await click('#monitor-tab-completedUnread');assert.equal(await js('document.querySelector("#monitor-tab-completedUnread span").textContent'),'2');
 for(const id of ['newer','older']){await click(`[data-monitor-session="${id}"] .monitor-actions button`);await click('button[aria-label="打开活跃会话"]');}
 await until('document.querySelector(".monitor-empty h2").textContent.includes("没有已完成未读")','read all');
 checks.push('Keyboard, narrow/dark layout and empty state work; stop affects only the selected task and no connection closes.');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks},null,2));console.log(JSON.stringify({passed:true,out,checks}));clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:e.stack,errors,checks},null,2));console.log(out);clearTimeout(timer);app.exit(1);}});
