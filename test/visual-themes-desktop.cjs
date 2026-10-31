// Exercise production theme controls against the offline gallery fixture.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-themes-')));app.disableHardwareAcceleration();
const out=path.resolve('.impeccable/review/studio-themes');fs.mkdirSync(out,{recursive:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));let win;const checks=[],errors=[],overlays=[],metrics=[];
const js=code=>win.webContents.executeJavaScript(code);
async function until(code){const end=Date.now()+12000;while(Date.now()<end){if(await js(`Boolean(${code})`))return;await pause(60);}throw Error('Timeout '+code);}
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const label=name=>click(`button[aria-label=${JSON.stringify(name)}]`);
const set=(selector,value)=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const pass=s=>{checks.push(s);console.log('PASS '+s);};
async function shot(name){await js('document.fonts.ready');await pause(160);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),'overflow '+name);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function choose(theme){await set('select[aria-label="视觉主题"]',theme);await until(`document.documentElement.dataset.visualTheme===${JSON.stringify(theme)}`);await pause(90);}
async function connect(){await label('技能与命令');await until('document.querySelector(".composer-footnote").textContent.includes("会话已连接")');await label('关闭命令补全');await js('window.gallery.conversation()');await until('document.querySelector(".message.assistant")');}
async function settings(){await label('设置');await until('document.querySelector(".settings-body")');await js('Array.from(document.querySelectorAll(".settings-navigation-group")).find(e=>e.textContent.includes("外观与体验")).click()');}
const contrastAudit=`(()=>{
 const rgb=s=>(s.match(/[\\d.]+/g)||[]).slice(0,3).map(Number), lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const bg=e=>{for(let p=e;p;p=p.parentElement){const v=getComputedStyle(p).backgroundColor;if(v!=='rgba(0, 0, 0, 0)'&&v!=='transparent')return rgb(v);}return [255,255,255];};
 return ['.message.user','.message.assistant','.sidebar .work-row.selected','.sidebar .primary-switcher [aria-selected=true]','.composer-footnote','.wd-tabs button[aria-pressed=true]','.visual-theme-switch select','.work-list-filter select','.profile-row small'].flatMap(selector=>Array.from(document.querySelectorAll(selector)).filter(e=>e.getClientRects().length).map(e=>{const a=lum(rgb(getComputedStyle(e).color)),b=lum(bg(e));return {selector,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};}));
})()`;
app.whenReady().then(async()=>{const timer=setTimeout(()=>app.exit(2),90000);try{
 const chrome=require('../src/window-chrome.cjs');
 win=new BrowserWindow({show:false,width:1440,height:900,useContentSize:true,...chrome.windowOptions(),webPreferences:{preload:path.resolve('test/screenshot-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false,additionalArguments:['--lucyna-titlebar']}});
 const original=win.setTitleBarOverlay.bind(win);win.setTitleBarOverlay=options=>{overlays.push(options);return original(options);};chrome.installWindowChrome(win);
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 await win.loadFile(path.resolve('dist/renderer/index.html'));await until('document.querySelectorAll(".work-row").length===3');await click('.work-row');await click('#tab-work');await connect();
 assert.equal(await js('document.querySelectorAll(\'select[aria-label="视觉主题"] option\').length'),4);
 await set('#message-input','四种风格之间保留这份草稿。');await js('window.themeInput=document.querySelector("#message-input");window.themeSession=document.querySelector(".app-shell").dataset.sessionId;window.themeMessages=document.querySelectorAll(".message").length');
 for(const theme of ['classic','blue','folio','pixel']){
  await choose(theme);assert.equal(await js('document.querySelector("#message-input")===window.themeInput'),true);assert.equal(await js('document.querySelector("#message-input").value'),'四种风格之间保留这份草稿。');assert.equal(await js('document.querySelector(".app-shell").dataset.sessionId===window.themeSession'),true);assert.equal(await js('document.querySelectorAll(".message").length'),await js('window.themeMessages'));
 }
 pass('All four theme controls preserve the mounted composer, draft, active session and transcript.');
 await set('#message-input','');
 for(const theme of ['folio','pixel']){
  await choose(theme);await js('document.activeElement.blur()');
  const desired=theme==='folio'?'#203c33':'#202127';assert.equal(overlays.at(-1).color,desired);
  assert.equal(await js('document.querySelector(".primary-switcher").getAttribute("aria-orientation")'),'vertical');
  assert.ok(await js('document.querySelector(".workspace-main").getBoundingClientRect().width>=640'));
  assert.ok(await js('document.querySelector(".directory-companion img").complete&&document.querySelector(".directory-companion img").naturalWidth>0'));
  assert.ok(await js('document.querySelector(".sidebar .work-list").getBoundingClientRect().height>=130'),'wide Work list has actual reading space');
  metrics.push({theme,appearance:'light',contrast:await js(contrastAudit)});await shot(theme+'-desktop');
  await label('切换深色外观');await pause(120);assert.equal(overlays.at(-1).color,theme==='folio'?'#12241d':'#15161e');metrics.push({theme,appearance:'dark',contrast:await js(contrastAudit)});await shot(theme+'-dark');await label('切换浅色外观');
  await settings();assert.equal(await js('document.querySelectorAll(\'input[name="visual-theme"]\').length'),4);await shot(theme+'-settings');await click(`input[name="visual-theme"][value="${theme==='folio'?'pixel':'folio'}"]`);await js('Array.from(document.querySelectorAll(".settings-modal .modal-actions button")).find(e=>e.textContent==="取消").click()');assert.equal(await js('document.documentElement.dataset.visualTheme'),theme);
  await label('打开知识库');await until('document.querySelectorAll(".knowledge-row").length===4');assert.ok(await js('document.querySelector(".knowledge-sidebar .knowledge-list").getBoundingClientRect().height>=140'),'knowledge list has actual reading space');await click('.knowledge-row');await until('document.querySelector(".knowledge-reader [data-streamdown=mermaid-block] svg[aria-roledescription]")');await shot(theme+'-knowledge');
  await label('打开活跃会话');await shot(theme+'-sessions');await label('打开工作台');
  win.setContentSize(960,700);await pause(120);assert.ok(await js('document.querySelector(".sidebar .work-list").getBoundingClientRect().height>=100'),'short Work list has actual reading space');await shot(theme+'-960');await js('document.querySelector(\'button[aria-label="展开工具面板"]\').focus()');await label('展开工具面板');await until('document.querySelector("#tools-panel").getAttribute("role")==="dialog"');assert.equal(await js('document.querySelector(".sidebar").inert&&document.querySelector(".workspace-main").inert'),true);await shot(theme+'-drawer');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await until('document.querySelector("#tools-panel").hidden');await until('document.activeElement.getAttribute("aria-label")==="展开工具面板"');
  win.setContentSize(390,844);await pause(120);await shot(theme+'-390');assert.ok(await js('document.querySelector(".workspace-main").getBoundingClientRect().width>=320'));assert.ok(await js('Array.from(document.querySelectorAll(".primary-switcher [role=tab]")).every(e=>e.getBoundingClientRect().width>=40)'));await label('打开知识库');await until('document.querySelector(".knowledge-sidebar.is-compact")');await shot(theme+'-knowledge-390');await label('打开工作台');
  win.setContentSize(1440,900);await pause(120);await label('收起侧栏 · Ctrl B');await shot(theme+'-rail');await label('展开侧栏 · Ctrl B');
  pass(theme+': light/dark native caption, settings Cancel, knowledge, sessions, 960px drawer/focus and 390px navigation work.');
 }
 for(const m of metrics)for(const check of m.contrast)assert.ok(check.ratio>=4.5,`${m.theme}/${m.appearance} ${check.selector}: ${check.ratio.toFixed(2)} contrast`);
 pass('Rendered primary text, supporting labels, selected rows and tabs meet 4.5:1 in both new themes and appearances.');
 await settings();await click('input[name="visual-theme"][value="folio"]');await js('Array.from(document.querySelectorAll(".settings-modal .modal-actions button")).find(e=>e.textContent==="保存").click()');await until('!document.querySelector(".settings-modal")');assert.equal(await js('document.documentElement.dataset.visualTheme'),'folio');await win.reload();await until('document.querySelectorAll(".work-row").length===3');assert.equal(await js('document.documentElement.dataset.visualTheme'),'folio');
 pass('Settings Save applies Folio and persists it across renderer reload.');assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks,metrics,overlays,errors},null,2));clearTimeout(timer);app.exit(0);
 }catch(error){console.error(error);await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:error.stack,checks,metrics,errors},null,2));clearTimeout(timer);app.exit(1);}});
