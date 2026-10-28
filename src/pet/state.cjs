const {settledOutcome}=require('../run-outcome.cjs');
const fs=require('node:fs/promises'),path=require('node:path');
const defaults=()=>({version:1,enabled:false,animated:true,alwaysOnTop:true,appearance:'duo',size:'medium',quiet:false,privacy:true,reducedMotion:false,closeToTray:true,notifyCompletion:true,notifyError:true,pinnedSessionId:'',position:null});
async function replacePreferences(temp,file){
 // Windows indexers/AV can briefly hold the destination without delete sharing.
 // Retry the atomic rename; never delete the previous preferences as a fallback.
 for(let attempt=0;;attempt++)try{await fs.rename(temp,file);return;}catch(error){if(attempt>=3||!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,50*2**attempt));}
}
function validate(patch,current=defaults()){
 if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('无效桌宠设置');
 const next={...current};
 for(const [key,value]of Object.entries(patch)){
  if(!Object.prototype.hasOwnProperty.call(next,key))throw Error('未知桌宠设置');
  if(key==='version'){if(value!==1)throw Error('不支持的桌宠设置版本');continue;}
  if(['enabled','animated','alwaysOnTop','quiet','privacy','reducedMotion','closeToTray','notifyCompletion','notifyError'].includes(key)){if(typeof value!=='boolean')throw Error('无效开关');}
  else if(key==='appearance'&&!['duo','cat'].includes(value)||key==='size'&&!['small','medium','large'].includes(value))throw Error('无效桌宠外观');
  else if(key==='pinnedSessionId'&&(typeof value!=='string'||value.length>100||value&&!/^[a-zA-Z0-9-]+$/.test(value)))throw Error('无效关注会话');
  else if(key==='position'&&value!==null&&(!value||typeof value!=='object'||!Number.isFinite(value.displayId)||!Number.isFinite(value.right)||!Number.isFinite(value.bottom)||Math.abs(value.right)>100000||Math.abs(value.bottom)>100000))throw Error('无效桌宠位置');
  next[key]=value;
 }
 return next;
}
class Preferences{
 constructor(directory){this.file=path.join(directory,'desktop-pet.json');this.value=defaults();this.pending=Promise.resolve();}
 async load(){try{this.value=validate(JSON.parse(await fs.readFile(this.file,'utf8')));}catch(e){if(e.code!=='ENOENT')this.warning='桌宠设置读取失败，已使用关闭状态的默认设置';}return this.value;}
 save(patch){const job=this.pending.then(async()=>{const next=validate(patch,this.value);await fs.mkdir(path.dirname(this.file),{recursive:true});const temp=this.file+'.tmp';await fs.writeFile(temp,JSON.stringify(next,null,2),'utf8');await replacePreferences(temp,this.file);this.value=next;return next;});this.pending=job.catch(()=>{});return job;}
}
const questions=new Set(['ask','confirm','select','input','editor']);
class PetState{
 constructor(){this.sessions=new Map();this.notices=new Map();this.sequence=0;}
 record(id,root=''){if(!this.sessions.has(id))this.sessions.set(id,{id,root,title:'',run:null,runId:0,connection:'connecting',updatedAt:Date.now()});const s=this.sessions.get(id);if(root)s.root=root;return s;}
 put(s,kind,key,now){const id=s.id+':'+key;if(this.notices.has(id))return;this.notices.set(id,{id,sessionId:s.id,runId:s.runId,kind,createdAt:now,order:++this.sequence,snoozed:false,read:false});this.trim();}
 trim(){const ordinary=[...this.notices.values()].filter(n=>n.kind!=='attention');while(ordinary.length>40)this.notices.delete(ordinary.shift().id);const closed=[...this.sessions.values()].filter(s=>s.connection==='closed');while(closed.length>80){const s=closed.shift();this.sessions.delete(s.id);for(const n of this.notices.values())if(n.sessionId===s.id)this.notices.delete(n.id);}}
 ingest(e,now=Date.now()){
  if(!e.clientSessionId)return false;
  // Ignore full message/tool payloads; only their phase discriminators are read.
  const accepted=['session_connecting','session_state','ready','client_prompt','client_prompt_failed','client_command_complete','client_closing','client_stopping','question_resolved','agent_start','agent_end','message_update','tool_execution_start','tool_execution_end','auto_retry_start','auto_retry_end','auto_compaction_start','auto_compaction_end','prompt_result','session_settled','process_exit','process_error','extension_ui_request'];
  if(!accepted.includes(e.type))return false;
  const s=this.record(e.clientSessionId,e.workRoot);let changed=true;
  const phase=name=>{if((s.run?.phase===name||s.run?.phase==='stopping')&&s.run.active){changed=false;return;}if(!s.run?.active){s.runId++;s.run={active:true,phase:name,startedAt:now};}else s.run={...s.run,phase:name};};
  if(e.type==='session_state'){s.title=typeof e.sessionName==='string'?e.sessionName.slice(0,160):s.title;}
  else if(e.type==='ready')s.connection='ready';
  else if(e.type==='client_closing'){s.connection='closing';for(const n of this.notices.values())if(n.sessionId===s.id)this.notices.delete(n.id);}
  else if(e.type==='client_prompt'||e.type==='agent_start'){if(!s.run?.active){for(const n of this.notices.values())if(n.sessionId===s.id&&n.kind!=='attention')this.notices.delete(n.id);phase('working');}}
  else if(e.type==='client_command_complete'){if(s.run?.active)s.run={...s.run,active:false,phase:'idle'};}
  else if(e.type==='client_stopping'){if(s.run?.active)s.run={...s.run,phase:'stopping'};}
  else if(e.type==='message_update'){const t=(e.assistantMessageEvent||e.delta||{}).type||'';if(t.startsWith('thinking'))phase('thinking');else if(t.startsWith('text'))phase('working');else if(t.startsWith('toolcall'))phase('working');else changed=false;}
  else if(e.type==='tool_execution_start'||e.type==='tool_execution_end'||e.type==='auto_compaction_end'||e.type==='auto_retry_end')phase('working');
  else if(e.type==='auto_retry_start')phase('retrying');
  else if(e.type==='auto_compaction_start')phase('compacting');
  else if(e.type==='agent_end'&&s.run?.active)phase('settling');
  else if(e.type==='extension_ui_request'){
   if(questions.has(e.method)&&typeof e.id==='string')this.put(s,'attention','q:'+e.id,now);
   else if(e.method==='cancel')this.notices.delete(s.id+':q:'+e.targetId);
   else changed=false;
  }else if(e.type==='question_resolved')this.notices.delete(s.id+':q:'+e.id);
  if(e.type==='prompt_result'&&e.sessionSettled===false){phase('background');s.run.outcome=e.status;}
  const outcome=e.type==='client_prompt_failed'?'error':settledOutcome(s.run,e);
  if(outcome){const wasActive=s.run?.active;s.run={...s.run,active:false,phase:outcome,outcome};if(wasActive&&outcome!=='aborted'&&s.connection!=='closing')this.put(s,outcome,outcome+':'+s.runId,now);}
  if(e.type==='process_exit'||e.type==='process_error'){
   if((e.type==='process_error'||e.code)&&s.connection!=='closing')this.put(s,'error','error:'+s.runId,now);
   s.connection='closed';for(const n of this.notices.values())if(n.sessionId===s.id&&n.kind==='attention')this.notices.delete(n.id);
  }
  if(changed)s.updatedAt=now;this.trim();return changed;
 }
 snapshot(settings,now=Date.now()){
  const sessions=[...this.sessions.values()].map(s=>({id:s.id,root:settings.privacy?'':s.root,title:settings.privacy?'会话 '+s.id.slice(0,6):s.title||s.root.split(/[\\/]/).pop()||'OMP 会话',phase:s.run?.phase||'idle',active:!!s.run?.active,connection:s.connection,updatedAt:s.updatedAt}));
  const rank={attention:0,error:1,completed:2};
  const notices=[...this.notices.values()].filter(n=>n.kind==='attention'||n.kind==='error'&&settings.notifyError||n.kind==='completed'&&settings.notifyCompletion&&(!settings.pinnedSessionId||settings.pinnedSessionId===n.sessionId)).sort((a,b)=>rank[a.kind]-rank[b.kind]||a.order-b.order).map(n=>({...n,title:sessions.find(s=>s.id===n.sessionId)?.title||'OMP 会话',popup:!n.snoozed&&!n.read&&(n.kind!=='completed'||now-n.createdAt<6000)}));
  const focus=sessions.find(s=>s.id===settings.pinnedSessionId)||sessions.find(s=>s.active)||sessions[0];
  const urgent=notices.find(n=>n.kind==='attention'),failure=notices.find(n=>n.kind==='error'&&!n.read);
  return {sessions,notices,activeCount:sessions.filter(s=>s.active).length,pendingCount:notices.filter(n=>n.kind==='attention').length,phase:urgent?'attention':failure?'error':focus?.connection==='connecting'?'connecting':focus?.connection==='closed'?'disconnected':focus?.phase||'idle',focusId:focus?.id||'',settings};
 }
 snooze(id){const n=this.notices.get(id);if(!n)throw Error('提示已失效');n.snoozed=true;}
 read(id){const n=this.notices.get(id);if(n&&n.kind!=='attention'){n.read=true;n.snoozed=true;}}
}
module.exports={PetState,Preferences,defaults,validate};
