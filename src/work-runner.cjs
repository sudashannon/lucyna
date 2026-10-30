// A disposable stdio connection to the durable WSL service; never owns OMP.
const {spawn}=require('node:child_process');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const runtime=require('./runtime-config.cjs');
const {toWslPath}=require('./client-settings.cjs');
const TERMINAL=new Set(['completed','cancelled','failed']);
const OPERATIONS=new Set(['status','list','get','create','pause','cancel','resume','answer','accept','adopt','rollback','automatic-status','automatic-configure']);
const script=toWslPath(path.resolve(__dirname,'../tools/work-runner/cli.py'));
const state=runtime.home+'/.local/state/lucyna/work-runner';

class WorkRunner {
  constructor({execute=spawn,listWorks,connections=()=>[],settings=async()=>({}),config=runtime,scriptPath=script,stateDirectory=state}={}){
    this.execute=execute;this.listWorks=listWorks;this.connections=connections;this.settings=settings;this.config=config;
    this.child=null;this.pending=new Map();this.admissions=new Set();this.installing=null;this.script=scriptPath;this.state=stateDirectory;
    this.automaticReady=false;this.automaticError='';this.activity=new Map();this.clientId='lucyna-desktop';this.automaticWorks=[];
  }
  command(mode){return [ ...this.config.wslPrefix,'--exec','python3',this.script,mode,'--state',this.state ];}
  oneShot(mode,input){return new Promise((resolve,reject)=>{
    const child=this.execute('wsl.exe',this.command(mode),{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',settled=false;const timer=setTimeout(()=>{child.kill();finish(Error('后台服务请求超时，请刷新状态后重试'));},mode==='install-evolution'?600000:90000);
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    child.once('error',finish);child.stdin.on('error',finish);child.stderr.resume();
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>4*1024*1024){child.kill();finish(Error('后台状态超过限制'));}});
    child.once('close',code=>{try{const result=JSON.parse(output);if(code||result?.success===false)throw Error(result?.error||'后台服务操作失败');finish(null,result);}catch(error){finish(error);}});
    child.stdin.end(input?JSON.stringify(input)+'\n':'');
  });}
  async ensure(){
    if(this.installing)return this.installing;
    const config=this.config;
    this.installing=(async()=>{
      const settings=await this.settings();
      const result=await this.oneShot('install',{workRoot:config.workRoot,omp:settings.wslExecutable||config.wslExecutable,agentDir:settings.wslAgentDir||config.wslAgentDir,helper:config.skillDirectory+'/worktree-session/scripts/worktree-work.py'});
      return result;
    })();
    try{return await this.installing;}finally{this.installing=null;}
  }
  connect(){
    if(this.child)return;
    const child=this.execute('wsl.exe',this.command('bridge'),{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;
    let buffer='';const fail=error=>{if(this.child===child)this.child=null;for(const [id,p] of this.pending){if(p.child===child){clearTimeout(p.timer);p.reject(error);this.pending.delete(id);}}};
    child.once('error',fail);child.stdin.on('error',fail);child.stderr.resume();child.stdout.setEncoding('utf8');
    child.once('close',()=>fail(Error('后台连接已断开；刷新可重连，任务状态由服务保存')));
    child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>4*1024*1024){child.kill();return fail(Error('后台消息超过限制'));}
      let offset;while((offset=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,offset);buffer=buffer.slice(offset+1);try{
        const response=JSON.parse(line),pending=this.pending.get(response.id);
        if(!pending){if(response.success===false)fail(Error(response.error));continue;}
        clearTimeout(pending.timer);this.pending.delete(response.id);
        response.success?pending.resolve(response.data):pending.reject(Error(response.error||'后台请求失败'));
      }catch{fail(Error('后台协议返回无效数据'));child.kill();}}
    });
  }
  request(data){this.connect();const id=randomUUID();return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('后台操作超时；请刷新确认结果，创建请求可安全重试'));},90000);
    this.pending.set(id,{resolve,reject,timer,child:this.child});this.child.stdin.write(JSON.stringify({...data,id})+'\n');
  });}
  async inspect(root){return this.oneShot('inspect',root?{root}:undefined);}
  async admit(root,callback){
    if(this.admissions.has(root))throw Error('该 Work 的启动操作正在进行，请稍候');
    this.admissions.add(root);try{return await callback();}finally{this.admissions.delete(root);}
  }
  async interactive(root,callback){return this.admit(root,async()=>{
    if((await this.inspect()).some(r=>r.root===root&&!(r.automatic&&r.mode==='evolution')&&(!TERMINAL.has(r.state)||r.process)))throw Error('该 Work 有未结束的后台任务，请在「后台任务」中操作或先取消');
    return callback();
  });}
  observe(event){
    const id=event.clientSessionId;if(!id)return;
    if(['client_prompt','agent_start','session_connecting','client_stopping','client_closing'].includes(event.type))this.activity.set(id,true);
    else if(['session_settled','client_prompt_failed','client_command_complete'].includes(event.type))this.activity.set(id,false);
    else if(event.type==='session_state'&&typeof event.isSettled==='boolean')this.activity.set(id,!event.isSettled);
    else if(event.type==='process_exit')this.activity.delete(id);
  }
  async syncAutomatic(release=false){
    if(this.automaticSync)return this.automaticSync;
    this.automaticSync=(async()=>{
      if(!this.automaticReady){await this.ensure();this.automaticReady=true;}
      const works=await this.listWorks(),connections=release?[]:this.connections();
      this.automaticWorks=works.filter(w=>w.kind!=='invalid').map(w=>{const related=connections.filter(c=>c.root===w.root);return {root:w.root,connected:!!related.length,busy:related.some(c=>!c.ready||c.questions?.length||(this.activity.get(c.id)??c.busy))||this.admissions.has(w.root)};});
      await this.request({op:'automatic-sync',clientId:this.clientId,works:this.automaticWorks});this.automaticError='';
    })().catch(error=>{this.automaticReady=false;this.automaticError=String(error);throw error;});
    try{return await this.automaticSync;}finally{this.automaticSync=null;}
  }
  startAutomatic(){
    if(this.automaticTimer)return;
    void this.syncAutomatic().catch(()=>{});
    this.automaticTimer=setInterval(()=>{void this.syncAutomatic().catch(()=>{});},10000);this.automaticTimer.unref?.();
  }
  async stopAutomatic(){
    clearInterval(this.automaticTimer);this.automaticTimer=null;
    await this.automaticSync?.catch(()=>{});
    if(this.automaticReady)await this.syncAutomatic(this.connections().length===0).catch(()=>{});
    this.disconnect();
  }
  async call(op,data={}){
    if(!OPERATIONS.has(op)||!data||typeof data!=='object'||Array.isArray(data)||JSON.stringify(data).length>128000)throw Error('无效后台任务请求');
    // No arbitrary RPC passthrough, executable, environment or state-directory fields.
    const allowed={status:[],list:['root'],get:['runId','after'],create:['root','requestKey','objective','acceptance','verification','model','tokenBudget','wallSeconds','mode','evolution'],pause:['runId'],cancel:['runId'],resume:['runId'],answer:['runId','answerKey','answer'],accept:['runId'],adopt:['runId'],rollback:['runId'],'automatic-status':['root'],'automatic-configure':['root','enabled','profile']}[op];
    if(Object.keys(data).some(k=>!allowed.includes(k)))throw Error('不支持的后台任务参数');
    if(op==='list'||op==='create'||op.startsWith('automatic-')){
      if(typeof data.root!=='string'||!(await this.listWorks()).some(w=>w.root===data.root&&w.kind!=='invalid'))throw Error('请选择有效 Work');
    }
    if(op.startsWith('automatic-')){
      await this.syncAutomatic();return this.request({...data,op});
    }
    if(op==='list'){
      // Browsing does not install/start a service. Durable state remains visible offline.
      return (await this.inspect(data.root)).filter(r=>r.root===data.root);
    }
    if(op==='create'||op==='resume'){
      const root=op==='create'?data.root:(await this.inspect()).find(r=>r.id===data.runId)?.root;
      if(!root)throw Error('后台任务不存在');
      return this.admit(root,async()=>{
        if(this.connections().some(c=>c.root===root))throw Error('此 Work 仍有普通会话连接，请先结束连接再启动后台任务');
        if(op==='create'&&data.mode==='evolution')await this.oneShot('install-evolution');
        await this.ensure();return this.request({...data,op});
      });
    }
    if(op==='adopt'||op==='rollback'){
      const {run}=await this.request({op:'get',runId:data.runId});
      return this.admit(run.root,async()=>{
        if(this.connections().some(c=>c.root===run.root))throw Error('请先结束此 Work 的普通会话连接');
        return this.request({...data,op});
      });
    }
    return this.request({...data,op});
  }
  disconnect(){const child=this.child;this.child=null;child?.stdin.end();}
}
module.exports={WorkRunner,TERMINAL};
