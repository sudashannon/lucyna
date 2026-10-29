// Capture the real production renderer with the explicit offline demo preload.
const {app,BrowserWindow}=require('electron');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-gallery-')));
const out=path.resolve(__dirname,'../docs/screenshots'),pause=ms=>new Promise(r=>setTimeout(r,ms));
let window;const js=code=>window.webContents.executeJavaScript(code);
async function until(code){const end=Date.now()+15000;while(Date.now()<end){if(await js(`Boolean(${code})`))return;await pause(75);}throw Error('Timeout '+code);}
const click=label=>js(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`);
async function shot(name){await pause(900);await js('document.fonts.ready');assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),'viewport overflow');if(!process.argv.includes('--check'))fs.writeFileSync(path.join(out,name+'.png'),(await window.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>app.exit(2),90000),errors=[];
 try{
  fs.mkdirSync(out,{recursive:true});
  window=new BrowserWindow({icon:require('../src/app-icon.cjs').applicationIcon,width:1500,height:1000,show:false,useContentSize:true,webPreferences:{preload:path.join(__dirname,'screenshot-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  window.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  await window.loadFile(path.resolve(__dirname,'../dist/renderer/index.html'));
  await until('document.querySelectorAll(".work-row").length===3');
  await js('document.querySelector(".work-row").click()');
  await until('document.querySelector("#message-input")');
  await js('document.querySelector("#tab-work").click()');
  await until('document.querySelector("#tool-panel-work .wd-provenance")');
  await js('window.gallery.ready()');await until('document.querySelector(".composer-footnote").textContent.includes("会话已连接")');await js('window.gallery.conversation()');await until('document.querySelector(".message.assistant")');
  await shot('workbench-light');await click('切换深色外观');await shot('workbench-dark');await click('切换浅色外观');
  await js('document.querySelector("#tab-preview").click()');await until('document.querySelectorAll(".file-list-row:not(:disabled)").length===2');
  await click('预览文件 architecture.md');await until('document.querySelector("#tool-panel-preview [data-streamdown=mermaid-block]")');await js('document.querySelector("#tool-panel-preview [data-streamdown=mermaid-block]").scrollIntoView({block:"center"})');await until('document.querySelector("#tool-panel-preview [data-streamdown=mermaid-block] svg[aria-roledescription]")');await js('document.querySelector("#tool-panel-preview").scrollTop=0');await click('展开阅读文件');await until('document.querySelector(".reading-modal .markdown-engine")');await shot('file-preview');await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await until('!document.querySelector(".reading-modal")');
  await click('打开知识库');await until('document.querySelectorAll(".knowledge-row").length===4');await js('document.querySelector(".knowledge-row").click()');
  await until('document.querySelector(".knowledge-reader [data-streamdown=mermaid-block]")');await js('document.querySelector(".knowledge-reader [data-streamdown=mermaid-block]").scrollIntoView({block:"center"})');await until('document.querySelector(".knowledge-reader [data-streamdown=mermaid-block] svg[aria-roledescription]")');await js('document.querySelector(".knowledge-reader").scrollTop=0');await shot('knowledge');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,screenshots:fs.readdirSync(out).filter(f=>f.endsWith('.png')),data:'synthetic demonstration only'}));
 }catch(e){app.exitCode=1;console.error(e.stack);console.error(errors);console.error(await js('document.body.innerText.slice(-2500)').catch(()=>''));}
 finally{clearTimeout(timer);app.exit(app.exitCode||0);}
});
