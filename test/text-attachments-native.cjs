// Opt-in real OMP/model acceptance. Only own temporary journals and attachments.
// node test/text-attachments-native.cjs --work=/absolute/configured/work
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {OmpSession}=require('../src/backend.cjs'),{SessionManager}=require('../src/session-manager.cjs'),{defaults,windowsSessionPath}=require('../src/client-settings.cjs'),{prepare}=require('../src/windows-provider.cjs'),{attachmentRoots}=require('../src/text-attachments.cjs');
const root=process.argv.find(a=>a.startsWith('--work='))?.slice(7);if(!root)throw Error('Opt-in test requires --work=/absolute/configured/work');
const out=path.resolve('.runtime/text-native-'+Date.now());fs.mkdirSync(out,{recursive:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));let manager;const checks=[],events=[];
async function until(fn,label,ms=120000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(150);}throw Error('Timeout: '+label);}
(async()=>{const deadline=setTimeout(()=>{console.error('Native test deadline');void manager?.closeAll();process.exitCode=1;},360000);try{
 for(const runtime of (process.argv.includes('--windows-only')?['windows']:['wsl','windows'])){
  const eventsStart=events.length,settings={...defaults(),runtime,thinking:'off'},id='text-'+runtime,dir=path.join(out,runtime),sessionDir=runtime==='wsl'?'/tmp/lucyna-text-'+randomUUID():path.join(dir,'native-long-path-check','sessions');fs.mkdirSync(dir,{recursive:true});
  const auth=runtime==='windows'?await prepare(dir):null;
  manager=new SessionManager({create:send=>new OmpSession(send),send:event=>events.push(event)});
  const open=async resume=>{await manager.start(id,start=>start({root,agentDir:runtime==='wsl'?settings.wslAgentDir:dir,sessionDir,settings,model:auth?.status.model,env:auth?.env,resume}));await until(()=>events.slice(eventsStart).some(e=>e.type==='ready'&&e.clientSessionId===id)&&manager.get(id).session.ready,'native ready');};
  try{
   await open();auth?.release();const initial=await manager.request(id,'get_state');
   const marker=randomUUID(),text=`FIRST_${marker}\r\n`+'附件验收填充，不是任务指令。\r\n'.repeat(100)+`LAST_${marker}\r\n`;
   const [saved]=await manager.prepareTextAttachments(id,[{id:'text-file',text}]);const roots=attachmentRoots({sessionFile:initial.sessionFile,sessionId:initial.sessionId,runtime});assert.equal(fs.readFileSync(path.join(roots.local,saved.name),'utf8'),text);
   if(runtime==='wsl')assert.ok(initial.sessionFile.startsWith('\\\\wsl.localhost\\')&&!initial.sessionFile.includes('mnt\\c'));
   const ask=async(resumed=false)=>{const before=events.length;await manager.request(id,'prompt',{message:`${resumed?'历史恢复后的磁盘核验：务必重新调用 read，不能复述上一轮答案。此前的临时缓存已被清理，需要确认文件仍存在。':'Lucyna 文本附件验收。'}只调用原生 read 读取这个文件：${saved.url} 。回复文件第一行和最后一行的 FIRST_ 与 LAST_ 标记，不要运行 shell，不要读写工作区或其他文件。`,streamingBehavior:'followUp'});await until(()=>events.slice(before).some(e=>e.type==='session_settled'&&e.clientSessionId===id),'native settled');
    const history=(await manager.request(id,'get_messages')).messages,answer=history.filter(m=>m.role==='assistant').at(-1);assert.ok(JSON.stringify(answer).includes('FIRST_'+marker));assert.ok(JSON.stringify(answer).includes('LAST_'+marker));
    const read=events.slice(before).find(e=>e.type==='tool_execution_start'&&e.toolName==='read'&&JSON.stringify(e.args).includes(saved.url));assert.ok(read,'native read tool used the local:// file');const end=events.slice(before).find(e=>e.type==='tool_execution_end'&&e.toolCallId===read.toolCallId);assert.ok(end&&!end.isError,'native read succeeded');return{tool:read.toolName,replyVerified:true};};
   const first=await ask();const written=await manager.request(id,'get_state');assert.equal(written.sessionId,initial.sessionId);await manager.close(id);
   // Simulate native Windows short-root cache eviction; durable journal assets remain.
   if(roots.local!==roots.canonical)fs.unlinkSync(path.join(roots.local,saved.name));
   events.splice(0,events.length);await open(written.sessionFile);const resumed=await manager.request(id,'get_state');assert.equal(resumed.sessionId,initial.sessionId);assert.equal(resumed.sessionFile,written.sessionFile);const second=await ask(true);
   checks.push({runtime,first,resume:second,nativeIdRetained:true,shortRoot:roots.local!==roots.canonical,bytes:Buffer.byteLength(text)});console.log(JSON.stringify({passed:true,...checks.at(-1)}));
  }finally{auth?.release();await manager.closeAll();}
 }
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks},null,2));console.log(JSON.stringify({passed:true,out}));
 }catch(error){console.error(error.message);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:error.message,checks,events:events.filter(e=>['tool_execution_start','tool_execution_end','prompt_result','process_error'].includes(e.type))},null,2));console.log(out);process.exitCode=1;}finally{clearTimeout(deadline);await manager?.closeAll();}})();
