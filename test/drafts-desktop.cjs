// Real Electron IndexedDB, with transient failures injected only in this profile.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {build}=require('esbuild');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'lucyna-drafts-test-'));
require('../src/app-identity.cjs').configureAppIdentity(app,{LUCYNA_USERDATA:path.join(folder,'profile')});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let win;
const js=code=>win.webContents.executeJavaScript(code);
async function until(code){for(let i=0;i<160;i++){if(await js(code))return;await pause(30);}throw Error('Timed out: '+code);}
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>app.exit(2),25000);
 try{
  const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {useStoredDrafts} from './src/renderer/useStoredDrafts';
  function Harness(){const text=useStoredDrafts('text','active',()=>({active:'legacy value',untouched:''}),'');const images=useStoredDrafts('images','active',()=>({}),[]);window.drafts={text,images};return React.createElement('textarea',{value:text.value,onChange:e=>text.set(e.target.value)});}createRoot(document.getElementById('root')).render(React.createElement(Harness));`,resolveDir:path.resolve('.'),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife'});
  const script=path.join(folder,'harness.js'),html=path.join(folder,'index.html');fs.writeFileSync(script,bundle.outputFiles[0].contents);fs.writeFileSync(html,'<!doctype html><div id="root"></div>');
  win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await win.loadFile(html);
  await js(`(async()=>{
   window.nativeOpen=indexedDB.open.bind(indexedDB);window.writeCount=0;window.failOpen=true;window.failWrites=false;
   window.getDb=()=>new Promise((resolve,reject)=>{const r=nativeOpen('omp.composer.v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
   window.disk=async key=>{const d=await getDb();return new Promise((resolve,reject)=>{const t=d.transaction('drafts');const r=t.objectStore('drafts').get(key);t.oncomplete=()=>{d.close();resolve(r.result)};t.onerror=()=>reject(t.error);});};
   const d=await getDb();await new Promise((resolve,reject)=>{const t=d.transaction('drafts','readwrite'),s=t.objectStore('drafts');s.put('saved active','text:active');s.put('saved other work','text:untouched');s.put([{type:'image',data:'fixture-pixels'}],'images:active');t.oncomplete=resolve;t.onerror=()=>reject(t.error);});d.close();
   indexedDB.open=(...args)=>{if(failOpen)throw new DOMException('Injected temporary profile lock','UnknownError');return nativeOpen(...args);};
   const transaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){if(args[1]==='readwrite'){writeCount++;if(failWrites)throw new DOMException('Injected write failure','UnknownError');}return transaction.apply(this,args);};
  })()`);
  await js(`new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=${JSON.stringify('file:///'+script.replace(/\\/g,'/'))};s.onload=resolve;s.onerror=reject;document.body.append(s);})`);
  await until('!!window.drafts?.text.error&&!!window.drafts?.images.error');
  assert.equal(await js('drafts.text.loaded'),false);
  await js("drafts.text.set('typed while locked')");await pause(100);
  assert.equal(await js('writeCount'),0,'failed reads never start writes');
  assert.equal(await js("disk('text:active')"),'saved active');
  await js('failOpen=false;drafts.text.retry();drafts.images.retry()');
  await until('drafts.text.loaded&&drafts.images.loaded&&!drafts.text.error&&!drafts.images.error');
  assert.equal(await js('drafts.text.value'),'typed while locked');
  assert.equal(await js('drafts.text.values.untouched'),'saved other work');
  assert.equal(await js('drafts.images.value[0].data'),'fixture-pixels');
  await until("disk('text:active').then(v=>v==='typed while locked')");
  await js("failWrites=true;drafts.text.set('first failed write')");await until('!!drafts.text.error');
  await js("drafts.text.set('latest '.repeat(50000));drafts.images.set([{type:'image',data:'new image pixels'}])");await pause(100);
  assert.equal(await js("disk('text:active')"),'typed while locked','write failure retains last good draft');
  await js('failWrites=false;drafts.text.retry();drafts.images.retry()');
  await until("disk('text:active').then(v=>v?.length===350000)");
  await until('!drafts.text.error&&!drafts.images.error');
  assert.equal(await js("disk('text:untouched')"),'saved other work');
  assert.equal((await js("disk('images:active')"))[0].data,'new image pixels');
  await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload();});
  await js(`new Promise(resolve=>{const s=document.createElement('script');s.src=${JSON.stringify('file:///'+script.replace(/\\/g,'/'))};s.onload=resolve;document.body.append(s);})`);
  await until('!!window.drafts?.text.loaded&&!!window.drafts?.images.loaded');
  assert.equal(await js('drafts.text.value.length'),350000);
  assert.equal(await js('drafts.images.value[0].data'),'new image pixels');
  console.log('PASS: read failure protection, live edit merge, retry, large text/images and reload persistence');
  clearTimeout(timer);app.exit(0);
 }catch(error){console.error(error.stack);clearTimeout(timer);app.exit(1);}
});
