const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const rootPath=path.resolve(__dirname,'..'),options=JSON.parse(fs.readFileSync(process.argv.find(a=>a.startsWith('--options=')).slice(10),'utf8'));
const {createWorkDetails}=require('../src/work-details.cjs'),{createGitService}=require('../src/git-service.cjs');
const {execFileSync}=require('node:child_process');
const {listDirectory}=require('../src/file-browser.cjs');
const wslUnc=root=>'\\\\wsl.localhost\\Ubuntu-22.04'+root.replaceAll('/','\\');
const works=[{root:options.root,name:'Git 事务验收',kind:'work'}],listWorks=async()=>works;
const inspect=createWorkDetails({listWorks}),git=createGitService({listWorks,state:options.state});
const out=path.join(rootPath,'.impeccable/review/git-workspace-write');fs.mkdirSync(out,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-git-ui-')));app.disableHardwareAcceleration();
let win,starts=0;const checks=[],errors=[],pause=ms=>new Promise(r=>setTimeout(r,ms)),js=c=>win.webContents.executeJavaScript(c,true);
async function until(c){const end=Date.now()+25000;while(Date.now()<end){if(await js('Boolean('+c+')'))return;await pause(80);}throw Error('Timeout '+c);}
const click=s=>js(`document.querySelector(${JSON.stringify(s)}).click()`);
const present=s=>until(`document.querySelector(${JSON.stringify(s)})`);
const button=(selector,label)=>js(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
const mode=label=>js(`Array.from(document.querySelectorAll('.wf-views button')).find(b=>b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`);
const input=(label,value)=>js(`(()=>{const e=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
async function done(){await until('document.querySelector(".wf-operation")?.textContent.includes("完成")');await until('document.querySelector(".wf-git-controls").getAttribute("aria-busy")==="false"');}
async function shot(name){if(name!=='failure')await until('!document.querySelector(".wf-list .wf-loading,.wf-reader .wf-loading") && document.querySelector(".wf-git-controls").getAttribute("aria-busy")==="false"');await js('document.fonts.ready');await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{const timer=setTimeout(()=>app.exit(2),170000);try{
 ipcMain.handle('fixture:works',()=>works);ipcMain.handle('fixture:document',()=>fs.readFileSync(path.join(wslUnc(options.root),'SESSION.md'),'utf8'));
 ipcMain.handle('fixture:details',(_,root)=>inspect(root));ipcMain.handle('fixture:read',(_,root,member,action,o)=>inspect(root,member,action,o));
 ipcMain.handle('fixture:git',(_,root,member,action,o)=>git(root,member,action,o));
 ipcMain.handle('fixture:files',async(_,root,dir,o)=>{const base=fs.realpathSync(wslUnc(root)),listing=await listDirectory(base,dir,o);return {...listing,entries:listing.entries.map(e=>({...e,path:path.relative(base,e.path).split(path.sep).join('/')}))};});
 ipcMain.handle('fixture:preview',(_,root,file)=>({kind:'text',name:path.basename(file),path:file,content:fs.readFileSync(file.startsWith('\\')?file:path.join(wslUnc(root),file),'utf8')}));
 ipcMain.handle('fixture:start',()=>{starts++;throw Error('UI acceptance must not start OMP');});
 win=new BrowserWindow({width:1440,height:960,show:false,webPreferences:{preload:path.join(__dirname,'workspace-git-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 await win.loadFile(path.join(rootPath,'dist/renderer/index.html'));await until('document.querySelector(".work-row")');await click('.work-row');await click('#workspace-tab-files');await mode('改动');await until('document.querySelector(".wf-file-row")');await click('.wf-file-row');await until('document.querySelector(".wf-diff")');await until('!Array.from(document.querySelectorAll(".wf-file-actions button")).find(b=>b.textContent.includes("暂存整个文件"))?.disabled');
 await button('.wf-file-actions button','选择块或行');await until('document.querySelectorAll(".wf-patch-line").length>2');await click('.wf-patch-selection legend input');await button('.wf-patch-selection button','暂存选中行 · '+await js('document.querySelectorAll(".wf-patch-line input:checked").length'));await done();checks.push('Rendered hunk/line selection stages a server-generated patch in real WSL');
 await button('.wf-file-actions button','暂存整个文件');await done();await input('Git 提交信息','从 Lucyna 完成审查与提交');await shot('commit-ready');
 const signing=(key,value)=>execFileSync('wsl.exe',[...require('../src/runtime-config.cjs').wslPrefix,'--exec','git','-C',options.root+'/repos/app','config',key,value],{windowsHide:true});
 signing('commit.gpgsign','true');signing('gpg.program','/bin/false');await button('.wf-commit-form button','提交暂存内容');await until('document.querySelector(".wf-operation")?.textContent.includes("失败")');assert.equal(await js('document.querySelector(".wf-commit-form textarea").value'),'从 Lucyna 完成审查与提交');await shot('commit-failed');signing('commit.gpgsign','false');checks.push('Signing failure preserves the commit draft and staged content');
 await button('.wf-commit-form button','提交暂存内容');await done();await until('document.querySelector(".wf-commit-form textarea").value===""');checks.push('Commit preserves normal Git behavior and clears draft only on confirmed success');
 await click('.wf-sync summary');await until('document.querySelector("select[aria-label=Git同步远端]")||document.querySelector(".wf-sync select option")');await button('.wf-sync button','获取');await done();await button('.wf-sync button','推送');await done();checks.push('Fetch and explicit-target push complete and show recorded results');
 await mode('分支');await click('.wf-write-section summary');await input('新分支名称','ui-next');await button('.wf-management-form button','从 HEAD 创建');await done();await until('Array.from(document.querySelectorAll(".wf-commit-row")).some(e=>e.textContent.includes("ui-next"))');await js('Array.from(document.querySelectorAll(".wf-commit-row")).find(e=>e.textContent.includes("ui-next")).click()');await button('.wf-management-form button','切换并更新 Work 登记');await done();await until('document.querySelector("input[aria-label=推送目标分支]").value==="ui-next"');await shot('branches');checks.push('Branch switching updates Work registration and follows the default push target');
 await mode('Worktree');await click('.wf-write-section summary');await input('工作树成员名称','second');await input('工作树新分支','ui-second');await button('.wf-management-form button','创建并登记');await done();await until('document.querySelectorAll(".wf-repo-controls option").length===2');await shot('worktrees');checks.push('Worktree creation appears in the registered member selector');
 await mode('浏览');for(const name of ['repos','app']){const selector='button[aria-label="打开目录 '+name+'"]';await present(selector);await click(selector);}await present('button[aria-label="预览文件 a.txt"]');await click('button[aria-label="预览文件 a.txt"]');await until('document.querySelector(".reader-body")');
 await mode('Worktree');await click('.wf-write-section summary');await input('工作树成员名称','renamed');await button('.wf-management-form button','当前成员改名并移动');await until('document.querySelector(".wf-repo-controls select").value==="renamed"');await mode('浏览');await until('document.querySelector(".wf-reader-heading")?.textContent.includes("repos/renamed/a.txt")');checks.push('Moving a member retains its open file under the new registered path');
 await mode('Worktree');await click('.wf-write-section summary');await button('.wf-management-form button','移除当前成员…');await until('document.querySelector(".wf-remove-confirm")');await button('.wf-remove-confirm button','确认移除 renamed');await until('document.querySelector(".wf-repo-controls select").value==="second"');checks.push('Confirmed removal selects the remaining registered member');
 await mode('改动');
 if(await js('document.querySelector(".wf-sync").open'))await click('.wf-sync summary');
 for(const theme of ['blue','classic','folio','pixel'])for(const appearance of ['light','dark']){
  await js(`(()=>{const e=document.querySelector('select[aria-label="视觉主题"]');e.value=${JSON.stringify(theme)};e.dispatchEvent(new Event('change',{bubbles:true}));if(document.documentElement.dataset.theme!==${JSON.stringify(appearance)})document.querySelector('button[aria-label="'+(document.documentElement.dataset.theme==='dark'?'切换浅色外观':'切换深色外观')+'"]').click();})()`);await pause(100);await shot(theme+'-'+appearance);
 }
 for(const [width,height]of [[960,900],[390,844]]){win.setContentSize(width,height);await until('Math.abs(innerWidth-'+width+')<=2');await shot('width-'+width);}
 checks.push('Four themes, light/dark and narrow layouts keep write controls within the workspace');assert.equal(starts,0);assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks,starts,data:'temporary real WSL repositories, local bare remote; no model'},null,2));console.log(JSON.stringify({passed:true,checks,starts,output:out}));clearTimeout(timer);app.exit(0);
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:error.stack,checks,errors},null,2));console.error(error.stack);clearTimeout(timer);app.exit(1);}});
