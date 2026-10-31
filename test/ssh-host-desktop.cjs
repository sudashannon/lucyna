// Production main/preload/renderer + real OpenSSH and frozen host.
// Optional realPrompt uses an explicitly supplied remote OMP configuration.
// Only unrelated local Work services are replaced. Remote components are real.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const optionsPath=process.argv.find(a=>a.startsWith('--options='))?.slice(10);
const options=JSON.parse(fs.readFileSync(optionsPath,'utf8'));
const out=path.resolve(options.output);fs.mkdirSync(out,{recursive:true});
if(!process.versions.electron){
 const {spawnSync}=require('node:child_process');
 for(const phase of ['create','restore']){
  const result=spawnSync(require('electron'),[__filename,'--options='+optionsPath,'--phase='+phase,'--hidden'],{cwd:path.resolve(__dirname,'..'),windowsHide:true,encoding:'utf8',timeout:options.realPrompt?270000:120000});
  fs.writeFileSync(path.join(out,phase+'.log'),(result.stdout||'')+(result.stderr||''));
  if(result.error||result.status!==0)throw Error('Desktop '+phase+' failed: '+(result.error?.message||result.stderr||result.stdout));
 }
 process.stdout.write(JSON.stringify({passed:true,output:out,phases:['create','restore'],realSsh:true,productionMain:true,modelCalled:!!options.realPrompt,executor:options.ssh.executor.kind}));
}else{
 const {app,BrowserWindow}=require('electron');
 const phase=process.argv.find(a=>a.startsWith('--phase='))?.slice(8);
 process.env.LUCYNA_USERDATA=path.join(out,'profile');process.env.LUCYNA_CONFIG=path.resolve('test/fixtures/runtime.json');
 app.disableHardwareAcceleration();
 fs.mkdirSync(process.env.LUCYNA_USERDATA,{recursive:true});
 fs.writeFileSync(path.join(process.env.LUCYNA_USERDATA,'feedback-settings.json'),JSON.stringify({...require('../src/feedback/settings.cjs').defaults(),mode:'silent'}));
 const backend=require('../src/backend.cjs');backend.listWorks=async()=>[{root:options.root,name:'同路径本机工作区',kind:'work'}];
 const {WorkRunner}=require('../src/work-runner.cjs');WorkRunner.prototype.startAutomatic=()=>{};WorkRunner.prototype.stopAutomatic=async()=>{};
 const remoteModule=require('../src/hosts/desktop.cjs'),NativeRemote=remoteModule.RemoteDesktop;
 let remote,win;const errors=[],checks=[],nativeStarts=new Set();const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 remoteModule.RemoteDesktop=class extends NativeRemote{constructor(args){super({...args,bundle:options.bundle,prefix:id=>options.prefix+'/'+id,send:event=>{if(event.type==='agent_start')nativeStarts.add(event.clientSessionId);args.send(event);}});remote=this;}};
 const js=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){throw Error(error.message+' ['+code.slice(0,200)+']');}};
 async function until(check,label,timeout=30000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await pause(60);}throw Error('Timeout: '+label);}
 const dom=(code,label=code)=>until(()=>js('Boolean('+code+')'),label);
 const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const textButton=async text=>{await dom(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`,'button '+text);return js(`([...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)).click()`);};
 const input=async(label,value)=>{const selector='[aria-label='+JSON.stringify(label)+']';await dom(`document.querySelector(${JSON.stringify(selector)})`,'input '+label);return js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);};
 async function compose(value){await js(`(()=>{const e=document.querySelector('#message-input');Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(60);}
 async function shot(name){await js('document.fonts.ready');await pause(150);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),'horizontal overflow');fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
 const currentId=()=>js('document.querySelector(".app-shell").dataset.sessionId');
 const manifest=path.join(out,'state.json');
 async function addHost(name,omp,agentDir=options.agentDir){
  await click('button[aria-label="设置"]');await textButton('SSH 主机');await textButton('添加主机');
  const checkError=name==='SSH 隔离验收';
  await input('SSH 主机名称',name);await input('SSH 目标',options.ssh.destination);await input('远端工作目录',options.root);await input('远端 OMP 路径',checkError?'/etc/hosts':omp);
  await shot('host-basic');
  await click('.ssh-host-form summary');await input('SSH 执行器',options.ssh.executor.kind);
  if(options.ssh.executor.kind==='wsl-openssh'){await input('SSH WSL 发行版',options.ssh.executor.distro);await input('SSH WSL 用户',options.ssh.executor.user);}
  if(options.ssh.port)await input('SSH 端口',String(options.ssh.port));
  await input('SSH 配置文件',options.ssh.configFile);await input('远端 OMP 配置目录',agentDir);
  await shot(name==='SSH 隔离验收'?'host-form':'host-real-form');
  await textButton('保存并连接');
  if(checkError){
   await until(async()=> (await remote.list()).some(p=>p.name===name&&p.phase==='error'),'actionable missing OMP error');
   await textButton('SSH 主机');await dom('document.querySelector(".ssh-settings")?.textContent.includes("远端未找到 OMP")');
   await dom('document.querySelectorAll(".ssh-settings .error-text").length===1','one actionable host error');
   await shot('host-error');win.setSize(960,720);await shot('host-error-narrow');win.setSize(1440,900);
   await js(`([...document.querySelectorAll('.ssh-host-actions button')].find(b=>b.textContent.trim()==='编辑')).click()`);
   await input('远端 OMP 路径',omp);await textButton('保存并连接');
   checks.push('Missing remote OMP shows an actionable error; editing and retrying reuses installation');
  }
  await until(async()=> (await remote.list()).some(p=>p.name===name&&p.phase==='ready'),'host installed '+name);
  await dom('[...document.querySelectorAll(".ssh-host-state")].some(e=>e.textContent.includes("已连接"))');
  await shot('hosts-connected');await click('.settings-modal button[aria-label="关闭弹窗"]');
  await dom('[...document.querySelectorAll(".work-row")].some(e=>e.textContent.includes('+JSON.stringify(name)+'))');
  await js(`([...document.querySelectorAll('.work-row')].find(e=>e.textContent.includes(${JSON.stringify(name)}))).click()`);
 }
 require('../src/main.cjs');
 app.whenReady().then(async()=>{
  const timer=setTimeout(()=>app.exit(2),options.realPrompt?260000:110000);
  try{
   await until(()=>!!remote&&BrowserWindow.getAllWindows().length,'main window');win=BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false);
   win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
   await dom('document.querySelectorAll(".work-row").length>0');await js('void (document.hasFocus=()=>true)');
   if(phase==='create'){
    await addHost('SSH 隔离验收',options.fakeOmp);checks.push('Production settings saved SSH profile and installed frozen host');
    await compose('桌面 SSH 完整流程');await click('button[aria-label="发送消息"]');
    await dom('document.querySelector(".message-column")?.textContent.includes("远端已完成：桌面 SSH 完整流程")');
    const id=await currentId();await until(()=>remote.active.get(id)?.session.record?.status==='live','native session');
    await dom('document.querySelector(".remote-connection")?.dataset.remoteConnection==="ready"');
    const before={...remote.get(id).session.record};assert.equal((await remote.request(id,'get_state')).promptCount,1);
    await compose('断线后仍保留的草稿');
    const connection=remote.connections.get(remote.get(id).saved.hostId).connection;
    const child=connection.child;child.kill();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    await dom('document.querySelector(".remote-connection")?.dataset.remoteConnection==="reconnecting"');await shot('reconnecting');
    await dom('document.querySelector(".remote-connection")?.dataset.remoteConnection==="ready"');
    assert.equal(remote.get(id).session.record.pid,before.pid);assert.equal((await remote.request(id,'get_state')).sessionId,before.nativeSessionId);
    assert.equal(await js('document.querySelector("#message-input").value'),'断线后仍保留的草稿');checks.push('Abrupt SSH loss automatically attached the same OMP and retained draft');
    await textButton('断开连接');await dom('document.querySelector(".remote-connection")?.dataset.remoteConnection==="disconnected"');await textButton('重新连接会话');await dom('document.querySelector(".remote-connection")?.dataset.remoteConnection==="ready"');
    assert.equal(remote.get(id).session.record.pid,before.pid);checks.push('Explicit detach/reconnect kept the original process');
    await compose('question');await click('button[aria-label="发送消息"]');await dom('document.body.textContent.includes("Fixture question")');await shot('remote-question');
    await input('回复内容','desktop answer');await textButton('提交');
    await dom('document.querySelector(".message-column")?.textContent.includes("已收到你的回复")');checks.push('Native question response retained its ID');
    const original=connection.request.bind(connection);let cut=false;
    connection.request=(op,args,...rest)=>{const request=original(op,args,...rest);if(!cut&&op==='session.request'&&args.frame?.type==='prompt'&&args.frame.message==='lost-ack'){cut=true;return request.then(value=>{const transport=connection.child;transport.kill();transport.stdin.destroy();transport.stdout.destroy();transport.stderr.destroy();return value;});}return request;};
    await compose('lost-ack');await click('button[aria-label="发送消息"]');
    await dom('document.body.textContent.includes("上一条消息的发送结果待确认")');await dom('document.querySelector(".remote-connection")?.dataset.remoteConnection==="ready"');
    await textButton('核对发送状态');await dom('document.body.textContent.includes("已确认远端收到上一条消息")');
    assert.equal((await remote.request(id,'get_state')).promptCount,3);assert.equal(await js('document.querySelector("#message-input").value'),'lost-ack');
    await shot('uncertain-confirmed');await textButton('已核对，继续编辑');await compose('重开客户端仍保留的草稿');
    await dom('document.querySelectorAll(".message.user").length===3','no duplicated user bubbles after replay');
    checks.push('Lost acknowledgement did not resend prompt; draft retained until reviewed');
    let real;
    if(options.realOmp){
     await addHost('SSH 原生 OMP',options.realOmp,options.realAgentDir||options.agentDir);
     if(options.realPrompt){await compose(options.realPrompt);await click('button[aria-label="发送消息"]');}
     else await click('button[aria-label="技能与命令"]');
     await dom('document.querySelector(".remote-connection")?.dataset.remoteConnection==="ready"');
     const realId=await currentId();real={id:realId,record:{...remote.get(realId).session.record}};
     if(options.realPrompt){
      await until(()=>nativeStarts.has(realId),'real native agent_start',120000);
      const atCut=await remote.request(realId,'get_state');real.model={id:atCut.model?.id,provider:atCut.model?.provider,name:atCut.model?.name};real.runningAtCut=atCut.isSettled===false;
      const realConnection=remote.connections.get(remote.get(realId).saved.hostId).connection,transport=realConnection.child;
      transport.kill();transport.stdin.destroy();transport.stdout.destroy();transport.stderr.destroy();
      await dom('document.querySelector(".remote-connection")?.dataset.remoteConnection==="reconnecting"');await shot('real-reconnecting');
      await until(()=>js('document.querySelector(".remote-connection")?.dataset.remoteConnection==="ready"'),'real OMP reconnected',120000);
      await until(()=>js('[...document.querySelectorAll(".message.assistant")].some(e=>e.textContent.includes("LUCYNA_SSH_LIVE_OK"))&&document.querySelector("#run-status")?.dataset.outcome==="completed"'),'real model response after disconnect',180000);
      if(remote.get(realId).saved.pendingOperation){await textButton('核对发送状态');await dom('document.body.textContent.includes("已确认远端收到上一条消息")');await textButton('已核对，继续编辑');}
      const state=await remote.request(realId,'get_state'),history=await remote.request(realId,'get_messages');
      assert.equal(state.sessionId,real.record.nativeSessionId);assert.equal(remote.get(realId).session.record.pid,real.record.pid);
      assert.equal(history.messages.filter(m=>(m.message||m).role==='user').length,1);
      real.record={...remote.get(realId).session.record};await shot('real-model');
      checks.push('Live model answered LUCYNA_SSH_LIVE_OK; forced SSH loss kept PID/native ID and exactly one user prompt');
     }else checks.push('Real OMP connected through the production UI without a model call');
     await js(`([...document.querySelectorAll('.session-select')].find(e=>e.dataset.session===${JSON.stringify(id)})).click()`);
    }
    await shot('desktop');win.setSize(960,720);await shot('narrow');win.setSize(1440,900);
    fs.writeFileSync(manifest,JSON.stringify({id,before,real,hostId:remote.get(id).saved.hostId},null,2));
   }else{
    const saved=JSON.parse(fs.readFileSync(manifest,'utf8'));
    await until(()=>remote.active.has(saved.id)&&remote.get(saved.id).session.polling,'app restart reattachment');
    await dom('document.querySelector(".remote-connection")?.dataset.remoteConnection==="ready"');
    assert.equal(await currentId(),saved.id);assert.equal(remote.get(saved.id).session.record.pid,saved.before.pid);
    assert.equal((await remote.request(saved.id,'get_state')).sessionId,saved.before.nativeSessionId);
    assert.equal((await remote.request(saved.id,'get_state')).promptCount,3);
    await dom('document.querySelector("#message-input")?.value==="重开客户端仍保留的草稿"');
    if(saved.real){
     await until(()=>remote.active.get(saved.real.id)?.session.polling,'real OMP restart restore');assert.equal(remote.get(saved.real.id).session.record.pid,saved.real.record.pid);
     if(options.realPrompt){const history=await remote.request(saved.real.id,'get_messages');assert.equal(history.messages.filter(m=>(m.message||m).role==='user').length,1);checks.push('Live model journal retained exactly one user prompt after desktop restart');}
    }
    await shot('restored');checks.push('Second Electron process restored original fake/real OMP processes, selection and draft with no prompt replay');
    await textButton('结束远端会话');await dom('document.querySelector(".remote-connection")?.dataset.remoteConnection==="idle"');
    assert.equal(remote.get(saved.id).saved.ended,true);
    await click('.history-shortcut');await click('button[aria-label="刷新历史会话"]');
    await dom('[...document.querySelectorAll(".history-row")].some(e=>e.textContent.includes("原地续聊"))','ended remote history');
    await js(`([...document.querySelectorAll('.history-row')].find(e=>e.textContent.includes('原地续聊'))).click()`);
    await dom('document.querySelector(".remote-connection")?.dataset.remoteConnection==="ready"','explicit history resume');
    const resumedId=await currentId(),resumed=await remote.request(resumedId,'get_state');
    assert.notEqual(resumedId,saved.id);assert.equal(resumed.sessionId,saved.before.nativeSessionId);assert.equal(resumed.sessionFile,saved.before.journal);assert.equal(resumed.promptCount,3);
    await until(async()=> (await remote.history(options.root,saved.hostId)).managed.length===1,'one journal entry after explicit resume');
    checks.push('Ended history explicitly resumes the same journal and native ID with no prompt replay');
    await textButton('结束远端会话');if(saved.real)await remote.close(saved.real.id);
   }
   assert.deepEqual(errors,[],'renderer console errors');
   fs.writeFileSync(path.join(out,phase+'-result.json'),JSON.stringify({passed:true,checks,errors},null,2));
   await win.webContents.session.flushStorageData();clearTimeout(timer);app.quit();
  }catch(error){fs.writeFileSync(path.join(out,phase+'-result.json'),JSON.stringify({passed:false,error:error.stack,checks,errors},null,2));if(win&&!win.isDestroyed())await shot('failure').catch(()=>{});console.error(error.stack);clearTimeout(timer);await remote?.shutdown().catch(()=>{});app.exit(1);}
 });
}
