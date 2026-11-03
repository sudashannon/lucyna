// Production renderer/preload and real bounded file reader. OMP and SSH are
// isolated fixtures; --work <Linux root> optionally reads existing WSL images.
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {readWorkspacePreview}=require('../src/workspace-preview.cjs');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-chat-images-'));
const out=path.resolve(process.env.LUCYNA_IMAGE_REVIEW_OUTPUT||'.impeccable/review/chat-images');fs.mkdirSync(out,{recursive:true});
app.setPath('userData',path.join(profile,'profile'));app.disableHardwareAcceleration();
require('./desktop-log.cjs').installDesktopLog(out);
const workArg=process.argv.indexOf('--work'),liveRoot=workArg<0?'':process.argv[workArg+1];
const root=liveRoot||'/fixture/work',diskRoot=liveRoot?require('../src/backend.cjs').wslUnc(root):path.join(profile,'work');
const ext=liveRoot?'webp':'png',names=['desktop','confirmation','narrow-detail','failure-relock'].map(name=>`notes/oasis-kmc-${name}.${ext}`);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let win,retry=false,remoteOffline=false;const errors=[],calls=[],external=[],checks=[],delayed=[];
const js=code=>win.webContents.executeJavaScript(code,true),click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function until(code,label=code){const end=Date.now()+16000;while(Date.now()<end){if(await js(`Boolean(${code})`))return;await pause(50);}throw Error('Timeout '+label);}
async function shot(name){await js('document.fonts.ready');await pause(200);if(name==='desktop'){await js('document.querySelector(".transcript").scrollTop=0');await pause(100);assert.equal(await js('document.querySelector(".transcript").scrollTop'),0);}assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),'page overflow');fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function closeZoom(){win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await until('!document.querySelector(".image-modal")');}
const bitmap=Buffer.alloc(640*360*4);for(let i=0;i<bitmap.length;i+=4){bitmap[i]=210;bitmap[i+1]=180;bitmap[i+2]=120;bitmap[i+3]=255;}
const fixtureImage=nativeImage.createFromBitmap(bitmap,{width:640,height:360}).toPNG(),remoteUrl='data:image/png;base64,'+nativeImage.createFromBitmap(Buffer.alloc(64*48*4,160),{width:64,height:48}).toPNG().toString('base64');
if(!liveRoot){fs.mkdirSync(path.join(diskRoot,'notes'),{recursive:true});for(const name of names)fs.writeFileSync(path.join(diskRoot,name),fixtureImage);}
const markdown=`这是图片显示与预览的隔离验收，未启动 OMP。${liveRoot?'图片读取自现有工作区。':'图片来自测试夹具。'}\n\n### 主页面\n\n![Oasis KMC 主页面](${names[0]})\n\n### 操作确认\n\n![目录阻断确认弹窗](${root}/${names[1]})\n\n另外可查看：[窄屏设备详情](${names[2]}) · [连接失败后自动上锁](${names[3]})。\n\n<details><summary>异常与隔离验收</summary>\n\n![缺失图片](notes/retry.png)\n\n行内图片：![损坏图片](notes/corrupt.png) 后续文字保持可读。\n\n![网络图片](https://example.com/no-network.png)\n\n![延迟图片](notes/deferred-inline.png)\n\n[延迟图片链接](notes/deferred.png) · [相关文档](notes/readme.md)\n\n</details>`;
app.whenReady().then(async()=>{const timer=setTimeout(()=>app.exit(2),120000);try{
 const handle=(name,fn)=>ipcMain.handle(name,(_, ...args)=>fn(...args));
 const works=[{root,name:'KMC 图片预览验收',kind:'work'},{root,name:'同路径远端工作区',kind:'work',hostId:'ssh-fixture',hostName:'SSH fixture'}];
 handle('works:list',()=>works);handle('omp:list',()=>works.map((work,i)=>({...work,id:i?'remote':'local',agentDir:'/tmp/fixture',sessionFile:'/tmp/'+i+'.jsonl',runtime:'wsl',ready:true,busy:false})));
 handle('session:list',()=>({sessions:[],managed:[]}));handle('work:read',()=>'# 图片验收');handle('work:details',()=>({root,members:[],assets:[],issues:[],warnings:[]}));handle('work:run',()=>[]);handle('pet:context',()=>{});
 handle('settings:get',()=>({settings:require('../src/client-settings.cjs').defaults()}));handle('feedback:get',()=>({settings:require('../src/feedback/settings.cjs').defaults(),warning:''}));handle('external:open',url=>external.push(url));
 handle('omp:request',(type,data,id)=>{if(type==='get_state')return {sessionName:id==='remote'?'远端图片验收':'聊天图片验收',sessionFile:'/tmp/'+id+'.jsonl',isSettled:true};if(type==='get_messages')return {messages:[{role:'assistant',content:[{type:'text',text:markdown}],timestamp:Date.now()}]};if(type==='get_subagents')return {subagents:[]};if(type==='get_background_tasks')return {tasks:[]};return {};});
 const localImage=await readWorkspacePreview(diskRoot,names[0],undefined,root);
 handle('preview:read',async(work,reference,base,hostId)=>{
   calls.push({work,reference,base,hostId});assert.equal(work,root);
   if(hostId){assert.equal(hostId,'ssh-fixture');if(remoteOffline)throw Error('远端未连接，请连接后重试');return {kind:'image',name:'remote.png',dataUrl:remoteUrl};}
   if(reference==='notes/deferred.png'||reference==='notes/deferred-inline.png')return new Promise(resolve=>delayed.push({reference,resolve}));
   if(reference==='notes/retry.png'){if(!retry)throw Error('文件不存在或已移动');return localImage;}
   if(reference==='notes/corrupt.png')return {kind:'image',name:'corrupt.png',dataUrl:'data:image/png;base64,AAAA'};
   if(reference==='notes/readme.md')return {kind:'markdown',name:'readme.md',path:reference,content:'# 关联文档\n\n![文档中的相对图片](oasis-kmc-desktop.'+ext+')'};
   return readWorkspacePreview(diskRoot,reference,base,root);
 });
 handle('preview:list',()=>({directory:'',entries:[],total:0,nextOffset:null}));
 win=new BrowserWindow({show:false,width:1440,height:1000,useContentSize:true,webPreferences:{preload:path.resolve('src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,done)=>{external.push(request.url);done({cancel:true});});
 await win.loadFile(path.resolve('dist/renderer/index.html'));await until('document.querySelectorAll(".work-row").length===2');await click('.work-row');await until('document.querySelectorAll(".message.assistant .markdown-workspace-image").length>=2');
 await js('document.querySelector(".transcript").scrollTop=0');await until('[...document.querySelectorAll(".markdown-workspace-image")].slice(0,2).every(i=>i.complete&&i.naturalWidth>0)');await shot('desktop');
 assert.ok(await js('document.querySelectorAll(".message.assistant [data-streamdown=image-wrapper]").length>=2'));checks.push('relative and Linux absolute historical Markdown images decode through the production reader');
 await click('.markdown-workspace-image');await until('document.querySelector(".image-modal img")?.naturalWidth>0');assert.equal(await js('document.querySelector(".image-modal img").src'),localImage.dataUrl);await shot('zoom');await closeZoom();
 await js('document.querySelector(".markdown-workspace-image").focus()');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await until('document.querySelector(".image-modal")');await closeZoom();checks.push('mouse and keyboard open the shared image preview; Escape closes it');
 for(const name of names.slice(2)){await click(`.message.assistant a[href="${name}"]`);await until('document.querySelector(".image-modal img")?.naturalWidth>0');const expected=await readWorkspacePreview(diskRoot,name,undefined,root);assert.equal(await js('document.querySelector(".image-modal img").src'),expected.dataUrl);await closeZoom();}checks.push('both image links open their exact full-size image');
 await js('document.querySelector(".message.assistant details").open=true;document.querySelector("img[alt=损坏图片]").scrollIntoView({block:"center"})');await until('document.querySelector(".message.assistant").textContent.includes("图片数据无法解码")');
 assert.ok(await js('document.querySelector(".message.assistant").textContent.includes("文件不存在或已移动")'));retry=true;await js('[...document.querySelectorAll(".markdown-image-status")].find(e=>e.textContent.includes("缺失图片")).querySelector("button").click()');await until('document.querySelector("img[alt=缺失图片]")?.naturalWidth>0');checks.push('missing file retries successfully; corrupt image has a separate decode error; external images make no requests');
 await click('a[href="notes/readme.md"]');await until('document.querySelector("#workspace-tab-files").getAttribute("aria-selected")==="true"');await until('document.querySelector(".reader-body img")?.naturalWidth>0');await click('#workspace-tab-chat');checks.push('ordinary document links retain document-relative images in the existing reader');
 await click('a[href="notes/deferred.png"]');await until("[...document.querySelectorAll('a')].find(a=>a.getAttribute('href')==='notes/deferred.png')?.getAttribute('aria-busy')==='true'");await click('.markdown-workspace-image');await until('document.querySelector(".image-modal img")?.naturalWidth>0');
 delayed.find(p=>p.reference==='notes/deferred.png').resolve(await readWorkspacePreview(diskRoot,names[1],undefined,root));await pause(100);assert.equal(await js('document.querySelector(".image-modal img").src'),localImage.dataUrl);await closeZoom();checks.push('an earlier slow image link cannot replace a later explicitly enlarged image');
 await click('button[aria-label="切换深色外观"]');win.setContentSize(390,844);await pause(200);await js('document.querySelector(".message.assistant details").open=false;document.querySelector(".transcript").scrollTop=0');await shot('mobile');
 win.setContentSize(1440,1000);await pause(150);await js('document.querySelector(".message.assistant details").open=true');await click('a[href="notes/deferred.png"]');await until("[...document.querySelectorAll('a')].find(a=>a.getAttribute('href')==='notes/deferred.png')?.getAttribute('aria-busy')==='true'");
 remoteOffline=true;await js('document.querySelectorAll(".work-row")[1].click()');await until('document.querySelector(".workspace-header").textContent.includes("同路径远端")');await until('document.querySelector(".markdown-image-status")?.textContent.includes("远端未连接")');
 for(const pending of delayed)pending.resolve(localImage);await pause(150);assert.equal(await js('document.querySelector(".image-modal")'),null);assert.equal(await js('document.querySelector(".markdown-workspace-image")'),null);checks.push('late local image and link results cannot open a dialog or populate the same-root SSH conversation');
 await js('document.querySelector(".transcript").scrollTop=0');await shot('disconnected');remoteOffline=false;await click('.markdown-image-status button');await until('document.querySelector(".markdown-workspace-image")?.naturalWidth>0');assert.equal(await js('document.querySelector(".markdown-workspace-image").src'),remoteUrl);assert.ok(calls.some(c=>c.hostId==='ssh-fixture'));checks.push('SSH host identity is forwarded; connection failure is visible and retry reads the correct host');
 assert.deepEqual(external,[]);assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,liveImages:!!liveRoot,checks,calls,errors},null,2));console.log(JSON.stringify({passed:true,checks}));clearTimeout(timer);app.exit(0);
 }catch(error){console.error(error.stack);console.error(errors);console.error(await js('[...document.querySelectorAll(".message img")].map(i=>({className:i.className,alt:i.alt,role:i.getAttribute("role"),complete:i.complete,width:i.naturalWidth}))').catch(()=>[]));await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:error.stack,checks,calls,errors},null,2));clearTimeout(timer);app.exit(1);}});
