// Production renderer/preload with an isolated profile and deterministic services.
// Does not connect real sessions, submit model requests or modify user settings.
const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {rankSearchResults,excerptFromSnapshot}=require('../src/knowledge-search.cjs');
const {createHash}=require('node:crypto');
const out=path.resolve('.runtime/usability-'+Date.now());fs.mkdirSync(out,{recursive:true});require('./desktop-log.cjs').installDesktopLog(out);
app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
const docs=['PICO 图传中断排查','PICO 发布记录','网络观测','读取失败','空白文档'].map((title,i)=>({id:'doc-'+i,title,path:'/wiki/doc-'+i+'.md',workspace:'pico',type:'knowledge',updatedAt:'2026-10-30T00:00:00Z'}));
const catalog={documents:docs,workspaces:[{alias:'pico',path:'/wiki'},{alias:'other',path:'/other'}],fetchedAt:new Date().toISOString()};
const source='---\ntitle: PICO 图传中断\n---\n# 排查\n\nPICO 图传中断时先检查 EOS，再检查控制连接。\n保留日志后继续分析。';
const version='doc-v1:'+createHash('sha256').update(source).digest('hex');
const checks=[],errors=[],calls=[],pause=ms=>new Promise(r=>setTimeout(r,ms));let win,failEvidence=false;
const js=code=>win.webContents.executeJavaScript(code,true),click=sel=>js(`document.querySelector(${JSON.stringify(sel)}).click()`);
const button=(sel,label)=>js(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
async function until(code){const end=Date.now()+15000;while(Date.now()<end){if(await js(`Boolean(${code})`))return;await pause(40);}throw Error('Timeout '+code);}
async function input(sel,value){await js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await pause(70);}
async function shot(name){await js('document.fonts.ready');await pause(180);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),'no window overflow');fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
const pass=text=>{checks.push(text);console.log('PASS '+text);};
app.whenReady().then(async()=>{const timer=setTimeout(()=>app.exit(2),90000);try{
 const handle=(name,fn)=>ipcMain.handle(name,(_, ...args)=>fn(...args));
 handle('works:list',()=>[{root:'/demo/pico',name:'pico-streaming-investigation',kind:'work'},{root:'/demo/second',name:'second-workspace',kind:'work'}]);
 handle('omp:list',()=>[{id:'running',root:'/demo/pico',agentDir:'/demo/agent',runtime:'wsl',ready:true,busy:false}]);
 handle('omp:request',(type)=>type==='get_state'?{sessionFile:'/demo/running.jsonl',sessionName:'PICO 排查',isSettled:true}:type==='get_messages'?{messages:[]}:{});
 handle('omp:close',id=>{calls.push({kind:'close',id});});
 handle('session:list',()=>({sessions:[],managed:[]}));handle('work:read',()=>'# 工作记录');
 handle('work:details',root=>({root,name:'PICO 排查',kind:'work',content:'# 工作记录',members:[],assets:[],issues:[],warnings:[]}));
 handle('work:run',(kind,args)=>{calls.push({kind:'work:'+kind,args});if(kind==='list')return[];if(kind==='automatic-status')return{enabled:false,status:'paused',label:'自动进化已暂停',message:'尚未配置评测',profile:null,runsToday:0,dailyLimit:3,idleSeconds:60,cooldownSeconds:600};throw Error('Unexpected background mutation');});
 handle('pet:context',()=>{});handle('pet:get',()=>({settings:require('../src/pet/state.cjs').defaults(),warning:''}));
 handle('settings:get',()=>({settings:require('../src/client-settings.cjs').defaults(),workspace:{distro:'Ubuntu-22.04',user:'demo',root:'/demo'},storage:'Isolated test profile'}));
 handle('feedback:get',()=>({settings:require('../src/feedback/settings.cjs').defaults(),warning:''}));
 handle('auxiliary:get',()=>({...require('../src/auxiliary-settings.cjs').defaults(),hasApiKey:false}));
 handle('feedback:stop-preview',()=>{});
 handle('stele:knowledge',async(kind,args)=>{
   calls.push({kind,args});if(kind==='catalog')return catalog;
   if(kind==='document'){await pause(args.id==='doc-0'?650:250);if(args.id==='doc-3')throw Error('Injected document read failure');return{component:docs.find(d=>d.id===args.id),content:args.id==='doc-4'?'':args.id==='doc-1'?'发布正文':source,forward:[],backlinks:[]};}
   if(kind==='search'){await pause(180);return rankSearchResults(docs.slice(0,3).reverse().map(d=>({...d,reasons:['semantic-match'],rankScore:1})),docs,args.query,args.workspace);}
   if(kind==='searchEvidence'){await pause(450);if(failEvidence)throw Error('Injected evidence read failure');return{...docs.find(d=>d.id===args.id),version,freshness:'current',...excerptFromSnapshot(source,args.query)};}
   if(kind==='snapshot')return{content:source,version,workspace:'pico'};
   return[];
 });
 win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{preload:path.resolve('src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 await win.loadFile(path.resolve('dist/renderer/index.html'));await until('document.querySelectorAll(".work-row").length===2');await click('.work-row');
 await js('localStorage.setItem("omp.sidebarWidth","420");localStorage.setItem("omp.panelWidth","520")');await win.reload();await until('document.querySelectorAll(".work-row").length===2');await click('.work-row');await click('#tab-work');
 const chatWidth=await js('document.querySelector(".workspace-main").getBoundingClientRect().width');
 assert.ok(chatWidth>=638,'conversation width '+chatWidth);await shot('workbench-1440');pass('1440px three-column layout preserves a readable conversation');
 await input('select[aria-label="工作区筛选"]','open');assert.equal(await js('document.querySelectorAll(".work-row").length'),1);
 await input('select[aria-label="工作区筛选"]','attention');assert.equal(await js('document.querySelectorAll(".work-row").length'),0);
 await input('select[aria-label="工作区筛选"]','all');assert.equal(await js('document.querySelectorAll(".work-row").length'),2);pass('workspace open/attention/all filters reflect actual session state');
 await button('.wd-tabs button','后台任务');await until('document.querySelector(".wr-readiness").textContent.includes("1 个会话连接")');await button('.wr-actions button','新建后台任务');
 await until('document.querySelector(".wr-dashboard-modal .wr-form")');assert.ok(await js('document.querySelector(".wr-dashboard-modal").getBoundingClientRect().width>=800'));
 assert.equal(await js('document.querySelector(".wr-form button[type=submit]").disabled'),true);
 const footerVisible=await js('(()=>{const r=document.querySelector(".wr-form-actions").getBoundingClientRect(),p=document.querySelector(".wr-dashboard-modal .work-runs").getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom+1})()');assert.ok(footerVisible,'form controls visible without scrolling');
 await shot('background-form');await button('.wr-readiness button','查看会话连接');await until('!document.querySelector(".session-monitor").hidden');assert.ok(await js('document.querySelector(".monitor-filter-hint").textContent.includes("不一定正在执行")'));
 assert.ok(await js('document.querySelector(".monitor-connection").textContent.includes("已连接")'));pass('background preflight blocks conflicting submit, opens a wide form with visible actions and links to connection state');
 await click('button[aria-label="打开知识库"]');await until('document.querySelectorAll(".knowledge-row").length===5');
 await js('window.__falseEmpty=false;window.__observer=new MutationObserver(()=>{if(document.querySelector(".knowledge-reader").textContent.includes("此文档暂无正文"))window.__falseEmpty=true});window.__observer.observe(document.querySelector(".knowledge-reader"),{subtree:true,childList:true,characterData:true});');
 await click('.knowledge-row');await pause(100);assert.ok(await js('document.querySelector(".knowledge-reader").textContent.includes("读取正文")'));assert.equal(await js('window.__falseEmpty'),false);
 await click('.knowledge-row:nth-child(2)');await until('document.querySelector(".knowledge-reader").textContent.includes("发布正文")');await pause(500);assert.equal(await js('window.__falseEmpty'),false);assert.ok(await js('document.querySelector(".knowledge-reader").textContent.includes("发布正文")'));
 await click('.knowledge-row:nth-child(4)');await until('document.querySelector(".knowledge-reader [role=alert]")');await click('.knowledge-row:nth-child(2)');await pause(70);assert.equal(await js('!!document.querySelector(".knowledge-reader [role=alert]")'),false);await until('document.querySelector(".knowledge-reader").textContent.includes("发布正文")');
 await js('window.__observer.disconnect()');await click('.knowledge-row:nth-child(5)');await until('document.querySelector(".knowledge-reader").textContent.includes("此文档暂无正文")');pass('loading, actual empty, read failure and rapid document switching remain distinct');
 await input('input[aria-label="搜索知识库"]','PICO 图传中断');await input('select[aria-label="知识库来源"]','pico');await click('.knowledge-search-evidence');
 await until('document.querySelector(".knowledge-evidence-card blockquote")');assert.equal(await js('document.querySelector("input[aria-label=证据检索关键词]").value'),'PICO 图传中断');assert.equal(await js('document.querySelector("select[aria-label=知识功能来源]").value'),'pico');
 assert.equal(await js('document.querySelectorAll(".knowledge-search-view .knowledge-native-row").length'),2);assert.equal(await js('document.querySelector(".knowledge-evidence-card blockquote").textContent'),'PICO 图传中断时先检查 EOS，再检查控制连接。\n保留日志后继续分析。');
 await click('.knowledge-search-caption input');assert.equal(await js('document.querySelectorAll(".knowledge-search-view .knowledge-native-row").length'),3);await shot('evidence-search');
 await button('.knowledge-native-actions button','核对原文');await until('document.querySelector(".knowledge-evidence-lines .highlight")');assert.equal(await js('document.querySelectorAll(".knowledge-evidence-lines .highlight").length'),2);assert.equal(await js('!!document.querySelector(".knowledge-dialog [role=alert]")'),false);await click('button[aria-label="关闭对话框"]');
 failEvidence=true;await click('.knowledge-search-view .knowledge-native-row:nth-child(2)');await pause(70);assert.equal(await js('!!document.querySelector(".knowledge-search-view .knowledge-evidence-card")'),false);await until('document.querySelector(".knowledge-search-view .knowledge-native-detail [role=alert]")');
 failEvidence=false;await button('.knowledge-search-view .knowledge-native-detail [role=alert] button','重试读取');await until('document.querySelector(".knowledge-search-view .knowledge-evidence-card")');
 await button('.knowledge-native-actions button','引用到草稿');await until('!document.querySelector(".workspace-main").hidden');assert.ok(await js(`document.querySelector('#message-input').value.includes(${JSON.stringify(version)})`));assert.ok(await js('document.querySelector("#message-input").value.includes("原文行：6 至 7")'));pass('search carries source/query, retains semantic alternatives and quotes the verified snapshot; stale evidence cannot be quoted');
 await click('button[aria-label="设置"]');await until('document.querySelector(".settings-navigation button[aria-controls=settings-storage-title]")');
 assert.equal(await js('document.querySelectorAll(".settings-navigation-groups>button").length'),3);
 await input('.settings-body input:not([type=checkbox])','/fixture/unsaved-omp');
 await button('.settings-navigation button','数据与回退');await pause(100);assert.equal(await js('document.activeElement.id'),'settings-storage-title');assert.ok(await js('document.querySelector(".settings-body").scrollTop>0'));
 assert.ok(await js('document.querySelector(".settings-navigation-location").textContent.includes("数据与回退")'));
 assert.equal(await js('document.querySelector(".settings-body input:not([type=checkbox])").value'),'/fixture/unsaved-omp');
 await shot('settings-navigation');await js('document.querySelector(".settings-body").scrollTop=0');await until('document.querySelector(".settings-navigation-location").textContent.includes("运行环境")');await click('button[aria-label="关闭弹窗"]');
 win.setContentSize(960,700);await pause(100);
 assert.equal(await js('document.querySelector("#tools-panel").hidden'),true);
 const mainHeight=await js('document.querySelector(".workspace-main").getBoundingClientRect().height');
 assert.ok(mainHeight>650,'narrow conversation retains full window height');
 await js('document.querySelector(\'button[aria-label="展开工具面板"]\').focus()');await click('button[aria-label="展开工具面板"]');await until('document.querySelector("#tools-panel").getAttribute("role")==="dialog"');
 assert.equal(await js('document.querySelector(".workspace-main").inert'),true);
 assert.equal(await js('document.querySelector(".workspace-main").getBoundingClientRect().height'),mainHeight);
 await js('window.__drawerLast=Array.from(document.querySelectorAll("#tools-panel button,#tools-panel input,#tools-panel select,#tools-panel textarea,#tools-panel [tabindex]")).filter(e=>e.tabIndex>=0&&!e.matches(":disabled")&&e.getClientRects().length).at(-1);window.__drawerLast.focus()');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await until('document.activeElement.getAttribute("aria-label")==="收起工具面板"');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});await until('document.activeElement===window.__drawerLast');
 await shot('narrow-tools-drawer');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await until('document.querySelector("#tools-panel").hidden');
 assert.equal(await js('document.querySelector(".workspace-main").inert'),false);
 await until('document.activeElement.getAttribute("aria-label")==="展开工具面板"');
 assert.ok(await js('Array.from(document.querySelectorAll(".primary-switcher [role=tab]")).every(tab=>{const panel=document.getElementById(tab.getAttribute("aria-controls"));return panel?.getAttribute("role")==="tabpanel"&&panel.getAttribute("aria-labelledby")===tab.id})'));
 await click('button[aria-label="切换深色外观"]');await shot('narrow-dark');pass('grouped settings navigate and focus headings; narrow tools open on demand, preserve chat height and close with focus restored');
 assert.equal(calls.filter(c=>c.kind==='close'||c.kind==='work:create').length,0);assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks},null,2));console.log('ARTIFACTS '+out);clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:e.stack,checks,errors},null,2));console.log('ARTIFACTS '+out);clearTimeout(timer);app.exit(1);}});
