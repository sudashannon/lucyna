// Real Electron overlay rendering, isolated preferences, no OMP processes.
// Run with --force-device-scale-factor=1 / 1.25 / 1.5 / 2 for geometry coverage.
const electron=require('electron'),{app,BrowserWindow}=electron;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
const scale=app.commandLine.getSwitchValue('force-device-scale-factor')||'system';
const out=path.resolve('.runtime','pet-layout-'+scale);fs.mkdirSync(out,{recursive:true});
app.setPath('userData',path.join(out,'profile'));
const errors=[],checks=[];let pet;
class HiddenWindow extends BrowserWindow{
 constructor(options){super({...options,show:false});this.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});}
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
  await pet.save({quiet:true,reducedMotion:true});
  await until(async()=>await sprite('document.body.dataset.reduced==="true"'),'reduced motion');
  assert.equal(pet.snapshot().pendingCount,20);
  await pet.action('close-bubble');assert.equal(pet.snapshot().pendingCount,20);assert.equal(pet.bubble.isVisible(),false);
  checks.push('Quiet/reduced motion and dismiss preserve unresolved native questions.');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,scale,checks,errors},null,2));console.log(JSON.stringify({passed:true,scale,checks}));
 }catch(e){fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,scale,checks,error:e.stack,errors},null,2));console.error(e.stack);process.exitCode=1;}
 finally{clearTimeout(timeout);pet?.dispose();app.exit(process.exitCode||0);}
});
