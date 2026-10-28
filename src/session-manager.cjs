const path = require('node:path');
const {windowsSessionPath,wslSessionPath} = require('./client-settings.cjs');
const {validatePrompt}=require('./prompt-input.cjs');
const sessionKey = value => {const normalized=windowsSessionPath(value);return /^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(normalized)?'wsl:'+wslSessionPath(normalized):path.resolve(normalized).toLowerCase();};
function clientId(value = 'legacy') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new Error('无效客户端会话标识');
  return value;
}

// One native harness per conversation. This layer only owns routing and lifetime;
// prompt admission, queues, tools and cancellation remain native OMP operations.
class SessionManager {
  constructor({create, send,onState=async()=>{}}) {this.create=create; this.send=send; this.onState=onState;this.records=new Map(); this.files=new Map(); this.starting=new Set();}
  get(id) {const record=this.records.get(clientId(id)); if(!record) throw new Error('会话连接不存在，请重新打开历史会话'); return record;}
  emit(record,event){this.send({...event,clientSessionId:record.id,workRoot:record.root,runtime:record.settings?.runtime});}
  ownFile(record, file) {
    if(!file)return;
    const key=sessionKey(file), owner=this.files.get(key);
    if(owner && owner!==record.id) throw new Error('该历史会话已在另一会话中打开，请切换到已有会话');
    this.files.set(key,record.id); record.sessionFile=windowsSessionPath(file);
  }
  async start(id, prepare) {
    id=clientId(id);
    if(this.starting.has(id)||this.records.get(id)?.session.child)throw new Error('该会话已有活动 OMP 进程');
    this.starting.add(id);
    const record={id, questions:new Map(), sessionFile:'', busy:false};
    record.session=this.create(event=>{
      if(this.records.get(id)!==record)return;
      if(event.type==='agent_start')record.busy=true;
      if(event.type==='session_settled'||event.type==='process_exit')record.busy=false;
      if(event.type==='extension_ui_request') {
        if(['confirm','select','input','editor','ask'].includes(event.method))record.questions.set(event.id,event);
        if(event.method==='cancel')record.questions.delete(event.targetId);
      }
      if(event.type==='process_exit') {for(const [key,owner] of this.files)if(owner===id)this.files.delete(key);record.questions.clear();}
      this.send({...event,clientSessionId:id,workRoot:record.root,runtime:record.settings?.runtime});
    });
    this.records.set(id,record);
    try {
      return await prepare(async options=>{
        record.root=options.root;record.agentDir=options.agentDir;record.settings={...options.settings};record.nativeHistory=!!options.nativeHistory;
        this.ownFile(record,options.resume);
        this.emit(record,{type:'session_connecting'});
        const result=await record.session.start(options);
        return {...result,clientSessionId:id,agentDir:record.agentDir};
      });
    } catch(error) {
      if(!record.session.child){this.emit(record,{type:'process_error',message:error.message});this.records.delete(id);for(const [key,owner]of this.files)if(owner===id)this.files.delete(key);}
      throw error;
    } finally {this.starting.delete(id);}
  }
  async request(id,type,data) {
    if(type==='prompt')validatePrompt(data);
    const record=this.get(id);
    const prompt=type==='prompt',wasBusy=record.busy;
    if(prompt&&!wasBusy)this.emit(record,{type:'client_prompt'});
    if(['abort','abort_and_restore_queue'].includes(type))this.emit(record,{type:'client_stopping'});
    let result;
    try{result=type==='get_messages'?await record.session.messages():await record.session.request(type,data);}
    catch(error){if(prompt&&!wasBusy)this.emit(record,{type:'client_prompt_failed'});throw error;}
    if(prompt&&!wasBusy&&result?.agentInvoked===false)this.emit(record,{type:'client_command_complete'});
    if(type==='get_state'&&result?.sessionFile){this.ownFile(record,result.sessionFile);result.sessionFile=record.sessionFile;await this.onState(record);}
    if(type==='get_state')this.emit(record,{type:'session_state',sessionName:result?.sessionName||'',isSettled:result?.isSettled});
    return result;
  }
  respond(id,data){const record=this.get(id);if(!record.questions.has(data.id))throw new Error('该问题不属于当前会话或已结束');record.session.sendFrame(data);record.questions.delete(data.id);this.emit(record,{type:'question_resolved',id:data.id});}
  close(id){const record=this.records.get(clientId(id));if(record)this.emit(record,{type:'client_closing'});return record?record.session.close():Promise.resolve();}
  list(){return [...this.records.values()].filter(r=>r.session.child).map(r=>({id:r.id,root:r.root,agentDir:r.agentDir,sessionFile:r.sessionFile,runtime:r.settings.runtime,ready:r.session.ready,busy:r.busy,questions:[...r.questions.values()]}));}
  async closeAll(){await Promise.allSettled([...this.records.values()].map(r=>r.session.close()));}
}
module.exports={SessionManager,clientId};
