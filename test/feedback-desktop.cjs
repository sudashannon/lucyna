// Real Electron windows/preload/settings/player, isolated profile and OMP event replay.
// System audio is muted during automation; this verifies decoding/playback, not hearing.
const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const out=path.resolve('.runtime/feedback-desktop-'+Date.now());fs.mkdirSync(out,{recursive:true});
require('./desktop-log.cjs').installDesktopLog(out);app.setPath('userData',path.join(out,'profile'));app.commandLine.appendSwitch('mute-audio');app.disableHardwareAcceleration();
const {FeedbackController}=require('../src/feedback/controller.cjs'),{PetController}=require('../src/pet/controller.cjs');
const {defaults}=require('../src/client-settings.cjs');
let win,feedback,pet;const errors=[],checks=[],plays=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
async function until(fn,label,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(40);}throw Error('Timeout: '+label);}
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const select=(selector,value)=>js(`{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));}`);
const button=label=>js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
const getPlaying=()=>feedback.player.webContents.executeJavaScript('({...document.body.dataset})');
async function shot(name){fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
function send(id,type,extra={}){const event={clientSessionId:id,type,workRoot:'/demo/work',...extra};pet.ingest(event);pet.publish();}
function pass(message){checks.push(message);console.log('PASS '+message);}
app.whenReady().then(async()=>{
 const timeout=setTimeout(()=>app.exit(2),90000);
 try{
  win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{preload:path.resolve('src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  pet=new PetController({directory:app.getPath('userData'),getMain:()=>win,getSessions:()=>({list:()=>[]}),onQuit:()=>{},onState:state=>feedback?.observe(state)});await pet.init();
  feedback=new FeedbackController({directory:app.getPath('userData'),getMain:()=>win,onChange:settings=>{pet.feedbackReducedMotion=settings.reducedMotion;pet.schedule();}});await feedback.init();
  const play=feedback.play.bind(feedback);feedback.play=async(batch,preview)=>{plays.push({kind:batch.kind,count:batch.count,preview:!!preview});return play(batch,preview);};
  const handle=(name,fn)=>ipcMain.handle(name,(e,...args)=>{assert.equal(e.sender,win.webContents);return fn(...args);});
  handle('feedback:get',()=>feedback.snapshot());handle('feedback:settings',patch=>feedback.save(patch));handle('feedback:preview',input=>feedback.preview(input));handle('feedback:stop-preview',()=>feedback.stopPreview());
  handle('pet:get',()=>pet.snapshot());handle('pet:settings',patch=>pet.save(patch));handle('pet:context',context=>{pet.context(context);feedback.context(context);});
  handle('settings:get',()=>({settings:defaults(),storage:out,workspace:{distro:'test',user:'fixture',root:'/demo'}}));
  handle('works:list',()=>[{root:'/demo/work',name:'feedback-check',kind:'work'}]);handle('omp:list',()=>[]);handle('session:list',()=>({sessions:[],managed:[]}));handle('work:read',()=>'# Work\n\nIsolated feedback verification.');handle('work:details',()=>({root:'/demo/work',name:'feedback-check',content:'# Work',issues:[],warnings:[],members:[],assets:[]}));handle('work:run',()=>[]);
  await win.loadFile(path.resolve('dist/renderer/index.html'));await until(()=>js('!!document.querySelector("button[aria-label=设置]")'),'app loaded');
  await click('button[aria-label=设置]');await until(()=>js('!!document.querySelector("select[aria-label=音效风格]")'),'feedback settings');
  assert.equal(pet.settings.enabled,false);assert.equal(feedback.player,undefined);
  await select('select[aria-label=音效风格]','pixel');await click('button[aria-label=试听完成]');await until(async()=>feedback.player&&(await getPlaying()).style==='pixel','pixel decoded without pet');
  await until(()=>js('!document.querySelector("button[aria-label=试听完成]").disabled'),'preview ends');
  await select('select[aria-label=音效风格]','soft');await click('button[aria-label=试听待回复]');await until(async()=>(await getPlaying()).style==='soft'&&(await getPlaying()).kind==='attention','soft decoded');
  await until(()=>js('!document.querySelector("button[aria-label=试听完成]").disabled'),'preview ends');
  await select('select[aria-label=音效风格]','pixel');await click('button[aria-label=试听中断]');await until(async()=>(await getPlaying()).kind==='error','error decoded');
  await click('input[aria-label=减少界面与桌宠动效]');await js('document.querySelector("#settings-feedback-title").scrollIntoView({block:"start"})');await pause(150);await shot('settings-light');
  win.setSize(960,720);await pause(150);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));await shot('settings-narrow');
  await button('保存');await until(()=>js('!document.querySelector("select[aria-label=音效风格]")'),'saved');
  assert.equal(feedback.snapshot().settings.style,'pixel');assert.equal(feedback.snapshot().settings.reducedMotion,true);assert.equal(await js('document.documentElement.dataset.reducedMotion'),'true');
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'feedback-settings.json'),'utf8')).style,'pixel');
  await click('button[aria-label=设置]');await until(()=>js('!!document.querySelector("select[aria-label=音效风格]")'),'reopened');assert.equal(await js('document.querySelector("select[aria-label=音效风格]").value'),'pixel');
  await select('select[aria-label=音效风格]','soft');await button('取消');assert.equal(feedback.snapshot().settings.style,'pixel');
  pass('Production settings preview both styles and all three cues; save persists, cancel preserves, pet can be disabled.');
  await click('button[aria-label="切换深色外观"]');await click('button[aria-label=设置]');await until(()=>js('!!document.querySelector("select[aria-label=音效风格]")'),'dark settings');await pause(150);await js('document.querySelector("#settings-feedback-title").scrollIntoView({block:"start"})');await pause(150);await shot('settings-dark');await button('取消');
  // Remove preview records; replay native events through production PetState.
  plays.length=0;feedback.policy.context({focused:false});
  for(let i=0;i<20;i++){send('parallel-'+i,'agent_start');send('parallel-'+i,'session_settled');}
  await until(()=>Promise.resolve(plays.length===1),'coalesced batch');assert.equal(plays[0].count,20);await pause(750);assert.equal(plays.length,1);
  assert.equal(feedback.player.isVisible(),false);assert.equal(pet.snapshot().notices.length,20);pass('20 native completion notices create exactly one hidden audio playback while preserving all visible notices.');
  const before=plays.length;feedback.policy.context({focused:true,visibleId:'visible'});send('visible','agent_start');send('visible','session_settled');send('abort','agent_start');send('abort','client_stopping');send('abort','prompt_result',{status:'aborted'});
  send('cancel-question','extension_ui_request',{method:'ask',id:'q'});send('cancel-question','question_resolved',{id:'q'});await pause(2200);assert.equal(plays.length,before);
  feedback.setBlocked('test',true);send('locked','agent_start');send('locked','session_settled');feedback.setBlocked('test',false);pet.publish();await pause(2200);assert.equal(plays.length,before);pass('Foreground completion, abort, answered question and lock/resume are silent without replay.');
  await pet.save({quiet:true});await feedback.preview({kind:'completed',style:'soft',volume:20});send('quiet','agent_start');pet.publish();assert.equal((await getPlaying()).playing,'true');send('quiet','session_settled');await pause(2200);assert.equal(plays.length,before+1);await pet.save({quiet:false});
  pass('Explicit preview works in quiet mode; automatic notices remain silent.');
  // Rendered CSS and OS reduced-motion both suppress nonessential transitions.
  assert.equal(await js('getComputedStyle(document.querySelector(".send-button")).transitionDuration'),'0s');
  await feedback.save({reducedMotion:false});await until(()=>js('document.documentElement.dataset.reducedMotion==="false"'),'live motion preference');
  await pet.save({reducedMotion:true});assert.equal(pet.snapshot().settings.reducedMotion,false,'unified preference overrides legacy pet toggle without rewriting it');await pet.save({reducedMotion:false});
  const dbg=win.webContents.debugger;dbg.attach('1.3');await dbg.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});assert.ok(parseFloat(await js('getComputedStyle(document.querySelector(".send-button")).transitionDuration'))<=.00001);
  await dbg.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  pass('Live reduced motion setting and OS preference both apply to production UI; narrow light/dark layouts do not overflow.');
  await click('.work-row');await until(()=>Promise.resolve(!!feedback.policy.visibleId),'work selected');
  const active=feedback.policy.visibleId,emit=(type,data={})=>win.webContents.send('omp:event',{clientSessionId:active,type,...data});
  await js('window.messageAnimations=0;document.addEventListener("animationstart",e=>{if(e.animationName==="feedback-message")window.messageAnimations++},true)');
  emit('agent_start');emit('message_update',{messageId:'streamed-answer',assistantMessageEvent:{type:'text_delta',delta:'开始检查。'}});
  await until(()=>js('!!document.querySelector(".message.assistant")'),'stream rendered');await pause(250);assert.equal(await js('window.messageAnimations'),1);
  emit('message_update',{messageId:'streamed-answer',assistantMessageEvent:{type:'text_delta',delta:'\n\n'+Array.from({length:180},(_,i)=>`第 ${i} 段 · 长文阅读和工作区滚动验收。`).join('\n\n')}});
  await until(()=>js('document.querySelector(".transcript").scrollHeight>3000'),'long transcript');await pause(300);await js('document.querySelector(".transcript").scrollTop=280');await pause(150);
  const top=await js('document.querySelector(".transcript").scrollTop');
  for(let i=0;i<40;i++)emit('message_update',{messageId:'streamed-answer',assistantMessageEvent:{type:'text_delta',delta:' 后续输出。'}});
  await pause(350);assert.equal(await js('window.messageAnimations'),1);assert.ok(Math.abs((await js('document.querySelector(".transcript").scrollTop'))-top)<3);
  assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
  await click('button[aria-label="收起侧栏 · Ctrl B"]');await click('button[aria-label="展开侧栏 · Ctrl B"]');assert.ok(await js('!!document.querySelector(".sidebar-resizer")'));
  emit('session_settled');await until(()=>js('document.querySelector(".run-activity")?.dataset.outcome==="completed"'),'completion displayed');dbg.detach();
  pass('A streaming answer animates only once across 40 updates; long-text reading position and sidebar controls remain usable.');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks,audio:'Real local WAV playback; OS output muted during automation; not a subjective listening test.',errors},null,2));console.log('ARTIFACTS '+out);clearTimeout(timeout);feedback.dispose();pet.dispose();win.destroy();app.exit(0);
 }catch(error){console.error(error);await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:error.stack,checks,errors},null,2));console.log('ARTIFACTS '+out);clearTimeout(timeout);feedback?.dispose();pet?.dispose();app.exit(1);}
});
