// Production renderer/preload with isolated stuck-native fixtures. No user processes.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=path.resolve('.runtime/stop-recovery-'+Date.now());fs.mkdirSync(out,{recursive:true});
require('./desktop-log.cjs').installDesktopLog(out);
app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let win,releaseForce;const calls=[],errors=[],ids=['stuck','peer'],ended=new Set();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const emit=(id,type,data={})=>win.webContents.send('omp:event',{clientSessionId:id,type,...data});
async function until(code,label,timeout=12000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await js(`Boolean(${code})`))return;await pause(40);}throw Error('Timeout: '+label);}
async function shot(name){await pause(150);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>app.exit(2),60000);
 try{
  const handle=(name,fn)=>ipcMain.handle(name,(_, ...args)=>fn(...args));
  handle('works:list',()=>[{root:'/demo/work',name:'停止恢复验收',kind:'work'}]);
  handle('omp:list',()=>ids.map(id=>({id,root:'/demo/work',agentDir:'/demo/agent',runtime:'wsl',ready:true,busy:true})));
  handle('session:list',()=>({sessions:[],managed:[]}));handle('work:read',()=>'# 隔离验收');handle('work:details',()=>({root:'/demo/work',members:[],assets:[],issues:[],warnings:[]}));handle('work:run',()=>[]);
  handle('pet:context',()=>{});handle('settings:get',()=>({settings:require('../src/client-settings.cjs').defaults()}));handle('feedback:get',()=>({settings:require('../src/feedback/settings.cjs').defaults(),warning:''}));
  handle('omp:request',(type,data,id)=>{
   calls.push({type,id});
   if(type==='get_state')return {sessionName:id==='stuck'?'等待子任务退出':'其他会话继续运行',sessionFile:'/demo/'+id+'.jsonl',isSettled:ended.has(id)};
   if(type==='get_messages')return {messages:[]};
   if(type==='abort_and_restore_queue')return {followUp:[{text:'QUEUE-KEEP：待处理消息'}]};
   return {};
  });
  handle('omp:terminate',id=>{calls.push({type:'terminate',id});return new Promise(resolve=>releaseForce=()=>{ended.add(id);emit(id,'process_exit',{code:137,stopped:true});setTimeout(resolve,100);});});
  win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{preload:path.resolve('src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await win.loadFile(path.resolve('dist/renderer/index.html'));
  await until('document.querySelectorAll(".open-session").length===2','two owned sessions');
  await click('.work-row');await click('.session-select[data-session="stuck"]');
  emit('stuck','message_end',{messageId:'answer',message:{role:'assistant',content:[{type:'text',text:'后台子任务仍在运行，等待停止确认。'}]}});
  await until('document.querySelector("button[aria-label=停止生成]")','stop control');
  await js('document.querySelector("#message-input").focus()');await win.webContents.insertText('DRAFT-KEEP：尚未发送的草稿');
  await click('button[aria-label="停止生成"]');
  await until('document.querySelector("#message-input").value.includes("QUEUE-KEEP")','native queue restoration');
  assert.ok(await js('document.querySelector("#message-input").value.includes("DRAFT-KEEP")'));
  assert.equal(await js('!![...document.querySelectorAll("button")].find(b=>b.textContent==="强制停止本会话")'),false);
  await until('[...document.querySelectorAll("button")].some(b=>b.textContent==="强制停止本会话")','force recovery after deadline',22000);
  assert.equal(calls.filter(c=>c.type==='abort_and_restore_queue').length,1,'read polling never replays cancellation');
  assert.ok(await js('document.querySelector("#run-status").textContent.includes("正在停止")'));
  await shot('stalled-blue');
  await click('button[aria-label="切换深色外观"]');win.setSize(760,760);await pause(200);
  assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
  await shot('stalled-narrow-dark');
  await click('button[aria-label="打开活跃会话"]');
  await until('document.querySelectorAll(".monitor-session").length===2','monitor retains both sessions');
  assert.ok(await js('document.querySelector("[data-monitor-session=stuck] .monitor-actions").textContent.includes("强制停止")'));
  await click('[data-monitor-session="stuck"] .monitor-actions button:last-child');
  await until('document.querySelector("[data-monitor-session=stuck] .monitor-status").textContent.includes("结束连接")','wait for actual exit');
  assert.deepEqual(calls.filter(c=>c.type==='terminate').map(c=>c.id),['stuck']);
  releaseForce();
  await until('document.querySelectorAll(".monitor-session").length===1','stopped writer disconnected');
  assert.equal(await js('document.querySelector(".monitor-session").dataset.monitorSession'),'peer');
  await click('button[aria-label="打开工作台"]');await click('.session-select[data-session="stuck"]');
  await until('document.querySelector("#run-status").textContent.includes("已停止")','aborted outcome');
  assert.ok(await js('document.querySelector("#message-input").value.includes("DRAFT-KEEP")&&document.querySelector("#message-input").value.includes("QUEUE-KEEP")'));
  assert.equal(await js('document.querySelector("button[aria-label=发送消息]").disabled'),false);
  assert.deepEqual(errors,[]);await shot('stopped-draft-retained');
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,calls,errors},null,2));
  console.log('PASS stop timeout recovery, monitor force action, actual-exit wait, peer isolation and retained draft/queue. '+out);
  clearTimeout(timer);app.exit(0);
 }catch(error){console.error(error.stack);await shot('failure').catch(()=>{});clearTimeout(timer);app.exit(1);}
});
