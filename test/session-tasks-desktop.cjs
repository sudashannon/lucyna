const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=path.resolve('.runtime/session-tasks-review');fs.mkdirSync(out,{recursive:true});
app.setPath('userData',path.join(out,'profile-'+Date.now()));app.disableHardwareAcceleration();
require('./desktop-log.cjs').installDesktopLog(out);
let win;const errors=[],calls=[],startedAt=Date.now()-26300;
const agents=[{id:'review',agent:'CI 定向复审',description:'核对 SELinux CI 门禁',parentToolCallId:'task-1',sessionFile:'/tmp/review.jsonl',status:'running',progress:{id:'review',status:'running',durationMs:26300,currentTool:'bash',currentToolArgs:'ctest --output-on-failure -R selinux',currentToolIntent:'检查失败测试的运行环境',recentOutput:['[12/18] selinux_policy_test passed','[13/18] checking build configuration…']}},{id:'trace',agent:'日志分析',description:'分析板测失败日志',parentToolCallId:'task-1',sessionFile:'/tmp/trace.jsonl',status:'running',progress:{id:'trace',status:'running',recentOutput:['已定位失败任务，正在核对日志时间。']}}];
const jobs=[{id:'build',kind:'job',title:'编译 SELinux 策略',startedAt,status:'running',cancellable:true,command:'make -C buildroot selinux-policy',cwd:'/home/demo/work/buildroot',output:'[ 62%] Compiling policy modules\n[ 63%] Checking policy dependencies',detail:''}];
const pause=ms=>new Promise(r=>setTimeout(r,ms)),js=code=>win.webContents.executeJavaScript(code,true);
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const taskNode=key=>`document.querySelector(${JSON.stringify(`[data-task="${key}"]`)})`;
const emit=(type,data={})=>win.webContents.send('omp:event',{clientSessionId:'fixture',type,...data});
async function until(code,label){const end=Date.now()+12000;while(Date.now()<end){if(await js(`Boolean(${code})`))return;await pause(40);}throw Error('Timeout '+label);}
async function shot(name){await pause(200);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{const timeout=setTimeout(()=>app.exit(2),60000);try{
 const handle=(name,fn)=>ipcMain.handle(name,(_, ...args)=>fn(...args));
 handle('works:list',()=>[{root:'/demo/work',name:'SELinux 工作区',kind:'work'}]);handle('omp:list',()=>[{id:'fixture',root:'/demo/work',agentDir:'/tmp/agent',runtime:'wsl',ready:true,busy:true}]);
 handle('session:list',()=>({sessions:[],managed:[]}));handle('work:read',()=>'# Tasks');handle('work:details',()=>({root:'/demo/work',members:[],assets:[],issues:[],warnings:[]}));handle('work:run',()=>[]);handle('pet:context',()=>{});
 handle('settings:get',()=>({settings:require('../src/client-settings.cjs').defaults()}));handle('feedback:get',()=>({settings:require('../src/feedback/settings.cjs').defaults(),warning:''}));
 handle('omp:request',(type,data,id)=>{calls.push({type,data,id});if(type==='get_state')return {sessionName:'构建与并行检查',sessionFile:'/tmp/main.jsonl',isSettled:false};if(type==='get_messages')return {messages:[]};if(type==='get_subagents')return {subagents:agents};if(type==='get_background_tasks')return {tasks:jobs};if(type==='get_background_task_output')return {output:jobs[0].output};if(type==='get_subagent_messages')return {nextByte:120,messages:[{role:'toolResult',content:[{type:'text',text:'子代理独立记录：测试环境检查完成。'}]}]};if(type==='cancel_subagent')return {accepted:true};return {};});
 win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{preload:path.resolve('src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});await win.loadFile(path.resolve('dist/renderer/index.html'));
 await until('document.querySelector(".open-session")','session');await click('.work-row');await click('.session-select');
 await until('document.querySelectorAll(".session-tasks .session-task").length===3','three native tasks');
 await shot('desktop-blue');
 emit('tool_execution_start',{toolCallId:'task-1',toolName:'task',intent:'并行检查构建与板测',args:{}});
 await until('document.querySelectorAll(".activity-rows .session-task").length===2','children anchored to parent tool');
 await shot('inline-blue');
 await click('[data-task="agent:review:task-1"] .session-task-title');await until(`${taskNode('agent:review:task-1')}.textContent.includes("子代理独立记录")`,'isolated transcript');
 await click('button[aria-label="停止 核对 SELinux CI 门禁"]');await until(`${taskNode('agent:review:task-1')}.dataset.status==="stopping"`,'stop pending');
 assert.deepEqual(calls.filter(c=>c.type==='cancel_subagent').map(c=>[c.id,c.data.subagentId]),[['fixture','review']]);
 assert.equal(await js(`${taskNode('agent:trace:task-1')}.dataset.status`),'running');
 emit('subagent_lifecycle',{payload:{...agents.shift(),status:'aborted'}});await until('document.querySelector(".session-tasks summary")','retained terminal task');
 emit('remote_disconnected',{paused:true});await until(`${taskNode('job:build')}.querySelector('.session-task-stop').disabled`,'disconnected stop disabled');await shot('disconnected');
 emit('remote_reconnected');await until(`!${taskNode('job:build')}.querySelector('.session-task-stop').disabled`,'snapshot reconnected');
 await click('button[aria-label="切换深色外观"]');win.setSize(760,900);await pause(150);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));await shot('narrow-dark');
 await click('button[aria-label="打开活跃会话"]');await until('document.querySelector(".monitor-meta").textContent.includes("子任务运行中")','monitor task count');await shot('monitor');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,calls,errors},null,2));console.log('PASS task cards, output, isolated cancel, disconnect/reconnect, monitor, narrow dark. '+out);clearTimeout(timeout);app.exit(0);
 }catch(e){console.error(e.stack);fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({calls,errors},null,2));await shot('failure').catch(()=>{});clearTimeout(timeout);app.exit(1);}});
