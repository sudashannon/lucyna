// Two separate Electron processes, one isolated profile, production UI/preload.
// Native RPC is a deterministic fixture; no user sessions or model calls.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
if(!process.versions.electron){
 const {spawnSync}=require('node:child_process'),out=path.resolve('.runtime/session-restore-'+Date.now());fs.mkdirSync(out,{recursive:true});
 for(const phase of ['create','restore']){
  const result=spawnSync(require('electron'),[__filename,'--phase='+phase,'--output='+out],{stdio:'inherit',timeout:90000,windowsHide:true});
  if(result.error||result.status!==0){console.error(result.error||'Failed phase '+phase,out);process.exit(result.status||1);}
 }
 console.log(JSON.stringify({passed:true,out,checks:['Full process exit and restart restores three connections across two works','Manually ended connection stays idle','Original selection, text/image/long-text drafts and completed-unread survive','Queued restore remains interactive; no prompt is replayed']}));
}else{
 const {app,BrowserWindow,ipcMain}=require('electron'),phase=process.argv.find(a=>a.startsWith('--phase=')).slice(8),out=process.argv.find(a=>a.startsWith('--output=')).slice(9);
 require('./desktop-log.cjs').installDesktopLog(path.join(out,phase));app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
 const manifest=path.join(out,'fixture.json'),data=phase==='restore'?JSON.parse(fs.readFileSync(manifest,'utf8')):{journals:{},ids:{}},calls=[],errors=[],connections=new Map();let win;
 const pause=ms=>new Promise(r=>setTimeout(r,ms)),js=code=>win.webContents.executeJavaScript(code,true),emit=(id,type,extra={})=>win.webContents.send('omp:event',{type,clientSessionId:id,...extra});
 async function until(code,label){const end=Date.now()+20000;while(Date.now()<end){if(await js(`Boolean(${code})`))return;await pause(40);}throw Error('Timeout: '+label);}
 const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
 async function input(text){await js(`(()=>{const el=document.querySelector('#message-input');Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(80);}
 const stored=()=>js(`JSON.parse(localStorage.getItem('omp.openSessions.v1'))`);
 const drafts=()=>js(`new Promise((resolve,reject)=>{const r=indexedDB.open('omp.composer.v1',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('drafts'),s=tx.objectStore('drafts'),keys=s.getAllKeys(),values=s.getAll();tx.oncomplete=()=>{db.close();resolve(Object.fromEntries(keys.result.map((key,i)=>[key,values.result[i]])))};tx.onerror=()=>reject(tx.error);};})`);
 async function complete(id,text){const j=data.journals[id],message={id:id+'-answer-'+j.messages.length,role:'assistant',content:[{type:'text',text}]};j.messages.push(message);emit(id,'message_end',{message});emit(id,'prompt_result',{status:'completed',sessionSettled:true});await pause(100);}
 async function send(label){await input(label);await click('button[aria-label="发送消息"]');await until(`document.querySelector('.composer-footnote').textContent.includes('会话已连接')&&document.querySelector('.message-column')?.textContent.includes(${JSON.stringify(label+' 已完成')})`,'prompt settles');const id=await js('document.querySelector(".app-shell").dataset.sessionId');data.ids[label]=id;return id;}
 app.whenReady().then(async()=>{const timer=setTimeout(()=>app.exit(2),75000);try{
  const handle=(name,fn)=>ipcMain.handle(name,(_, ...args)=>fn(...args));
  handle('works:list',()=>['a','b'].map(name=>({root:'/demo/'+name,name:'恢复验收 '+name,kind:'work'})));handle('omp:list',()=>[]);
  handle('session:list',()=>({sessions:[],managed:[]}));handle('work:read',()=>'# 隔离测试');handle('work:details',root=>({root,name:'恢复验收',content:'# 隔离测试',issues:[],warnings:[],members:[],assets:[]}));handle('work:run',()=>[]);
  handle('pet:context',()=>{});handle('settings:get',()=>({settings:require('../src/client-settings.cjs').defaults()}));handle('feedback:get',()=>({settings:require('../src/feedback/settings.cjs').defaults(),warning:''}));
  handle('omp:start',options=>{calls.push({type:'start',...options});const id=options.clientSessionId;
   if(options.resume){assert.equal(options.resume,data.journals[id]?.file);assert.equal(options.root,data.journals[id]?.root);}else data.journals[id]={file:'/demo/'+id+'.jsonl',root:options.root,name:'',messages:[]};
   connections.set(id,true);setTimeout(()=>emit(id,'ready',{runtime:'wsl'}),phase==='restore'?650:50);return {agentDir:'/demo/agent',runtime:'wsl'};
  });
  handle('omp:close',id=>{calls.push({type:'close',id});connections.delete(id);emit(id,'process_exit',{code:0});});
  handle('omp:request',(type,payload,id)=>{calls.push({type,id});const journal=data.journals[id];
   if(type==='get_state')return {sessionId:id,sessionName:journal.name,sessionFile:journal.file,isSettled:true};
   if(type==='get_messages')return {messages:journal.messages};
   if(type==='prompt'){assert.equal(phase,'create','restart must not submit a prompt');journal.name=payload.message;journal.messages.push({role:'user',content:payload.message});emit(id,'agent_start');setTimeout(()=>void complete(id,payload.message+' 已完成'),50);}
   return {};
  });
  win=new BrowserWindow({show:false,width:1440,height:950,webPreferences:{preload:path.resolve('src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await win.loadFile(path.resolve('dist/renderer/index.html'));await until('document.querySelectorAll(".work-row").length===2','works');await js('document.hasFocus=()=>true;window.dispatchEvent(new Event("focus"))');
  if(phase==='create'){
   await click('.work-row');await until('document.querySelector("#message-input")','composer');const a=await send('验收 A');
   await click('.new-chat');await send('验收 B');await js('document.querySelectorAll(".work-row")[1].click()');const c=await send('验收 C');
   await click('.new-chat');const d=await send('手动断开 D');await click('button[aria-label="打开活跃会话"]');await click('button[aria-label="结束连接 手动断开 D"]');
   await until('document.querySelector("#monitor-tab-connected span").textContent==="3"','manual disconnect');
   await click(`[data-monitor-session="${c}"] .monitor-session-heading button`);await input('重启后保留的正文草稿');
   await js(`(()=>{const transfer=new DataTransfer();transfer.setData('text/plain',${JSON.stringify('附件原文\n'.repeat(120))});document.querySelector('#message-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));})()`);
   await until('document.querySelector(".text-attachments")','long text card');
   // A real clipboard File creates an image draft through the production handler.
   await js(`(async()=>{const blob=new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(new File([blob],'draft.png',{type:'image/png'}));document.querySelector('#message-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));})()`);
   await until('document.querySelector(".composer-attachments img")','image draft');
   emit(a,'agent_start');await complete(a,'后台完成且未读');await pause(300);
   data.before=await stored();data.drafts=await drafts();assert.equal(data.before.activeId,c);assert.equal(data.before.sessions.find(s=>s.id===d).reconnectOnLaunch,false);
   assert.ok(data.before.sessions.find(s=>s.id===a).unread);assert.equal(Object.values(data.drafts).filter(v=>Array.isArray(v)&&v.length).length,2);
   fs.writeFileSync(manifest,JSON.stringify(data,null,2));
  }else{
   const {['验收 A']:a,['验收 C']:c,['手动断开 D']:d}=data.ids;
   await until('new Set([...document.querySelectorAll(".session-select")].map(el=>el.dataset.session)).size===4','all saved tabs');
   assert.equal(await js('document.querySelector(".app-shell").dataset.sessionId'),c);
   await click('button[aria-label="打开活跃会话"]');await until('!document.querySelector(".session-monitor").hidden','switch while reconnecting');
   assert.equal(await js('document.querySelector("#monitor-tab-connected span").textContent'),'3');
   await until('document.querySelectorAll(".monitor-status").length===3&&![...document.querySelectorAll(".monitor-status")].some(el=>/恢复|启动|连接中|正在/.test(el.textContent))','three connections ready');
   assert.equal(calls.filter(c=>c.type==='start').length,3);assert.equal(connections.has(d),false);assert.equal(calls.filter(c=>['prompt','close','abort_and_restore_queue'].includes(c.type)).length,0);
   assert.equal(await js('document.querySelector("#monitor-tab-completedUnread span").textContent'),'1');
   await click('#monitor-tab-completedUnread');assert.equal(await js('document.querySelector(".monitor-session").dataset.monitorSession'),a);
   await click('#monitor-tab-all');assert.equal(await js('document.querySelectorAll(".monitor-session").length'),4);
   await click(`[data-monitor-session="${c}"] .monitor-session-heading button`);await until('document.querySelector("#message-input").value==="重启后保留的正文草稿"','body draft restored');
   assert.ok(await js('!!document.querySelector(".text-attachments")&&!!document.querySelector(".composer-attachments img")'));
   assert.deepEqual(await drafts(),data.drafts);const after=await stored();
   assert.deepEqual(after.sessions.map(s=>[s.id,s.draftKey,s.sessionFile]),data.before.sessions.map(s=>[s.id,s.draftKey,s.sessionFile]));
   assert.equal(after.sessions.find(s=>s.id===d).reconnectOnLaunch,false);
   await click('button[aria-label="打开活跃会话"]');await click('#monitor-tab-connected');await pause(200);
   fs.writeFileSync(path.join(out,'restored.png'),(await win.webContents.capturePage()).toPNG());
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,phase+'-result.json'),JSON.stringify({passed:true,calls,errors},null,2));console.log('PASS '+phase);clearTimeout(timer);
  await win.webContents.session.flushStorageData();await win.webContents.session.closeAllConnections();win.destroy();app.quit();
 }catch(error){console.error(error.stack);fs.writeFileSync(path.join(out,phase+'-result.json'),JSON.stringify({passed:false,error:error.stack,calls,errors},null,2));if(win&&!win.isDestroyed())fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG());clearTimeout(timer);app.exit(1);}});
}
