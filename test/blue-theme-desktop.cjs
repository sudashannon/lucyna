// Production renderer acceptance: theme changes preserve live Work state and drafts.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-blue-')));
app.disableHardwareAcceleration();
const nativeChrome=process.argv.includes('--native-chrome');
const out=path.resolve(nativeChrome?'.runtime/blue-theme-native-review':'.runtime/blue-theme-review'),pause=ms=>new Promise(r=>setTimeout(r,ms));
let win;const checks=[],errors=[],overlays=[];
const js=code=>win.webContents.executeJavaScript(code);
async function until(code){const end=Date.now()+15000;while(Date.now()<end){if(await js(`Boolean(${code})`))return;await pause(60);}throw Error('Timeout '+code);}
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const label=name=>click(`button[aria-label=${JSON.stringify(name)}]`);
const set=(selector,value)=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
async function shot(name){await js('document.fonts.ready');await pause(200);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),'viewport overflow '+name);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
const pass=s=>{checks.push(s);console.log('PASS '+s);};
async function overlay(color){if(!nativeChrome)return;const end=Date.now()+3000;while(Date.now()<end){if(overlays.at(-1)?.color===color)return;await pause(30);}assert.equal(overlays.at(-1)?.color,color);}
app.whenReady().then(async()=>{fs.mkdirSync(out,{recursive:true});const timer=setTimeout(()=>app.exit(2),90000);try{
  win=new BrowserWindow({show:false,width:1440,height:900,useContentSize:true,...(nativeChrome?require('../src/window-chrome.cjs').windowOptions():{}),webPreferences:{preload:path.resolve('test/screenshot-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false,additionalArguments:nativeChrome?['--lucyna-titlebar']:[]}});
  if(nativeChrome){const setOverlay=win.setTitleBarOverlay.bind(win);win.setTitleBarOverlay=options=>{overlays.push(options);return setOverlay(options);};require('../src/window-chrome.cjs').installWindowChrome(win);}
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await win.loadFile(path.resolve('dist/renderer/index.html'));
  await until('document.querySelectorAll(".work-row").length===3');await click('.work-row');await click('#tab-work');
  await until('document.querySelector(".wd-provenance")');
  assert.equal(await js('document.documentElement.dataset.visualTheme'),'blue');
  await overlay('#112341');
  assert.ok(await js('document.querySelector(".workspace-main").getBoundingClientRect().width>=638'));
  assert.ok(await js('document.querySelector(".application-navigation").getBoundingClientRect().right<=document.querySelector(".work-directory").getBoundingClientRect().left+1'));
  await shot('blue-empty');
  await label('技能与命令');await until('document.querySelector(".composer-footnote").textContent.includes("会话已连接")');await label('关闭命令补全');
  await js('window.gallery.conversation()');await until('document.querySelector(".message.assistant")');await shot('blue-workbench');
  await set('#message-input','保留此草稿，切换视觉风格。');
  await js('window.__themeComposer=document.querySelector("#message-input");window.__themeSession=document.querySelector(".app-shell").dataset.sessionId;window.__messageCount=document.querySelectorAll(".message").length;');
  await set('select[aria-label="视觉主题"]','classic');
  await until('document.documentElement.dataset.visualTheme==="classic"');
  await overlay('#f8f6f0');
  assert.equal(await js('document.querySelector("#message-input")===window.__themeComposer'),true);
  assert.equal(await js('document.querySelector("#message-input").value'),'保留此草稿，切换视觉风格。');
  assert.equal(await js('document.querySelector(".app-shell").dataset.sessionId===window.__themeSession'),true);
  assert.equal(await js('document.querySelectorAll(".message").length===window.__messageCount'),true);
  await shot('classic-workbench');pass('switching visual themes preserves the mounted composer, draft, active session and transcript');
  await win.reload();await until('document.querySelectorAll(".work-row").length===3');assert.equal(await js('document.documentElement.dataset.visualTheme'),'classic');pass('visual theme survives renderer reload');
  await click('.work-row');await click('#tab-work');
  await set('select[aria-label="视觉主题"]','blue');await label('设置');await until('document.querySelector(".settings-body")');
  await js('Array.from(document.querySelectorAll(".settings-navigation-group")).find(e=>e.textContent.includes("外观与体验")).click()');
  await click('input[name="visual-theme"][value="classic"]');
  await js('Array.from(document.querySelectorAll(".settings-modal .modal-actions button")).find(e=>e.textContent==="取消").click()');
  assert.equal(await js('document.documentElement.dataset.visualTheme'),'blue');
  await label('设置');await until('document.querySelector(".settings-body")');
  await js('Array.from(document.querySelectorAll(".settings-navigation-group")).find(e=>e.textContent.includes("外观与体验")).click()');
  await shot('blue-settings');await click('input[name="visual-theme"][value="classic"]');
  await js('Array.from(document.querySelectorAll(".settings-modal .modal-actions button")).find(e=>e.textContent==="保存").click()');await until('!document.querySelector(".settings-modal")');
  assert.equal(await js('document.documentElement.dataset.visualTheme'),'classic');pass('settings keep appearance drafts local until Save; Cancel retains the active theme');
  await set('select[aria-label="视觉主题"]','blue');await label('技能与命令');await until('document.querySelector(".composer-footnote").textContent.includes("会话已连接")');await label('关闭命令补全');await js('window.gallery.conversation()');await until('document.querySelector(".message.assistant")');
  await label('切换深色外观');await overlay('#0b192f');await shot('blue-dark');await label('切换浅色外观');await overlay('#112341');
  await label('打开知识库');await until('document.querySelectorAll(".knowledge-row").length===4');await click('.knowledge-row');await until('document.querySelector(".knowledge-reader [data-streamdown=mermaid-block] svg[aria-roledescription]")');await shot('blue-knowledge');
  await label('打开活跃会话');await shot('blue-sessions');await label('打开工作台');
  win.setContentSize(960,700);await pause(150);assert.equal(await js('document.querySelector("#tools-panel").hidden'),true);await shot('blue-960');
  await js('document.querySelector(\'button[aria-label="展开工具面板"]\').focus()');await label('展开工具面板');await until('document.querySelector("#tools-panel").getAttribute("role")==="dialog"');
  assert.equal(await js('document.querySelector(".sidebar").inert&&document.querySelector(".workspace-main").inert'),true);await shot('blue-drawer');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await until('document.querySelector("#tools-panel").hidden');
  await until('document.activeElement.getAttribute("aria-label")==="展开工具面板"');pass('960px tools remain an accessible modal drawer and return keyboard focus');
  win.setContentSize(390,844);await pause(150);await shot('blue-390');assert.ok(await js('document.querySelector(".workspace-main").getBoundingClientRect().width>=320'));
  assert.ok(await js('document.querySelector(".application-navigation").getBoundingClientRect().height>=document.querySelector(".app-shell").getBoundingClientRect().height-1'));
  assert.ok(await js('Array.from(document.querySelectorAll(\'button[aria-label="新会话"]\')).some(e=>e.getClientRects().length)'));
  await label('打开知识库');await until('document.querySelector(".navigation-knowledge .knowledge-sidebar")');assert.ok(await js('document.querySelector(".navigation-knowledge").getBoundingClientRect().width>=40'));await shot('blue-knowledge-390');await label('打开工作台');
  assert.ok(await js('Array.from(document.querySelectorAll(".primary-switcher [role=tab]")).every(e=>e.getBoundingClientRect().width>=40)'));pass('390px contracts navigation and preserves the conversation with no horizontal overflow');
  if(nativeChrome)pass('Windows caption controls follow Blue light/dark and Classic palettes through authorized native IPC');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks,errors,overlays},null,2));console.log('ARTIFACTS '+out);clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:error.stack,checks,errors},null,2));clearTimeout(timer);app.exit(1);}});
