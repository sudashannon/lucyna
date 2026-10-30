// Real WSL OMP journal writer with a local title API and synthetic turn notifications.
// Never sends an OMP prompt or opens an existing journal. Leaves the isolated fixture for inspection.
const {spawn}=require('node:child_process'),readline=require('node:readline'),http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const runtime=require('../src/runtime-config.cjs'),{windowsSessionPath}=require('../src/client-settings.cjs'),{FrameDecoder}=require('../src/native-rpc.cjs');
const {SessionManager}=require('../src/session-manager.cjs'),{SessionTitles}=require('../src/session-titles.cjs'),{AuxiliaryAgent}=require('../src/auxiliary-agent.cjs');
(async()=>{
 const root='/tmp/lucyna-naming-'+Date.now();await fs.mkdir(windowsSessionPath(root));
 const seed=root+'/fixture.jsonl',timestamp=new Date().toISOString();
 const messages=[{type:'session',version:3,id:require('node:crypto').randomUUID(),timestamp,cwd:root},{type:'message',id:'user-fixture',parentId:null,timestamp,message:{role:'user',content:[{type:'text',text:'隔离命名验收'}],timestamp:Date.now()}}];
 await fs.writeFile(windowsSessionPath(seed),messages.map(e=>JSON.stringify(e)).join('\n')+'\n');
 let calls=0;const server=http.createServer(async(req,res)=>{for await(const chunk of req){}calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'chat_native',object:'chat.completion',created:1,model:'fixture-model',choices:[{index:0,message:{role:'assistant',content:'验证 Lucyna 原生会话自动命名'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const settings={revision:0,resolve:async()=>({autoTitle:true,protocol:'chat-completions',baseURL:'http://127.0.0.1:'+server.address().port+'/v1',model:'fixture-model',apiKey:'native-dummy-key',timeoutSeconds:10})};
 const titles=new SessionTitles(new AuxiliaryAgent(settings),settings),commands=[];let native;
 const manager=new SessionManager({titles,send:()=>{},create:emit=>native={child:null,ready:false,pending:new Map(),emit,
  async start(){
   this.child=spawn('wsl.exe',[...runtime.wslPrefix,'--cd',root,'--',runtime.wslExecutable,'--mode','rpc','--cwd',root,'--resume',seed,'--session-dir',root+'/sessions','--no-tools','--no-lsp','--no-extensions','--no-skills'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
   const proc=this.child,decoder=new FrameDecoder();proc.stderr.on('data',()=>{});
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Native OMP startup timeout')),20000);
    readline.createInterface({input:proc.stdout}).on('line',line=>{try{const event=decoder.push(JSON.parse(line));if(!event)return;if(event.type==='ready'){this.ready=true;clearTimeout(timer);resolve();}if(event.type==='response'&&this.pending.has(event.id)){const p=this.pending.get(event.id);this.pending.delete(event.id);clearTimeout(p.timer);event.success?p.resolve(event.data):p.reject(Error(event.error));}else emit(event);}catch(error){clearTimeout(timer);reject(error);}});
    proc.on('error',reject);proc.on('close',code=>{clearTimeout(timer);this.child=null;emit({type:'process_exit',code});if(!this.ready)reject(Error('Native OMP exited before ready'));});
   });return {};
  },request(type,data={}){commands.push(type);const id=require('node:crypto').randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Native command timeout'));},10000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({type,id,...data})+'\n');});},messages:async()=>({messages:[]}),
  async close(){if(!this.child)return;const child=this.child;await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},5000);child.once('close',()=>{clearTimeout(timer);resolve();});child.stdin.end();});}
 }});
 try{
  await manager.start('native-test',run=>run({root,settings:{runtime:'wsl'}}));
  native.emit({type:'agent_start'});native.emit({type:'message_end',message:{role:'user',content:'验证独立 API 生成标题并保存到 OMP 日志'}});native.emit({type:'message_end',message:{role:'assistant',content:'已确认原生 RPC 设置名称的接口。'}});native.emit({type:'session_settled'});
  await Promise.all([...titles.tasks]);const state=await manager.request('native-test','get_state');assert.equal(state.sessionName,'验证 Lucyna 原生会话自动命名');assert.equal(calls,1);assert.ok(!commands.includes('prompt'));
  await manager.closeAll();const entries=(await fs.readFile(windowsSessionPath(state.sessionFile),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(entries.find(e=>e.type==='title').title,state.sessionName);assert.ok(entries.some(e=>e.type==='title_change'));assert.equal(entries.filter(e=>e.type==='message').length,1);
  const result={passed:true,root,sessionFile:state.sessionFile,title:state.sessionName,apiCalls:calls,commands};await fs.mkdir(path.resolve('.runtime'),{recursive:true});await fs.writeFile(path.resolve('.runtime/auxiliary-native-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await manager.closeAll();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
