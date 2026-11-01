// Production renderer + isolated synthetic preload. Never connects real services.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-workspace-files-')));
const out=path.resolve(__dirname,'../.impeccable/review/git-workspace');
let window;const js=code=>window.webContents.executeJavaScript(code),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){const end=Date.now()+18000;while(Date.now()<end){if(await js('Boolean('+code+')'))return;await pause(60);}throw Error('Timeout '+code);}
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const mode=name=>js(`Array.from(document.querySelectorAll('.workspace-files:not([hidden]) .wf-views button')).find(b=>b.textContent.startsWith(${JSON.stringify(name)})).click()`);
async function shot(name){await until('document.querySelector("#workspace-tab-files").getAttribute("aria-selected")==="true"&&document.querySelector(".workspace-files:not([hidden])")?.getClientRects().length');await js('document.fonts.ready');await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),'page overflow');fs.writeFileSync(path.join(out,name+'.png'),(await window.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>app.exit(2),160000),errors=[],checks=[];
 try{
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,running:true,data:'synthetic offline fixture'}));
  window=new BrowserWindow({width:1440,height:960,useContentSize:true,show:false,webPreferences:{preload:path.join(__dirname,'workspace-files-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  window.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  await window.loadFile(path.resolve(__dirname,'../dist/renderer/index.html'));await until('document.querySelectorAll(".work-row").length===3');
  await click('.work-row');await until('document.querySelector("#message-input")');
  await js(`(()=>{const e=document.querySelector('#message-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'保留我的对话草稿');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('#workspace-tab-files');await until('document.querySelector(".workspace-files:not([hidden]) .file-list-row")');
  assert.equal(await js('document.querySelector("#tools-panel").getClientRects().length'),0);
  await click('.workspace-files:not([hidden]) button[aria-label="预览文件 SESSION.md"]');await until('document.querySelector(".workspace-files:not([hidden]) .reader-body")');
  await js(`(()=>{const e=document.querySelector('.workspace-files:not([hidden]) .reader-body');e.scrollTop=180;e.dispatchEvent(new Event('scroll',{bubbles:true}));})()`);
  await shot('browse-desktop');checks.push('Full-width file tab and real shared reader');
  await mode('改动');await until('document.querySelectorAll(".workspace-files:not([hidden]) .wf-file-row").length===3');
  await click('.workspace-files:not([hidden]) .wf-file-row');await until('document.querySelector(".wf-diff")?.textContent.includes("app_staged")');
  assert.ok(await js('document.querySelector(".wf-views [aria-selected=true]").textContent.includes("2")'),'distinct path count');
  await js(`Array.from(document.querySelectorAll('.wf-change-group')).find(g=>g.querySelector('h3')?.textContent.includes('未暂存')).querySelector('button').click()`);await until('document.querySelector(".wf-diff")?.textContent.includes("app_unstaged")');
  await shot('changes-desktop');checks.push('Reusable diff, separate staged/unstaged scopes and unique path count');
  await js(`Array.from(document.querySelectorAll('.wf-list>.wf-scope button,.wf-list .wf-scope button')).find(b=>b.textContent==='登记基线').click()`);await until('document.querySelector(".wf-diff")?.textContent.includes("app_baseline")');
  assert.equal(await js('window.workspaceFixture.stats().calls.filter(c=>c.action==="diff").at(-1).options.file'),'');checks.push('Baseline comparison clears a previous file filter');
  await js(`Array.from(document.querySelectorAll('.wf-list .wf-scope button')).find(b=>b.textContent==='未暂存').click()`);
  await mode('历史');await until('document.querySelector(".wf-commit-row")');await click('.wf-commit-row');await until('document.querySelector(".wf-diff")?.textContent.includes("const commit")');await shot('history-desktop');
  await mode('分支');await until('document.querySelector(".wf-commit-row")');await click('.wf-commit-row');await until('document.querySelector(".wf-diff")?.textContent.includes("const compare")');
  await mode('Worktree');await until('document.querySelectorAll(".wf-worktrees article").length===2');await shot('worktrees-desktop');checks.push('History, branch comparison and worktree listing');
  await mode('浏览');await until('document.querySelector(".workspace-files:not([hidden]) .reader-body")?.scrollTop>100');
  await click('#workspace-tab-chat');await until('document.querySelector("#message-input").getClientRects().length');assert.equal(await js('document.querySelector("#message-input").value'),'保留我的对话草稿');
  await click('#workspace-tab-files');checks.push('Reader position and conversation draft survive tab switches');
  await js(`Array.from(document.querySelectorAll('.workspace-files:not([hidden]) .wf-reader-heading button')).find(b=>b.textContent.includes('在对话中讨论')).click()`);await until('document.querySelector("#workspace-tab-chat").getAttribute("aria-selected")==="true"');
  assert.ok(await js('document.querySelector("#message-input").value.includes("文件/范围：SESSION.md")'));assert.ok(await js('document.querySelector("#message-input").value.includes("保留我的对话草稿")'));await click('#workspace-tab-files');checks.push('File discussion appends a bounded excerpt to the existing draft without sending');
  await js('document.querySelectorAll(".work-row")[2].click()');await until('document.querySelector(".workspace-header").textContent.includes("remote-lucyna")');await click('#workspace-tab-files');await until('document.querySelector(".workspace-files:not([hidden]) .wf-notice")?.textContent.includes("此主机版本尚不支持")');
  assert.equal(await js('document.querySelector(".workspace-files:not([hidden]) .reader-body")'),null);checks.push('Same-root SSH Work cannot inherit local files');
  await js('document.querySelectorAll(".work-row")[0].click()');await until('document.querySelector(".workspace-files:not([hidden]) .file-list-row")');await mode('改动');await until('document.querySelector(".wf-file-row")');await click('.wf-file-row');await until('document.querySelector(".wf-diff")');
  for(const theme of ['blue','classic','folio','pixel'])for(const appearance of ['light','dark']){
    await js(`(()=>{const e=document.querySelector('select[aria-label="视觉主题"]');e.value=${JSON.stringify(theme)};e.dispatchEvent(new Event('change',{bubbles:true}));if(document.documentElement.dataset.theme!==${JSON.stringify(appearance)})document.querySelector('button[aria-label="'+(document.documentElement.dataset.theme==='dark'?'切换浅色外观':'切换深色外观')+'"]').click();})()`);
    await until(`document.documentElement.dataset.visualTheme===${JSON.stringify(theme)}&&document.documentElement.dataset.theme===${JSON.stringify(appearance)}`);await shot(theme+'-'+appearance);
  }
  checks.push('Four visual themes in light and dark');
  for(const [width,height] of [[960,900],[390,844]]){
    window.setContentSize(width,height);await until('Math.abs(innerWidth-'+width+')<=2');await shot('width-'+width);
    await click('.workspace-files:not([hidden]) .wf-mobile-controls button');await until('document.querySelector(".workspace-files:not([hidden]) .wf-list").getClientRects().length');
    await click('.workspace-files:not([hidden]) .wf-file-row');await until('document.querySelector(".workspace-files:not([hidden]) .wf-reader").getClientRects().length');
  }
  checks.push('960px and 390px list/content navigation');
  await mode('Worktree');await until('document.querySelectorAll(".workspace-files:not([hidden]) .wf-worktrees article").length===2');assert.equal(await js('document.querySelector(".workspace-files:not([hidden]) .wf-mobile-controls")'),null);await shot('worktrees-390');checks.push('Narrow Worktree view has no inapplicable file-list control');
  const stats=await js('window.workspaceFixture.stats()');assert.equal(stats.starts,0,'browsing must not start OMP');assert.ok(!stats.calls.some(c=>/stage|commit|push|fetch/.test(c.action||'')&&c.action!=='commit'),'no mutation APIs');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks,errors,data:'synthetic offline fixture',starts:stats.starts},null,2));console.log(JSON.stringify({passed:true,checks}));
 }catch(e){console.error(e.stack);console.error(errors);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:e.stack,checks,errors},null,2));if(window)console.error(await js('document.body.innerText.slice(-2500)').catch(()=>''));app.exitCode=1;}
 finally{clearTimeout(timer);app.exit(app.exitCode||0);}
});
