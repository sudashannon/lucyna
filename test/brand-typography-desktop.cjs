// Production renderer/preload, isolated profile, real paste handler and injected IPC.
const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const baseline=process.argv.includes('--expect-broken'),out=path.resolve('.runtime/brand-font-'+Date.now());fs.mkdirSync(out,{recursive:true});require('./desktop-log.cjs').installDesktopLog(out);
app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let win,blocked=false,prompt='';const errors=[],checks=[],pause=ms=>new Promise(r=>setTimeout(r,ms)),js=code=>win.webContents.executeJavaScript(code,true);
async function until(code,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await js(`Boolean(${code})`))return;await pause(50);}throw Error('Timeout: '+label);}
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function shot(name){await pause(150);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{const timer=setTimeout(()=>app.exit(2),90000);try{
 win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{preload:path.resolve('src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>{if(e.level==='error'&&!e.message.includes('ERR_BLOCKED_BY_CLIENT'))errors.push(e.message);});
 win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{const cancel=blocked&&/cindy-omp-cat-v1.*\.png/.test(details.url);callback({cancel});});
 const handle=(name,fn)=>ipcMain.handle(name,(_, ...args)=>fn(...args));
 handle('works:list',()=>[{root:'/demo/work',name:'font-and-avatar',kind:'work'}]);handle('omp:list',()=>[]);handle('session:list',()=>({sessions:[],managed:[]}));handle('work:read',()=>'# 字体与图标验收');handle('work:details',()=>({root:'/demo/work',name:'字体与图标验收',content:'# 字体与图标验收',issues:[],warnings:[],members:[],assets:[]}));handle('work:run',()=>[]);
 handle('pet:context',()=>{});handle('settings:get',()=>({settings:require('../src/client-settings.cjs').defaults()}));handle('feedback:get',()=>({settings:require('../src/feedback/settings.cjs').defaults(),warning:''}));
 handle('omp:start',options=>{setTimeout(()=>win.webContents.send('omp:event',{type:'ready',clientSessionId:options.clientSessionId}),40);return{runtime:'wsl'};});
 handle('omp:request',(type,data,id)=>{if(type==='get_state')return {sessionName:'长文本粘贴验收',isSettled:true};if(type==='get_messages')return{messages:[]};if(type==='prompt'){prompt=data.message;win.webContents.send('omp:event',{type:'agent_start',clientSessionId:id});}return{};});
 await win.loadFile(path.resolve('dist/renderer/index.html'));await until('document.querySelector(".work-row")','workspace');await click('.work-row');await until('document.querySelector("#message-input")','composer');
 if(!baseline){await js('document.fonts.ready');assert.equal(await js('document.fonts.check(\'400 14px "Source Han Sans SC"\',"等待模型响应 中文 Lucyna")'),true);assert.ok((await js('getComputedStyle(document.body).fontFamily')).startsWith('"Source Han Sans SC"'));
  const dbg=win.webContents.debugger;dbg.attach('1.3');await dbg.sendCommand('DOM.enable');await dbg.sendCommand('CSS.enable');const {root}=await dbg.sendCommand('DOM.getDocument');const {nodeId}=await dbg.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'.composer textarea'});const fonts=await dbg.sendCommand('CSS.getPlatformFontsForNode',{nodeId});checks.push({fontEvidence:fonts.fonts});dbg.detach();
 }
 blocked=true;
 const length=await js(`(()=>{const text='长文本粘贴回归 0123456789\\n'.repeat(18000),data=new DataTransfer();data.setData('text/plain',text);document.querySelector('#message-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));return text.length;})()`);
 await until('document.querySelector(".text-attachment")','long text attachment');await js(`(()=>{const el=document.querySelector('.text-attachment select');el.value='inline';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('.send-button');
 await until('document.querySelector(".run-mascot")','waiting state');await pause(500);assert.equal(prompt.length,length);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));checks.push('Full long-text paste reaches native prompt interface and stays within window.');
 if(baseline){assert.ok(await js('(()=>{const image=document.querySelector(".run-mascot img");return image&&image.complete&&image.naturalWidth===0})()'));checks.push('Reproduced screenshot: missing brand resource leaves broken-image icon after paste/send.');await shot('baseline-missing-cat');}
 else{
  await until('document.querySelector(".run-mascot .cindy-avatar-fallback")','vector fallback');assert.equal(await js('!!document.querySelector(".run-mascot img")'),false);await shot('long-paste-fallback');checks.push('Missing cat asset renders a cat vector fallback, never a broken image.');
  // Recreate the activity node after resource availability returns.
  blocked=false;win.webContents.send('omp:event',{type:'session_settled'});await pause(120);win.webContents.send('omp:event',{type:'agent_start'});await until('document.querySelector(".run-mascot img")?.naturalWidth>0','normal image restored');
  await js('document.fonts.ready');const dbg=win.webContents.debugger;dbg.attach('1.3');await dbg.sendCommand('DOM.enable');await dbg.sendCommand('CSS.enable');const {root}=await dbg.sendCommand('DOM.getDocument');const {nodeId}=await dbg.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'.run-label'});const {fonts}=await dbg.sendCommand('CSS.getPlatformFontsForNode',{nodeId});assert.ok(fonts.some(f=>f.isCustomFont&&/Source Han Sans/i.test(f.familyName)));checks.push({actualRenderedFonts:fonts});dbg.detach();
  await shot('source-han-and-cat');await click('button[aria-label="切换深色外观"]');win.setSize(960,720);await pause(200);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));await shot('dark-narrow');checks.push('Chinese text uses bundled Source Han Sans; cat returns after resource recovery; dark/narrow layout fits.');
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,baseline,checks},null,2));console.log(JSON.stringify({passed:true,baseline,out,checks}));clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:e.stack,errors,checks},null,2));console.log(out);clearTimeout(timer);app.exit(1);}});
