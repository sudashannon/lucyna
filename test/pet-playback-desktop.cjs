// Production companion rendering under occlusion, drag completion and repeated updates.
// Isolated profile and synthetic OMP events; never connects to a real session.
const electron=require('electron'),{app,BrowserWindow,screen}=electron;
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const out=path.resolve('.runtime','pet-playback-'+Date.now());fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));
require('./desktop-log.cjs').installDesktopLog(out);app.on('window-all-closed',()=>{});
const visible=process.argv.includes('--visible'),checks=[],errors=[],load=Module._load,controller=path.resolve('src/pet/controller.cjs');
class TestWindow extends BrowserWindow{
 constructor(options){super({...options,webPreferences:{...options.webPreferences,...(!visible?{offscreen:true}:{})}});this.shapeCalls=0;this.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});}
 showInactive(){if(visible)super.showInactive();}
 async loadFile(...args){await super.loadFile(...args);if(visible)await this.webContents.insertCSS('#badge{background:#fff3cd!important;border-color:#b78128!important}#badge::after{content:" · 隔离测试";color:#865500}');}
 setShape(rects){this.shapeCalls++;super.setShape(rects);}
 hookWindowMessage(message,callback){this.messageHooks||=new Map();this.messageHooks.set(message,callback);super.hookWindowMessage(message,callback);}
}
Module._load=function(name,parent,isMain){if(name==='electron'&&parent?.filename===controller)return{...electron,BrowserWindow:TestWindow};return load.call(this,name,parent,isMain);};
const {PetController}=require(controller);Module._load=load;
let pet;const wait=ms=>new Promise(r=>setTimeout(r,ms)),js=code=>pet.pet.webContents.executeJavaScript(code);
const state=()=>js('({...document.getElementById("animation").dataset,hidden:document.hidden})');
async function until(fn,label){const end=Date.now()+8000;while(Date.now()<end){if(await fn())return;await wait(50);}throw Error('Timeout: '+label);}
async function moving(label){const frames=new Set();for(let i=0;i<12;i++){frames.add((await state()).frame);await wait(150);}assert.ok(frames.size>=3,label+'; observed frames: '+[...frames]);}
function event(type,data={}){pet.ingest({clientSessionId:'playback',type,...data});pet.publish();}
app.whenReady().then(async()=>{
 const timeout=setTimeout(()=>app.exit(1),60000);
 try{
  pet=new PetController({directory:app.getPath('userData'),getMain:()=>null,getSessions:()=>({list:()=>[]}),onQuit:()=>{}});
  await pet.init();
  const display=screen.getPrimaryDisplay(),area=display.workArea,size=pet.size();
  // A deliberately visible test must be unmistakable and must not stack over
  // the user's normal companion in the bottom-right corner.
  await pet.save({enabled:true,animated:true,quiet:true,...(visible?{position:{displayId:display.id,right:Math.max(24,Math.round((area.width-size.width)/2)),bottom:Math.max(24,area.height-size.height-80)}}:{})});pet.pet.setTitle('Lucyna · 动画隔离验证');
  pet.pet.webContents.debugger.attach('1.3');await pet.pet.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await js('Object.defineProperty(document,"hidden",{configurable:true,get:()=>false});document.dispatchEvent(new Event("visibilitychange"))');
  event('ready');event('agent_start');await until(async()=>(await state()).clip==='working','working animation');
  await moving('working baseline');
  // Windows can mark an always-on-top transparent surface occluded. Native
  // user hide/lock is authoritative; Chromium page visibility must not freeze it.
  await js('Object.defineProperty(document,"hidden",{configurable:true,get:()=>true});document.dispatchEvent(new Event("visibilitychange"))');
  await moving('native-visible pet must animate despite document.hidden');
  checks.push('Native-visible working pet keeps changing frames when Chromium reports the page hidden.');
  pet.hide();await wait(100);const hidden=await state();await wait(700);assert.equal((await state()).paints,hidden.paints);
  pet.hidden=false;pet.reposition();pet.publish();await moving('native show resumes');
  await pet.save({reducedMotion:true});await until(async()=>(await state()).playing==='false','reduced motion');const still=await state();await wait(700);assert.equal((await state()).paints,still.paints);
  await pet.save({reducedMotion:false});await moving('motion preference resumes');
  checks.push('Explicit native hiding and reduced motion still pause; revealing resumes without a new model event.');
  await pet.pet.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await until(async()=>(await state()).pauseReason==='system-reduced-motion','OS reduction is explained');
  await pet.save({animationMode:'always',reducedMotion:true});await moving('pet-only override with OS and app reduction');
  assert.equal(pet.settings.reducedMotion,true);pet.suspend();await until(async()=>(await state()).pauseReason==='locked','always mode still pauses on lock');
  pet.locked=false;pet.reposition();pet.publish();await moving('always mode resumes after lock');
  await pet.save({animationMode:'system'});await until(async()=>(await state()).pauseReason==='app-reduced-motion','app reduction is explained');
  await pet.save({reducedMotion:false});await pet.pet.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await moving('return to inherited preferences');checks.push('Always-play explicitly overrides OS/app reduced motion for the pet only; follow mode and lock still work.');
  // A slow preference write must not keep the renderer in dragging state.
  pet.pet.emit('will-move',{},pet.pet.getBounds());await until(async()=>(await state()).playing==='false','drag pauses');
  const save=pet.preferences.save.bind(pet.preferences);let release;
  pet.preferences.save=()=>new Promise(resolve=>{release=resolve;});
  const finishing=pet.finishNativeMove();await moving('drag release resumes before preferences finish');release(pet.settings);await finishing;pet.preferences.save=save;
  checks.push('Drag completion resumes animation before position persistence finishes.');
  if(process.platform==='win32'){
   pet.pet.messageHooks.get(0x0231)();await until(async()=>(await state()).pauseReason==='dragging','native move loop');
   pet.pet.messageHooks.get(0x0232)();await moving('cancelled Windows drag resumes without moved');
   checks.push('Windows move-loop exit releases the pause even without a moved event.');
  }
  await js('Object.defineProperty(document,"hidden",{configurable:true,get:()=>false});document.dispatchEvent(new Event("visibilitychange"))');await wait(200);
  const calls=pet.pet.shapeCalls;
  for(let i=0;i<20;i++){event('message_update',{assistantMessageEvent:{type:i%2?'text_delta':'thinking_delta'}});await wait(100);}
  assert.equal(pet.pet.shapeCalls,calls,'animation frames must not mutate the native window shape');
  await moving('steady native region');checks.push('Streaming status and changing animation frames keep the same native window region.');
  event('extension_ui_request',{method:'ask',id:'q'});await until(async()=>(await state()).clip==='attention','attention');await wait(3600);assert.equal((await state()).playing,'false');
  event('question_resolved',{id:'q'});await moving('question resolved resumes working');event('prompt_result',{status:'completed'});await until(async()=>(await state()).clip==='completed','completed');await wait(2100);assert.ok(Number((await state()).frame)<4);
  checks.push('Attention settles intentionally, resolving it resumes working, and completion returns to idle.');
  fs.writeFileSync(path.join(out,'pet.png'),(await pet.pet.webContents.capturePage()).toPNG());
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,visible,checks,errors},null,2));console.log(JSON.stringify({passed:true,out,checks}));
 }catch(e){fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,visible,checks,error:e.stack,errors},null,2));console.error(e.stack);console.log(out);process.exitCode=1;}
 finally{clearTimeout(timeout);pet?.dispose();app.exit(process.exitCode||0);}
});
