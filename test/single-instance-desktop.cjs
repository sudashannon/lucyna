const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {claimInstance}=require('../src/single-instance.cjs');
const directory=process.argv[2]||fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-instance-test-'));
require('../src/app-identity.cjs').configureAppIdentity(app,{LUCYNA_USERDATA:directory});
let win,events=0;
if(process.argv[3]!=='unprotected'&&!claimInstance(app,()=>win)){console.log('SECONDARY_EXIT_BEFORE_STORAGE');return;}
if(process.argv[3]==='secondary')throw Error('Secondary incorrectly obtained profile lock');
app.on('second-instance',()=>events++);
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>app.exit(2),20000);
 try{
  const html=path.join(directory,'test.html');fs.writeFileSync(html,'<!doctype html><textarea>unsent draft</textarea>');
  win=new BrowserWindow({show:false,webPreferences:{sandbox:true}});await win.loadFile(html);
  const storageResult=await win.webContents.executeJavaScript(`new Promise(resolve=>{const r=indexedDB.open('omp.composer.v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onerror=()=>resolve({ok:false,name:r.error.name,message:r.error.message});r.onsuccess=()=>{r.result.close();resolve({ok:true})};})`);
  if(process.argv[3]==='unprotected'){console.log('UNPROTECTED_STORAGE '+JSON.stringify(storageResult));clearTimeout(timer);app.exit(0);return;}
  assert.equal(storageResult.ok,true);
  const unprotected=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[__filename,directory,'unprotected'],{windowsHide:true});let output='';
   child.stdout.on('data',d=>output+=d);child.stderr.on('data',()=>{});child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(Error('Probe exit '+code)));
  });
  assert.match(unprotected,/"ok":false,"name":"UnknownError"/,'legacy duplicate launch reproduces IndexedDB failure');
  for(let i=0;i<2;i++){
   const output=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[__filename,directory,'secondary'],{windowsHide:true});let output='';
    child.stdout.on('data',d=>output+=d);child.stderr.on('data',()=>{});child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(Error('Secondary exit '+code)));
   });
   assert.match(output,/SECONDARY_EXIT_BEFORE_STORAGE/);assert.equal(events,i+1);
   assert.equal(win.isVisible(),true,'tray-hidden workbench is revealed');
   assert.equal(await win.webContents.executeJavaScript('document.querySelector("textarea").value'),'unsent draft');
   win.hide();
  }
  // A separate profile can still run an isolated test client.
  console.log('PASS: legacy duplicate launch reproduces storage error; protected launches return to original window and preserve input');clearTimeout(timer);app.exit(0);
 }catch(error){console.error(error.stack);clearTimeout(timer);app.exit(1);}
});
