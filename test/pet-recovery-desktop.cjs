// Isolated Electron lifecycle regression. No real OMP, user profile or restart.
const electron=require('electron'),{app,BrowserWindow,screen,ipcMain}=electron;
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const out=path.resolve('.runtime','pet-recovery-'+Date.now());fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));
require('./desktop-log.cjs').installDesktopLog(out);
// The real app keeps its workbench alive during a pet-only rebuild. This
// isolated harness creates that workbench later, so keep the same lifetime.
app.on('window-all-closed',()=>{});
const load=Module._load,controller=path.resolve('src/pet/controller.cjs'),checks=[],errors=[];
class HiddenWindow extends BrowserWindow{
 constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true}});this.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});}
 showInactive(){}
 show(){}
}
Module._load=function(name,parent,isMain){if(name==='electron'&&parent?.filename===controller)return{...electron,BrowserWindow:HiddenWindow};return load.call(this,name,parent,isMain);};
const {PetController}=require(controller);Module._load=load;
let pet,main;const requests=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
const js=code=>pet.pet.webContents.executeJavaScript(code);
async function until(fn,label){const end=Date.now()+10000;while(Date.now()<end){if(await fn())return;await wait(50);}throw Error('Timeout: '+label);}
const pixels=()=>js(`(()=>{const c=document.getElementById('animation'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<p.length;i+=4)if(p[i]>16)n++;return n})()`);
const clear=()=>js('document.getElementById("animation").width=document.getElementById("animation").width');
const ready=()=>until(async()=>pet.nativeShape&&await pixels()>1000,'painted native sprite');
app.whenReady().then(async()=>{
 const timeout=setTimeout(()=>app.exit(1),60000);
 try{
  pet=new PetController({directory:app.getPath('userData'),getMain:()=>main,getSessions:()=>({list:()=>[{id:'completed'},{id:'pending'}],request:async(id,command)=>{assert.equal(command,'get_state');requests.push({id,command});}}),onQuit:()=>{throw Error('Recovery must not quit');}});
  await pet.init();await pet.save({enabled:true,animated:true,reducedMotion:true,quiet:true});await ready();
  for(const id of ['completed','pending']){pet.ingest({clientSessionId:id,type:'ready'});pet.ingest({clientSessionId:id,type:'agent_start'});}
  pet.ingest({clientSessionId:'completed',type:'prompt_result',status:'completed'});
  pet.ingest({clientSessionId:'pending',type:'extension_ui_request',method:'ask',id:'question'});pet.publish();
  const model=pet.model,sessions=JSON.stringify([...model.sessions]),notices=JSON.stringify([...model.notices]);
  await js('Object.defineProperty(document,"hidden",{configurable:true,get:()=>false});true');
  await clear();assert.equal(await pixels(),0);await js('document.dispatchEvent(new Event("visibilitychange"))');await until(async()=>await pixels()>1000,'visibility repaint');
  assert.equal(await js('document.getElementById("animation").dataset.playing'),'false');
  checks.push('Cleared canvas repaints on visibility restoration even with reduced motion; animation stays paused.');
  await js('document.getElementById("animation").dispatchEvent(new Event("contextlost"))');
  assert.equal(await js('document.getElementById("animation").hidden'),true);
  assert.equal(await js('getComputedStyle(document.getElementById("character")).visibility'),'visible');
  await clear();await js('document.getElementById("animation").dispatchEvent(new Event("contextrestored"))');await until(async()=>await pixels()>1000,'context restoration');
  checks.push('Canvas context loss shows the static character and context restoration redraws the animation.');
  pet.hide();await wait(100);await clear();pet.hidden=false;pet.publish();await until(async()=>await pixels()>1000,'hidden snapshot recovery');
  checks.push('Hide/show repaints without requiring another OMP event.');
  pet.suspend();pet.suspend();await wait(100);await clear();const beforeWake=pet.pet;
  const wake=pet.resume();assert.equal(pet.resume(),wake);await wake;await ready();
  assert.ok(beforeWake.isDestroyed());assert.equal(pet.model,model);assert.equal(JSON.stringify([...model.sessions]),sessions);assert.equal(JSON.stringify([...model.notices]),notices);
  assert.deepEqual(requests,[{id:'completed',command:'get_state'},{id:'pending',command:'get_state'}]);
  const afterWake=pet.pet;await pet.resume();assert.equal(pet.pet,afterWake);assert.equal(requests.length,2);
  checks.push('Wake recreates the native companion surfaces once across duplicate resume/unlock callbacks, preserves sessions and notices, and only queries existing OMP state.');
  pet.hide();pet.suspend();await pet.resume();assert.equal(pet.pet,afterWake);assert.equal(pet.hidden,true);
  pet.hidden=false;pet.publish();pet.suspend();const interruptedWake=pet.resume();pet.suspend();await interruptedWake;
  assert.equal(pet.locked,true);assert.equal(pet.pet,afterWake);
  await pet.resume();await ready();assert.ok(afterWake.isDestroyed());
  checks.push('Wake respects a user-hidden pet and a new lock arriving before queued recovery; the next unlock can still recover.');
  main=new HiddenWindow({width:600,height:400,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.resolve('src/preload.cjs')}});await main.loadURL('data:text/html,<title>Isolated recovery test</title>');
  const display=screen.getAllDisplays().find(d=>d.id!==screen.getPrimaryDisplay().id)||screen.getPrimaryDisplay();
  main.setBounds({x:display.workArea.x+20,y:display.workArea.y+20,width:600,height:400});
  pet.hide();const original=pet.pet;await pet.recover({resetPosition:true,reveal:true});await ready();
  assert.ok(original.isDestroyed());assert.equal(pet.hidden,false);assert.equal(pet.settings.position.displayId,display.id);
  const b=pet.pet.getBounds(),a=display.workArea;assert.ok(b.x>=a.x&&b.y>=a.y&&b.x+b.width<=a.x+a.width&&b.y+b.height<=a.y+a.height);
  assert.equal(main.isDestroyed(),false);assert.equal(pet.model,model);assert.equal(JSON.stringify([...model.sessions]),sessions);assert.equal(JSON.stringify([...model.notices]),notices);
  checks.push('Explicit recovery recreates only pet windows and places them on the workbench display; sessions and pending notices are unchanged.');
  fs.writeFileSync(path.join(out,'restored.png'),(await pet.pet.webContents.capturePage()).toPNG());
  // Crash the real isolated renderer, then prove the recovery is bounded.
  for(let i=0;i<2;i++){
   const old=pet.pet;old.webContents.forcefullyCrashRenderer();
   await until(()=>pet.pet&&pet.pet!==old&&!pet.automaticRecovery,'renderer recreated');await ready();
  }
  const last=pet.pet;last.webContents.forcefullyCrashRenderer();await until(()=>!!pet.preferences.warning?.includes('连续异常'),'crash-loop limit');
  assert.equal(pet.pet,last);assert.equal(pet.recoveryAttempts.length,2);
  assert.equal(pet.model,model);assert.equal(JSON.stringify([...model.sessions]),sessions);assert.equal(JSON.stringify([...model.notices]),notices);
  await pet.recover({reveal:true});await ready();assert.equal(pet.preferences.warning,'');
  checks.push('Two real renderer crashes recover automatically; repeated crashes stop retrying, and manual recovery remains available without touching OMP.');
  let recoveries=0,ompCalls=0;const ui=code=>main.webContents.executeJavaScript(code,true);
  const handle=(name,fn)=>ipcMain.handle(name,(event,...args)=>{assert.equal(event.sender,main.webContents);return fn(...args);});
  handle('pet:get',()=>pet.snapshot());handle('pet:context',()=>{});handle('pet:settings',patch=>pet.save(patch));
  handle('pet:reset-position',()=>{recoveries++;return pet.recover({resetPosition:true,reveal:true});});
  handle('feedback:get',()=>({settings:require('../src/feedback/settings.cjs').defaults(),warning:''}));
  handle('feedback:stop-preview',()=>{});
  handle('settings:get',()=>({settings:require('../src/client-settings.cjs').defaults(),storage:out,workspace:{distro:'test',user:'fixture',root:'/demo'}}));
  handle('works:list',()=>[]);handle('omp:list',()=>[]);
  for(const name of ['omp:start','omp:request','omp:close'])handle(name,()=>{ompCalls++;throw Error('Unexpected OMP operation');});
  main.setSize(1100,820);await main.loadFile(path.resolve('dist/renderer/index.html'));
  await until(()=>ui('!!document.querySelector("button[aria-label=设置]")'),'settings entry');
  await ui('document.querySelector("button[aria-label=设置]").click()');
  await until(()=>ui('!!document.querySelector("input[aria-label=启用桌面伙伴]")'),'pet settings');
  const privacyLabel='隐藏结果摘录和完整路径（保留工作区与会话名称）';
  await ui(`document.querySelector('input[aria-label="${privacyLabel}"]').click()`);
  const beforeUI=pet.pet;pet.hide();
  await ui('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="重新显示并重置位置").click()');
  await until(()=>ui('document.querySelector(".pet-settings [role=status]")?.textContent.includes("已执行恢复")'),'settings recovery completed');
  await ready();assert.equal(recoveries,1);assert.ok(beforeUI.isDestroyed());assert.equal(pet.hidden,false);
  assert.equal(await ui(`document.querySelector('input[aria-label="${privacyLabel}"]').checked`),false);
  assert.equal(pet.settings.privacy,true);assert.equal(ompCalls,0);
  await ui('document.getElementById("settings-pet-title").scrollIntoView({block:"start",behavior:"instant"})');
  await until(()=>ui('(()=>{const h=document.getElementById("settings-pet-title").getBoundingClientRect(),b=document.querySelector(".settings-body").getBoundingClientRect();return h.top>=b.top-2&&h.top<b.bottom})()'),'pet settings visible');
  main.webContents.invalidate();await wait(150);
  fs.writeFileSync(path.join(out,'settings-recovery.png'),(await main.webContents.capturePage()).toPNG());
  await ui('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="取消").click()');
  assert.equal(pet.settings.privacy,true);assert.equal(JSON.stringify([...model.notices]),notices);
  checks.push('Production settings button recovers immediately without Save, preserves unsaved options on screen and leaves OMP untouched. Cancel does not apply those options.');
  await pet.save({enabled:false});await pet.recover({resetPosition:true,reveal:true});pet.suspend();await pet.resume();assert.equal(pet.pet,null);assert.equal(pet.settings.enabled,false);
  await pet.diagnosticWrite;const trace=JSON.parse(fs.readFileSync(pet.diagnosticFile,'utf8'));assert.ok(trace.some(e=>e.reason==='renderer-gone'));assert.ok(trace.length<=30);
  checks.push('Recovery respects the disabled preference; bounded local diagnostics record window lifecycle only.');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,out,checks}));
 }catch(e){fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,checks,error:e.stack,errors},null,2));console.error(e.stack);console.log(out);process.exitCode=1;}
 finally{clearTimeout(timeout);pet?.dispose();main?.destroy();app.exit(process.exitCode||0);}
});
