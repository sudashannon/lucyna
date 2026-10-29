// Real Windows chrome and production renderer; isolated, offline demo data.
const {app,BrowserWindow,nativeTheme}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {windowOptions,installWindowChrome}=require('../src/window-chrome.cjs');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-chrome-'));
require('../src/app-identity.cjs').configureAppIdentity(app,{LUCYNA_USERDATA:profile});
let win;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),js=code=>win.webContents.executeJavaScript(code);
const out=path.resolve('.runtime/window-chrome');fs.mkdirSync(out,{recursive:true});
async function until(code){const end=Date.now()+12000;while(Date.now()<end){if(await js(`Boolean(${code})`))return;await pause(75);}throw Error('Timeout '+code);}
async function click(selector){await js(`document.querySelector(${JSON.stringify(selector)}).click()`);}
async function layout(label){const result=await js(`(()=>{const title=document.querySelector('.window-titlebar').getBoundingClientRect(),body=document.querySelector('.app-shell').getBoundingClientRect();return{title:{top:title.top,height:title.height,bottom:title.bottom},banner:document.querySelector('.demo-banner')?.getBoundingClientRect().height||0,body:{top:body.top,bottom:body.bottom},height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};})()`);assert.ok(Math.abs(result.title.height-36)<=1,label+' title height');assert.ok(Math.abs(result.body.top-result.title.bottom-result.banner)<=1,label+' no gap/overlap');assert.ok(Math.abs(result.body.bottom-result.height)<=1,label+' no bottom overflow');assert.equal(result.overflow,false,label);assert.equal(win.isMenuBarVisible(),false,label+' no native menu row');return result;}
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>app.exit(2),60000),errors=[];
 try{
  assert.equal(app.getName(),'Lucyna');assert.equal(app.getPath('userData'),fs.realpathSync.native(profile));assert.equal(app.getPath('sessionData'),app.getPath('userData'));
  win=new BrowserWindow({icon:require('../src/app-icon.cjs').applicationIcon,width:1440,height:900,minWidth:960,minHeight:640,show:false,title:'Lucyna · 新顶栏预览（演示数据）',...windowOptions(),webPreferences:{preload:path.join(__dirname,'screenshot-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,additionalArguments:['--lucyna-titlebar']}});
  const menu=installWindowChrome(win);win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await win.loadFile(path.resolve('dist/renderer/index.html'));await until('document.querySelectorAll(".window-menubar button").length===5');await until('document.querySelectorAll(".work-row").length===3');
  assert.equal(win.getTitle(),'Lucyna · 工作台');assert.ok((await js('document.querySelector(".brand").textContent')).includes('Lucyna'));
  await click('.work-row');await until('document.querySelector("#message-input")');await js('window.gallery.ready()');await until('document.querySelector(".composer-footnote").textContent.includes("会话已连接")');await js('window.gallery.conversation()');await until('document.querySelector(".message.assistant")');
  await pause(600);const light=await layout('light');fs.writeFileSync(path.join(out,'light.png'),(await win.webContents.capturePage()).toPNG());
  await click('button[aria-label="切换深色外观"]');await until('document.documentElement.dataset.theme==="dark"');assert.equal(nativeTheme.themeSource,'dark');const dark=await layout('dark');fs.writeFileSync(path.join(out,'dark.png'),(await win.webContents.capturePage()).toPNG());
  const view=menu.getMenuItemById('view');view.submenu.items[0].click();await until('document.querySelector(".app-shell.rail-mode")');view.submenu.items[0].click();await until('!document.querySelector(".app-shell.rail-mode")');
  view.submenu.items[1].click();await until('document.querySelector(".app-shell.with-panel")');assert.equal(await js('document.querySelectorAll(".window-menubar button").length'),5);
  win.setSize(960,700);await pause(200);const narrow=await layout('narrow');fs.writeFileSync(path.join(out,'narrow.png'),(await win.webContents.capturePage()).toPNG());
  menu.getMenuItemById('help').submenu.items[0].click();await until('document.querySelector("[role=dialog]")');await click('button[aria-label="关闭弹窗"]');
  // Actual accelerator routing: hidden native menus must not duplicate React handlers.
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'b',modifiers:['control']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'b',modifiers:['control']});await until('document.querySelector(".app-shell.rail-mode")');await pause(150);assert.ok(await js('!!document.querySelector(".app-shell.rail-mode")'));
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Alt'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Alt'});await pause(150);assert.equal(win.isMenuBarVisible(),false,'Alt must not restore the legacy menu bar');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,light,dark,narrow,checks:['merged native chrome','Chinese menus','theme sync','960px layout','native Ctrl+B once','Alt leaves native menu hidden','menu actions'],profile},null,2));console.log(JSON.stringify({passed:true,out,profile}));
  if(process.argv.includes('--preview')){win.setSize(1440,900);await click('button[aria-label="切换浅色外观"]');view.submenu.items[0].click();view.submenu.items[1].click();win.setTitle('Lucyna · 新顶栏预览（演示数据）');win.show();win.focus();clearTimeout(timer);return;}
 }catch(error){console.error(error.stack);console.error(errors);process.exitCode=1;}
 clearTimeout(timer);app.exit(process.exitCode||0);
});
