// Production renderer + real client recycle bin, isolated synthetic journals.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {windowOptions,installWindowChrome}=require('../src/window-chrome.cjs');
const {applicationIcon}=require('../src/app-icon.cjs');
const {HistoryTrash}=require('../src/history-trash.cjs');
const {planDeletion,publicPlan}=require('../src/history-deletion.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let win,folder,trash,finishImport;const errors=[],calls=[],connections=new Map();
const out=path.resolve('.runtime/experience');
require('../test/desktop-log.cjs').installDesktopLog(out);
const roots=['/demo/work-a','/demo/work-b'];let original;
folder=require('node:fs').mkdtempSync(path.join(os.tmpdir(),'lucyna-experience-'));require('../src/app-identity.cjs').configureAppIdentity(app,{LUCYNA_USERDATA:path.join(folder,'profile')});
const js=code=>win.webContents.executeJavaScript(code);
const emit=(id,type,data={})=>win.webContents.send('test:event',{clientSessionId:id,type,...data});
async function input(selector,text){await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(70);}

async function until(code){const end=Date.now()+12000;while(Date.now()<end){if(await js(`Boolean(${code})`))return;await pause(50);}throw Error('Timeout '+code);}
async function click(selector){await js(`document.querySelector(${JSON.stringify(selector)}).click()`);}
async function button(text){await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);}
app.whenReady().then(async()=>{
 let preview=false;const timer=setTimeout(()=>app.exit(2),60000);
 try{
  await fs.mkdir(out,{recursive:true});trash=new HistoryTrash(folder);original=path.join(folder,'original.jsonl');await fs.writeFile(original,'{"type":"session","id":"synthetic","cwd":"/demo/work-a"}\n');
  const memo=path.join(folder,'SESSION-syntheti.md');await fs.writeFile(memo,'private Work memo');
  const entry={path:original,title:'大历史 · 2000 条',id:'large',runtime:'wsl'};
  const document={id:'demo-knowledge',title:'演示：Lucyna 知识库',path:'lucyna.md',workspace:'演示知识库',type:'knowledge'};
  const handlers={knowledge:(kind)=>{if(kind==='catalog')return{documents:[document],workspaces:[{alias:'演示知识库',path:'/demo/knowledge'}],fetchedAt:new Date().toISOString()};if(kind==='document')return{component:document,content:'# 演示：Lucyna 知识库\n\n这是隔离验收窗口的演示文档。真实客户端通过 Stele 读取你的知识库。',forward:[],backlinks:[]};return[];},works:()=>roots.map((root,i)=>({root,name:'work-'+(i?'b':'a'),kind:'gitless'})),history:async root=>{const deleted=await trash.list(root);return{sessions:root===roots[0]&&!deleted.length?[entry]:[],managed:[],trash:deleted};},
   'delete-preview':async(source,root)=>publicPlan(await planDeletion({source,root,workPath:folder,entry,catalog:[entry]})),
   delete:async(source,root,token)=>{const plan=await planDeletion({source,root,workPath:folder,entry,catalog:[entry]});assert.equal(plan.token,token);return trash.move(plan);},restore:(root,key)=>trash.restore(root,key),
   import:()=>new Promise(resolve=>{finishImport=()=>resolve({sessionFile:original,agentDir:folder,runtime:'wsl'});}),
   start:options=>{calls.push({type:'start',id:options.clientSessionId});connections.set(options.clientSessionId,options);setTimeout(()=>win.webContents.send('test:event',{type:'ready',clientSessionId:options.clientSessionId}),30);return{runtime:'wsl',agentDir:folder};},
   request:(type,data,id)=>{calls.push({type,id});if(type==='prompt'){emit(id,'agent_start');return{};}if(type==='abort_and_restore_queue'){emit(id,'prompt_result',{status:'aborted'});emit(id,'queue_update',{followUp:[],steering:[]});return{followUp:[{text:'恢复 A 的排队消息',images:[{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='}]}]};}if(type==='get_state')return{sessionFile:connections.get(id).resume?original:path.join(folder,id+'.jsonl'),sessionName:connections.get(id).resume?'大历史 · 2000 条':'并行任务 B',model:{name:'Fixture'},isSettled:true};if(type==='get_messages')return{messages:connections.get(id).resume?Array.from({length:2000},(_,i)=>({id:'message-'+i,role:i%2?'assistant':'user',content:'历史记录 '+i+' · 仅用于界面验收。'})):[]};return{};},close:id=>{calls.push({type:'close',id});connections.delete(id);win.webContents.send('test:event',{type:'process_exit',clientSessionId:id,code:0});}};
  for(const [name,fn]of Object.entries(handlers))ipcMain.handle('test:'+name,(_, ...args)=>fn(...args));
  win=new BrowserWindow({width:1350,height:900,show:false,icon:applicationIcon,title:'Lucyna · 功能验收预览（演示数据）',...windowOptions(),useContentSize:true,webPreferences:{preload:path.join(__dirname,'experience-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:!process.argv.includes('--preview'),backgroundThrottling:false,additionalArguments:['--lucyna-titlebar']}});
  installWindowChrome(win);win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await win.loadFile(path.resolve(__dirname,'../dist/renderer/index.html'));await until('document.querySelectorAll(".work-row").length===2');
  await click('.work-row');await until('document.querySelectorAll(".sidebar .open-session").length===1');await click('.work-group:nth-child(2) .work-row');await until('document.querySelectorAll(".sidebar .open-session").length===1');
  await click('.work-row');await button('会话');await until('document.querySelector(".history-delete")');
  await click('.history-delete');await button('取消');assert.equal((await trash.list(roots[0])).length,0);
  await click('.history-delete');await until('document.querySelectorAll(".history-delete-files li").length===2');win.webContents.invalidate();await pause(500);await fs.writeFile(path.join(out,'history-delete.png'),(await win.webContents.capturePage()).toPNG());await button('移到回收站');await until('document.querySelector(".trash-link")');assert.equal((await trash.list(roots[0])).length,1);
  await assert.rejects(fs.stat(original),{code:'ENOENT'});await assert.rejects(fs.stat(memo),{code:'ENOENT'});
  await click('.trash-link');await button('恢复');await until('document.querySelector(".history-trash-list").textContent.includes("回收站为空")');await click('button[aria-label="关闭弹窗"]');await until('document.querySelector(".history-row")');
  assert.equal(await fs.readFile(original,'utf8'),'{"type":"session","id":"synthetic","cwd":"/demo/work-a"}\n');assert.equal(await fs.readFile(memo,'utf8'),'private Work memo');
  await click('.history-row');await until('document.querySelector(".connection-progress")?.textContent.includes("创建历史副本")');
  await click('.work-group:nth-child(2) .work-row');await until('document.querySelector(".breadcrumb").textContent.includes("work-b")');
  assert.ok(finishImport);finishImport();await until('document.querySelectorAll(".sidebar .session-row-label small")[0].textContent.includes("已连接")');assert.ok((await js('document.querySelector(".breadcrumb").textContent')).includes('work-b'));
  await click('.work-row');await until('document.querySelectorAll(".message").length===80');assert.ok((await js('document.querySelector(".load-earlier").textContent')).includes('1920'));
  await js('document.querySelector(".transcript").scrollTop=300');await pause(100);const before=await js('({height:document.querySelector(".transcript").scrollHeight,top:document.querySelector(".transcript").scrollTop})');
  await click('.load-earlier');await until('document.querySelectorAll(".message").length===160');const after=await js('({height:document.querySelector(".transcript").scrollHeight,top:document.querySelector(".transcript").scrollTop})');assert.ok(Math.abs((after.top-before.top)-(after.height-before.height))<3,'earlier history preserves reading position');
  await click('.work-group:nth-child(2) .work-row');await click('.work-row');await until('document.querySelectorAll(".message").length===160');assert.equal(calls.filter(c=>c.type==='close').length,0);
  // Jumping across a huge history renders only a bounded neighborhood.
  await click('button[aria-label="收起工具面板"]');await pause(100);
  assert.ok(await js('document.querySelector(".timeline-outline").getBoundingClientRect().width>190'),'wide timeline is always visible');
  assert.equal(await js('!!document.querySelector(".timeline-toggle,.timeline-popover")'),false,'no open/close floating timeline');
  await click('.timeline-marker');await until('document.querySelectorAll(".message").length===80');assert.ok((await js('document.querySelector(".message").textContent')).includes('历史记录 0'));
  const reading=await js('document.querySelector(".transcript").scrollTop');await click('button[aria-label="打开活跃会话"]');await until('!document.querySelector(".session-monitor").hidden');assert.equal(await js('document.querySelectorAll(".monitor-session").length'),1);
  await click('button[aria-label="打开工作台"]');await pause(100);assert.ok(Math.abs(await js('document.querySelector(".transcript").scrollTop')-reading)<3);
  await input('input[aria-label="搜索会话时间轴"]','历史记录 1000');await click('.timeline-entry');await until('document.querySelector(".timeline-target")?.textContent.includes("历史记录 1000")');assert.equal(await js('document.querySelectorAll(".message").length'),80);
  assert.ok(await js('(()=>{const a=document.querySelector(".timeline-target").getBoundingClientRect(),b=document.querySelector(".transcript").getBoundingClientRect();return a.top>=b.top&&a.top<b.bottom})()'));
  assert.ok(await js('document.querySelector(".timeline-outline").getBoundingClientRect().width>190'),'jump does not close timeline');
  await input('input[aria-label="搜索会话时间轴"]','');
  await until('document.querySelector(".timeline-entry[aria-current=location]")');
  const activeBefore=await js('document.querySelector(".timeline-marker[aria-current=location]").getAttribute("aria-label")');
  await js('document.querySelector(".transcript").scrollTop+=700');
  await until('document.querySelector(".timeline-marker[aria-current=location]").getAttribute("aria-label")!=='+JSON.stringify(activeBefore));
  assert.ok(await js('(()=>{const a=document.querySelector(".transcript").getBoundingClientRect(),b=document.querySelector(".conversation-timeline").getBoundingClientRect();return a.right<=b.left+1})()'),'outline never covers transcript');
  const beforeResize=await js('document.querySelector(".timeline-marker[aria-current=location]").getAttribute("aria-label")');
  win.setContentSize(960,700);await pause(250);
  assert.equal(await js('document.querySelector(".timeline-marker[aria-current=location]").getAttribute("aria-label")'),beforeResize,'responsive outline keeps the same reading passage');
  assert.equal(await js('getComputedStyle(document.querySelector(".timeline-outline")).display'),'none');
  assert.ok(await js('document.querySelector(".conversation-timeline").getBoundingClientRect().width<=40'));
  await js('document.querySelector(".timeline-marker.selected").focus()');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Home'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Home'});
  assert.ok(await js('document.activeElement===document.querySelector(".timeline-marker")'),'compact rail supports keyboard navigation');
  win.webContents.invalidate();await pause(250);await fs.writeFile(path.join(out,'timeline-compact.png'),(await win.webContents.capturePage()).toPNG());
  win.setContentSize(375,812);await pause(120);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));win.setContentSize(1350,900);await pause(100);
  await click('.jump-latest');await until('document.querySelectorAll(".message").length===80&&!document.querySelector(".load-later")');
  win.webContents.invalidate();await pause(900);await fs.writeFile(path.join(out,'timeline.png'),(await win.webContents.capturePage()).toPNG());
  const a=[...connections.keys()][0];await input('#message-input','A 保留草稿');emit(a,'agent_start');emit(a,'tool_execution_start',{toolCallId:'failed-tool',toolName:'read',args:{path:'missing.md'}});emit(a,'tool_execution_end',{toolCallId:'failed-tool',isError:true,result:{content:[{type:'text',text:'Fixture: file not found'}]}});emit(a,'queue_update',{followUp:['恢复 A 的排队消息'],steering:[]});
  await click('.work-group:nth-child(2) .work-row');await input('#message-input','开始并行任务 B');await js('document.querySelector(".composer").requestSubmit()');await until('document.querySelector(".composer-footnote").textContent.includes("OMP")');await pause(300);assert.equal(connections.size,2);const b=[...connections.keys()][1];
  await input('#message-input','B 保留草稿');await click('button[aria-label="打开活跃会话"]');await until('document.querySelectorAll(".monitor-session").length===2');assert.equal(await js('document.querySelectorAll(".monitor-state.running").length'),2);
  win.webContents.invalidate();await pause(900);await fs.writeFile(path.join(out,'monitor.png'),(await win.webContents.capturePage()).toPNG());
  await js(`Array.from(document.querySelector('[data-monitor-session="${a}"]').querySelectorAll('button')).find(b=>b.textContent.trim()==='停止').click()`);await until('document.querySelectorAll(".monitor-state.running").length===1');assert.deepEqual(calls.filter(c=>c.type==='abort_and_restore_queue').map(c=>c.id),[a]);
  await click('button[aria-label="打开工作台"]');assert.equal(await js('document.querySelector("#message-input").value'),'B 保留草稿');assert.equal(await js('document.querySelectorAll(".composer-attachments img").length'),0);
  await click('.work-row');await until('document.querySelector("#message-input").value.includes("恢复 A 的排队消息")');assert.ok((await js('document.querySelector("#message-input").value')).includes('A 保留草稿'));assert.equal(await js('document.querySelectorAll(".composer-attachments img").length'),1);await click('.timeline-marker.failure');await until('document.querySelector(".tool-row.timeline-target.failed")');assert.ok(await js('document.querySelector(".activity-group-heading").getAttribute("aria-expanded")==="true"'));
  await click('button[aria-label="打开活跃会话"]');emit(b,'extension_ui_request',{method:'confirm',id:'question-b',title:'继续任务 B？'});await until('document.querySelector(".monitor-state.attention")');assert.ok(await js('!document.querySelector("[role=dialog]")'),'background question does not cover monitor');
  await js(`document.querySelector('[data-monitor-session="${b}"] .monitor-actions button').click()`);await until('document.querySelector("[role=dialog]")');emit(b,'question_resolved',{id:'question-b'});await until('!document.querySelector("[role=dialog]")');assert.equal(await js('document.querySelector("#message-input").value'),'B 保留草稿');
  await click('button[aria-label="打开活跃会话"]');await js(`document.querySelector('[data-monitor-session="${a}"] button[aria-label^="结束连接"]').click()`);await until('document.querySelectorAll(".monitor-session").length===1');assert.equal(connections.size,1);assert.ok(connections.has(b));assert.deepEqual(calls.filter(c=>c.type==='close').map(c=>c.id),[a]);
  win.setContentSize(960,700);await pause(100);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));await click('button[aria-label="切换深色外观"]');await pause(50);assert.ok(await js('!document.querySelector(".session-monitor").hidden'));
  win.webContents.invalidate();await pause(900);await fs.writeFile(path.join(out,'monitor-narrow-dark.png'),(await win.webContents.capturePage()).toPNG());
  await click('button[aria-label="收起侧栏 · Ctrl B"]');await click('button[aria-label="打开知识库"]');await until('document.querySelector(".knowledge-row")');await click('.knowledge-row');await until('document.querySelector(".knowledge-reader").textContent.includes("隔离验收窗口")');assert.ok(await js('!!document.querySelector(".demo-banner")'));assert.ok(await js('!document.querySelector(".knowledge-screen>.knowledge-alert")'));
  async function railGeometry(){return js('(()=>{const buttons=Array.from(document.querySelectorAll(".primary-switcher button"));return buttons.map(button=>{const b=button.getBoundingClientRect(),i=button.querySelector("svg").getBoundingClientRect();return{width:b.width,height:b.height,center:Math.abs(b.left+b.width/2-i.left-i.width/2),top:b.top,bottom:b.bottom}})})()');}
  let rail=await railGeometry();for(const b of rail){assert.ok(b.width>=36&&b.height>=36);assert.ok(b.center<1);}assert.ok(rail[1].top-rail[0].bottom>=7);win.webContents.invalidate();await pause(500);await fs.writeFile(path.join(out,'rail-dark.png'),(await win.webContents.capturePage()).toPNG());
  await click('button[aria-label="展开侧栏 · Ctrl B"]');win.setContentSize(375,812);await pause(150);rail=await railGeometry();for(const b of rail){assert.ok(b.width>=36&&b.height>=36);assert.ok(b.center<1);}assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));win.setContentSize(960,700);await click('button[aria-label="打开活跃会话"]');
  assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['empty session cleanup','delete cancellation','recycle bin delete/restore with original unchanged','visible slow import','switch during import without focus stealing','2000-message history initially renders 80','load earlier preserves scroll','switch retains history window','timeline jumps render at most 80 messages','timeline search and reading position','failed tool jump expands collapsed activity','parallel monitor opens native questions without global blockage','background stop restores only owner text and images','close leaves peer task running','960px dark monitor','demo knowledge catalog and detail','36px rail targets and centered count badge at 960px/375px'],profile:folder}));
  if(process.argv.includes('--preview')){preview=true;win.setContentSize(1350,900);await click('button[aria-label="切换浅色外观"]');win.setTitle('Lucyna · 功能验收预览（演示数据）');win.show();win.focus();}
 }catch(error){console.error(error.stack);console.error(errors);process.exitCode=1;}finally{clearTimeout(timer);if(!preview)app.exit(process.exitCode||0);}
});
