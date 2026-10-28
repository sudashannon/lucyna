// Production sprite rendering with isolated preferences and synthetic native events.
const electron=require('electron'),{app,BrowserWindow}=electron,Module=require('node:module'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto'),out=path.resolve('.runtime','pet-animation-'+randomUUID());fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));
const errors=[],results=[],load=Module._load,controller=path.resolve('src/pet/controller.cjs');let pet;
class HiddenWindow extends BrowserWindow{constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true}});this.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});}showInactive(){}}
Module._load=function(name,parent,isMain){if(name==='electron'&&parent?.filename===controller)return{...electron,BrowserWindow:HiddenWindow};return load.call(this,name,parent,isMain);};
const {PetController}=require(controller);Module._load=load;
const wait=ms=>new Promise(r=>setTimeout(r,ms)),js=code=>pet.pet.webContents.executeJavaScript(code);
async function until(fn,label,ms=8000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await wait(50);}throw Error('Timeout '+label);}
const state=()=>js('({...document.getElementById("animation").dataset,hidden:document.hidden,canvasHidden:document.getElementById("animation").hidden})');
function event(type,data={}){pet.ingest({clientSessionId:'animation-test',type,...data});pet.publish();}
app.whenReady().then(async()=>{
 const timeout=setTimeout(()=>app.exit(1),60000);
 try{
  pet=new PetController({directory:app.getPath('userData'),getMain:()=>null,getSessions:()=>({list:()=>[]}),onQuit:()=>{}});await pet.init();await pet.save({enabled:true,animated:true});
  await until(async()=>!(await state()).canvasHidden&&pet.nativeShape,'atlas visible');
  // Offscreen windows intentionally have no desktop visibility; exercise the
  // page's visibility lifecycle explicitly while keeping the user's desktop free.
  await js('Object.defineProperty(document,"hidden",{configurable:true,get:()=>false});document.dispatchEvent(new Event("visibilitychange"))');
  event('ready');event('agent_start');await until(async()=>(await state()).clip==='working','working');
  const frames=new Set(),hashes=new Set();for(let i=0;i<12;i++){const s=await state();frames.add(s.frame);hashes.add(createHash('sha256').update((await pet.pet.webContents.capturePage()).toPNG()).digest('hex'));await wait(150);}
  assert.ok(frames.size>=3&&hashes.size>=3);results.push('Real canvas pixels and frame IDs change during working animation.');
  fs.writeFileSync(path.join(out,'working.png'),(await pet.pet.webContents.capturePage()).toPNG());
  event('extension_ui_request',{method:'ask',id:'q'});await until(async()=>(await state()).clip==='attention','attention');assert.equal(pet.snapshot().pendingCount,1);
  event('question_resolved',{id:'q'});event('prompt_result',{status:'completed'});await until(async()=>(await state()).clip==='completed','celebration');await wait(2100);assert.ok(Number((await state()).frame)<4);results.push('Native event projection selects attention then celebrates completion briefly and returns to idle poses.');
  await pet.save({reducedMotion:true});await until(async()=>(await state()).playing==='false','reduced motion');let before=await state();await wait(900);assert.equal((await state()).paints,before.paints);
  await pet.save({reducedMotion:false});event('agent_start');await until(async()=>(await state()).playing==='true','resume');pet.hide();await wait(100);before=await state();await wait(900);assert.equal((await state()).paints,before.paints);results.push('Reduced motion and hidden state stop animation timers.');
  pet.hidden=false;pet.publish();await pet.save({appearance:'cat'});await until(async()=>(await state()).playing==='true','cat');await wait(600);fs.writeFileSync(path.join(out,'cat.png'),(await pet.pet.webContents.capturePage()).toPNG());assert.ok(pet.nativeShape);
  await pet.save({animated:false});await until(async()=>(await state()).canvasHidden,'static fallback');assert.equal(await js('getComputedStyle(document.getElementById("character")).visibility'),'visible');results.push('Cat animation and original static fallback preserve native hit regions.');
  await pet.save({animated:true});await until(async()=>!(await state()).canvasHidden,'re-enabled');
  // Late packets cannot make the aborted run celebrate.
  event('prompt_result',{status:'aborted'});await until(async()=>(await state()).clip==='idle','abort stays calm');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,results,frames:[...frames],distinctPixelFrames:hashes.size,errors},null,2));console.log(JSON.stringify({passed:true,out,results}));
 }catch(e){fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,results,error:e.stack,errors},null,2));console.error(e.stack);console.log(out);process.exitCode=1;}
 finally{clearTimeout(timeout);pet?.dispose();app.exit(process.exitCode||0);}
});
