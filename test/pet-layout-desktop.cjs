// Real Electron overlay rendering, isolated preferences, no OMP processes.
// Run with --force-device-scale-factor=1 / 1.25 / 1.5 / 2 for geometry coverage.
const electron=require('electron'),{app,BrowserWindow}=electron;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
const scale=app.commandLine.getSwitchValue('force-device-scale-factor')||'system';
const out=path.resolve('.runtime','pet-layout-'+scale);fs.mkdirSync(out,{recursive:true});
app.setPath('userData',path.join(out,'profile'));
const errors=[],checks=[];let pet;
class HiddenWindow extends BrowserWindow{
 constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}});this.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});}
 showInactive(){}
}
const load=Module._load,controller=path.resolve('src/pet/controller.cjs');
Module._load=function(name,parent,isMain){if(name==='electron'&&parent?.filename===controller)return{...electron,BrowserWindow:HiddenWindow};return load.call(this,name,parent,isMain);};
const {PetController}=require(controller);Module._load=load;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+10000;while(Date.now()<end){if(await fn())return;await pause(40);}throw Error('Timeout: '+label);}
const sprite=code=>pet.pet.webContents.executeJavaScript(code);
const bubble=code=>pet.bubble.webContents.executeJavaScript(code);
app.whenReady().then(async()=>{
 const timeout=setTimeout(()=>app.exit(1),45000);
 try{
  pet=new PetController({directory:app.getPath('userData'),getMain:()=>null,getSessions:()=>({list:()=>[]}),onQuit:()=>{}});await pet.init();
  await pet.save({enabled:true,appearance:'duo',size:'medium'});
  await until(()=>pet.nativeShape&&pet.shapeCount>10,'initial native region');
  const originalCount=pet.shapeCount;
  assert.equal(pet.setLayout({appearance:'duo',viewport:{width:999,height:999}}),false);
  assert.equal(pet.shapeCount,originalCount);checks.push('Stale native/renderer geometry is ignored without changing the region.');
  for(const appearance of ['cat','duo','cat','duo'])for(const size of ['small','large','medium']){
   await pet.save({appearance,size});
   await until(async()=>{
    const m=await sprite('({source:document.getElementById("character").getAttribute("src"),ready:document.getElementById("character").complete,width:innerWidth,height:innerHeight,label:document.getElementById("badge").textContent})');
    const b=pet.pet.getContentBounds();
    return m.source===`assets/${appearance==='cat'?'cat':'companions'}.png`&&m.ready&&Math.abs(m.width-b.width)<=3&&Math.abs(m.height-b.height)<=3&&m.label!=='桌宠暂不可用';
   },appearance+' '+size);
   await pause(120);assert.ok(pet.nativeShape&&pet.shapeCount>10);
  }
  checks.push('Twelve real overlay size/appearance transitions retain valid native regions.');
  for(let i=0;i<20;i++){
   pet.ingest({clientSessionId:'layout-'+i,type:'ready'});
   pet.ingest({clientSessionId:'layout-'+i,type:'extension_ui_request',method:'ask',id:'ask'});
  }
  await pet.action('inbox');await until(async()=>await bubble('document.querySelectorAll(".notice").length===20'),'inbox rows');
  const before=await bubble('(()=>{const list=document.getElementById("notices");list.scrollTop=300;window.testButton=list.querySelector("button");testButton.focus({preventScroll:true});return {scroll:list.scrollTop};})()');
  assert.ok(before.scroll>0);
  for(let i=0;i<10;i++){
   pet.ingest({clientSessionId:'layout-0',type:'message_update',assistantMessageEvent:{type:i%2?'text_delta':'thinking_delta'}});pet.publish();await pause(25);
  }
  const after=await bubble('({scroll:document.getElementById("notices").scrollTop,same:window.testButton===document.querySelector(".notice button"),focused:document.activeElement===window.testButton})');
  assert.equal(after.scroll,before.scroll);assert.ok(after.same&&after.focused);
  checks.push('Live phase updates preserve inbox scroll, button identity and keyboard focus.');
  pet.ingest({clientSessionId:'summary',type:'agent_start'});
  pet.ingest({clientSessionId:'summary',type:'tool_execution_end',toolCallId:'test-tool'});
  pet.ingest({clientSessionId:'summary',type:'message_end',message:{role:'assistant',content:[{type:'text',text:'构建和功能测试已通过，详细结果可在会话中查看。'.repeat(20)}]}});
  pet.ingest({clientSessionId:'summary',type:'session_settled'});
  await pet.save({privacy:false});await until(async()=>await bubble('!!document.querySelector(".result-excerpt")'),'visible result excerpt');
  assert.ok(await bubble('document.querySelector(".completion-stats").textContent.includes("1 次工具调用")'));
  assert.ok(await bubble('document.documentElement.scrollWidth<=innerWidth'));
  await bubble('document.querySelector(".result-excerpt").closest(".notice").scrollIntoView({block:"end"})');pet.bubble.webContents.invalidate();await pause(600);
  assert.ok(await bubble('(()=>{const row=document.querySelector(".result-excerpt").closest(".notice"),button=row.querySelector("button").getBoundingClientRect(),list=document.getElementById("notices").getBoundingClientRect();return button.top>=list.top&&button.bottom<=list.bottom})()'),'completion action remains fully visible');
  fs.writeFileSync(path.join(out,'completion.png'),(await pet.bubble.webContents.capturePage()).toPNG());
  await pet.save({privacy:true});await until(async()=>await bubble('!document.querySelector(".result-excerpt")'),'privacy hides excerpt');
  assert.ok(!await bubble('document.body.textContent.includes("构建和功能测试")'));
  checks.push('Completed notices show bounded visible answer and tool stats; privacy hides the excerpt.');
  await pet.save({quiet:true,reducedMotion:true});
  await until(async()=>await sprite('document.body.dataset.reduced==="true"'),'reduced motion');
  assert.equal(pet.snapshot().pendingCount,20);
  await pet.action('close-bubble');assert.equal(pet.snapshot().pendingCount,20);assert.equal(pet.bubble.isVisible(),false);
  checks.push('Quiet/reduced motion and dismiss preserve unresolved native questions.');
  // A single real overlay uses readable metadata even while result privacy is on.
  pet.model=new (require('../src/pet/state.cjs').PetState)();
  const root='/private/work/lucyna',send=(id,type,data={})=>pet.ingest({clientSessionId:id,workRoot:root,type,...data});
  send('background-task','session_connecting');send('background-task','ready');
  send('background-task','session_state',{sessionName:'修复会话草稿读取与恢复'});
  send('background-task','agent_start');send('background-task','tool_execution_end',{toolCallId:'one'});
  send('background-task','message_end',{message:{role:'assistant',content:'PRIVATE RESULT'}});send('background-task','session_settled');
  send('another-task','ready');send('another-task','session_metadata',{titleHint:'验证图片预览'});
  await pet.action('inbox');
  await until(async()=>await bubble('document.querySelectorAll(".notice").length===1&&document.querySelector(".notice strong").textContent==="修复会话草稿读取与恢复"'),'readable background label');
  assert.equal(await bubble('document.querySelector(".notice-workspace").textContent'),'lucyna');
  assert.ok(!await bubble('document.body.textContent.includes("PRIVATE RESULT")'));
  assert.ok(!await bubble('document.body.textContent.includes("/private/work")'));
  const labels=await bubble('Array.from(document.querySelector("#focus").options).map(o=>o.text)');
  assert.ok(labels.includes('lucyna · 验证图片预览'));assert.ok(labels.includes('lucyna · 修复会话草稿读取与恢复'));
  const visible=()=>bubble('(()=>{const row=document.querySelector(".notice"),button=row.querySelector("button").getBoundingClientRect(),list=document.getElementById("notices").getBoundingClientRect();return button.top>=list.top&&button.bottom<=list.bottom&&document.documentElement.scrollWidth<=innerWidth})()');
  assert.ok(await visible(),'readable notice actions fit without scrolling');
  pet.bubble.webContents.invalidate();await pause(400);fs.writeFileSync(path.join(out,'readable-notice.png'),(await pet.bubble.webContents.capturePage()).toPNG());
  send('background-task','session_state',{sessionName:'检查后台会话标题与跨工作区通知正确对应，保留草稿并验证历史恢复以及长标题显示'.repeat(4)});pet.publish();
  await until(async()=>await bubble('document.querySelector(".notice strong").textContent.startsWith("检查后台")'),'late native title update');
  assert.ok(await visible(),'two-line title leaves actions visible');
  assert.ok(await bubble('(()=>{const title=document.querySelector(".notice strong");return title.getBoundingClientRect().height<=parseFloat(getComputedStyle(title).lineHeight)*2+1})()'));
  pet.theme='dark';pet.publish();await until(async()=>await bubble('document.body.dataset.theme==="dark"'),'dark notification');
  pet.bubble.webContents.invalidate();await pause(300);fs.writeFileSync(path.join(out,'readable-notice-dark-long.png'),(await pet.bubble.webContents.capturePage()).toPNG());
  const navigated=[];pet.getMain=()=>({isDestroyed:()=>false,isMinimized:()=>false,show(){},focus(){},webContents:{isDestroyed:()=>false,isCrashed:()=>false,send:(type,payload)=>{if(type==='pet:navigate')navigated.push(payload.id);}}});
  await bubble('document.querySelector(".notice .primary").click()');
  await until(()=>navigated.length===1,'open named session');assert.deepEqual(navigated,['background-task']);
  checks.push('Private notifications retain work/title; long names fit, dropdowns disambiguate tasks and open targets the correct background session.');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,scale,checks,errors},null,2));console.log(JSON.stringify({passed:true,scale,checks}));
 }catch(e){fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,scale,checks,error:e.stack,errors},null,2));console.error(e.stack);process.exitCode=1;}
 finally{clearTimeout(timeout);pet?.dispose();app.exit(process.exitCode||0);}
});
