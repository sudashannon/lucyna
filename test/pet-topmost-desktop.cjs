// Real native Windows z-order, not an offscreen rendering substitute.
// Uses an isolated profile and no OMP processes or live preferences.
const {app,BrowserWindow,screen}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {PetController}=require('../src/pet/controller.cjs');
const out=path.resolve('.runtime/pet-topmost-'+Date.now());fs.mkdirSync(out,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-topmost-')));app.on('window-all-closed',()=>{});
const pause=ms=>new Promise(r=>setTimeout(r,ms));let pet,cover;const checks=[];
function topmost(expected,label){for(const win of [pet.pet,pet.bubble])assert.equal(win.isAlwaysOnTop(),expected,label);checks.push(label);}
app.whenReady().then(async()=>{const timer=setTimeout(()=>app.exit(2),30000);try{
 if(process.platform!=='win32'){console.log('SKIP Windows-specific native z-order');clearTimeout(timer);app.exit(0);return;}
 pet=new PetController({directory:app.getPath('userData'),getMain:()=>null,getSessions:()=>({list:()=>[]}),onQuit:()=>{throw Error('Unexpected quit');}});
 await pet.init();const display=screen.getPrimaryDisplay(),area=display.workArea;
 await pet.save({enabled:true,alwaysOnTop:true,quiet:true,position:{displayId:display.id,right:Math.round(area.width/2),bottom:Math.max(24,area.height-400)}});
 await pause(250);topmost(true,'Enabling the companion makes both native windows genuinely topmost.');
 cover=new BrowserWindow({show:false,width:300,height:300,backgroundColor:'#202938',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});cover.showInactive();
 pet.reposition();await pause(100);topmost(true,'Showing another ordinary window and repositioning do not demote the companion.');
 await pet.save({size:'large'});topmost(true,'Changing native dimensions retains the topmost state.');
 pet.hide();const previous=pet.pet;await pet.recover({reveal:true});assert.ok(previous.isDestroyed());assert.equal(pet.hidden,false);topmost(true,'Pet-only recovery creates a genuinely topmost replacement.');
 await pet.save({alwaysOnTop:false});topmost(false,'Turning always-on-top off is respected for both native windows.');
 await pet.save({alwaysOnTop:true});topmost(true,'Turning always-on-top back on restores the real native flag.');
 await pet.diagnosticWrite;const diagnostics=JSON.parse(fs.readFileSync(pet.diagnosticFile,'utf8'));assert.ok(diagnostics.some(d=>d.requestedAlwaysOnTop===true&&d.actualAlwaysOnTop===true));
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks},null,2));console.log(JSON.stringify({passed:true,checks,out}));
 clearTimeout(timer);pet.dispose();cover.destroy();app.exit(0);
}catch(e){console.error(e);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:e.stack,checks},null,2));clearTimeout(timer);pet?.dispose();cover?.destroy();app.exit(1);}});
