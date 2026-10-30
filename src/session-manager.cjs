const path = require('node:path');
const {windowsSessionPath,wslSessionPath} = require('./client-settings.cjs');
const {validatePrompt}=require('./prompt-input.cjs');
const {resultExcerpt}=require('./result-excerpt.cjs');
const {waitForStartup}=require('./startup-control.cjs');
const {validateAttachments,writeTextAttachments,restoreTextAttachments}=require('./text-attachments.cjs');
const sessionKey = value => {const normalized=windowsSessionPath(value);return /^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(normalized)?'wsl:'+wslSessionPath(normalized):path.resolve(normalized).toLowerCase();};
function clientId(value = 'legacy') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new Error('无效客户端会话标识');
  return value;
}

// One native harness per conversation. This layer only owns routing and lifetime;
// prompt admission, queues, tools and cancellation remain native OMP operations.
class SessionManager {
  constructor({create, send,onState=async()=>{},writeAttachments=writeTextAttachments,restoreAttachments=restoreTextAttachments,startTimeout=60000,titles}) {this.create=create; this.send=send; this.onState=onState;this.writeAttachments=writeAttachments;this.restoreAttachments=restoreAttachments;this.startTimeout=startTimeout;this.titles=titles;this.records=new Map(); this.files=new Map(); this.starting=new Set();this.journalMutations=new Map();}
  reserveJournal(file,id) {
    const key=sessionKey(file);
    if(this.journalMutations.has(key))throw Error('该会话正在移入回收站或恢复，请稍候');
    if([...this.records.values()].some(r=>(r.session.child||this.starting.has(r.id))&&((r.sessionFile&&sessionKey(r.sessionFile)===key)||(id&&r.nativeId===id))))throw Error('该会话仍有连接，请先停止任务并结束该会话的连接，再删除。其他会话不受影响。');
    this.journalMutations.set(key,id);
    return ()=>this.journalMutations.delete(key);
  }
  get(id) {const record=this.records.get(clientId(id)); if(!record) throw new Error('会话连接不存在，请重新打开历史会话'); return record;}
  emit(record,event){this.send({...event,clientSessionId:record.id,workRoot:record.root,runtime:record.settings?.runtime});}
  ownFile(record, file) {
    if(!file)return;
    const key=sessionKey(file), owner=this.files.get(key);
    if(this.journalMutations.has(key))throw Error('该历史会话正在移入回收站或恢复，请稍候');
    if(owner && owner!==record.id) throw new Error('该历史会话已在另一会话中打开，请切换到已有会话');
    this.files.set(key,record.id); record.sessionFile=windowsSessionPath(file);
  }
  ownIdentity(record,id){
    if(!id)return;
    if([...this.journalMutations.values()].includes(id))throw Error('该历史会话正在移入回收站或恢复，请稍候');
    const owner=[...this.records.values()].find(other=>other!==record&&other.nativeId===id&&other.settings?.runtime===record.settings?.runtime&&(other.session.child||this.starting.has(other.id)));
    if(owner)throw Error('该原生会话 ID 已在另一连接中使用。原件与旧副本可能共享 ID，请先结束其中一个连接，或创建新的独立副本。');
    record.nativeId=id;
  }
  async start(id, prepare, {root}={}) {
    id=clientId(id);
    if(this.starting.has(id)||this.records.get(id)?.session.child)throw new Error('该会话已有活动 OMP 进程');
    this.starting.add(id);
    const controller=new AbortController(),signal=controller.signal;
    const record={id,root,controller, questions:new Map(), sessionFile:'', busy:false};
    let phase='正在准备会话';
    const progress=value=>{if(!signal.aborted&&this.records.get(id)===record){phase=value;this.emit(record,{type:'connection_progress',phase});}};
    const timer=setTimeout(()=>controller.abort(Error(`会话启动超时：${phase}，请重试`)),this.startTimeout);
    record.session=this.create(event=>{
      if(this.records.get(id)!==record)return;
      if(event.type==='agent_start')record.busy=true;
      if(event.type==='session_settled'||event.type==='process_exit')record.busy=false;
      if(event.type==='extension_ui_request') {
        if(['confirm','select','input','editor','ask'].includes(event.method))record.questions.set(event.id,event);
        if(event.method==='cancel')record.questions.delete(event.targetId);
      }
      if(event.type==='process_exit') {for(const [key,owner] of this.files)if(owner===id)this.files.delete(key);record.questions.clear();}
      this.titles?.observe(record,event,this);
      this.send({...event,clientSessionId:id,workRoot:record.root,runtime:record.settings?.runtime});
    });
    this.records.set(id,record);
    try {
      return await waitForStartup(prepare(async options=>{
        signal.throwIfAborted();
        record.root=options.root;record.agentDir=options.agentDir;record.settings={...options.settings};record.nativeHistory=!!options.nativeHistory;
        record.expectedResume=options.fork?undefined:options.resume;
        record.forkSource=options.fork?options.resume:undefined;record.importRoot=options.importRoot;
        if(!options.fork)this.ownIdentity(record,options.resumeId);
        this.ownFile(record,options.resume);
        this.emit(record,{type:'session_connecting'});
        progress('正在启动 OMP');
        const result=await record.session.start({...options,signal});
        return {...result,clientSessionId:id,agentDir:record.agentDir};
      },signal,progress),signal);
    } catch(error) {
      if(!record.session.child){this.emit(record,{type:'process_error',message:error.message});this.records.delete(id);for(const [key,owner]of this.files)if(owner===id)this.files.delete(key);}
      throw error;
    } finally {clearTimeout(timer);this.starting.delete(id);}
  }
  async request(id,type,data) {
    if(type==='prompt')validatePrompt(data);
    const record=this.get(id);
    const titleRevision=type==='get_messages'?this.titles?.revision(record):undefined;
    if(['prompt','set_session_name','abort','abort_and_restore_queue'].includes(type))this.titles?.cancel(record);
    const prompt=type==='prompt',wasBusy=record.busy;
    if(prompt&&!wasBusy)this.emit(record,{type:'client_prompt',titleHint:resultExcerpt(data.message,120)||(data.images?.length?'图片任务':'')});
    if(['abort','abort_and_restore_queue'].includes(type))this.emit(record,{type:'client_stopping'});
    let result;
    try{result=type==='get_messages'?await record.session.messages():await record.session.request(type,data);}
    catch(error){if(prompt&&!wasBusy)this.emit(record,{type:'client_prompt_failed'});throw error;}
    if(prompt&&!wasBusy&&result?.agentInvoked===false)this.emit(record,{type:'client_command_complete'});
    if(type==='get_state'&&result?.sessionFile){
      if(record.expectedResume&&sessionKey(record.expectedResume)!==sessionKey(result.sessionFile))throw Error('OMP 未在所选原会话中续聊，可能被另一进程占用或已迁出。请先结束原会话的其他连接，再重试；原记录和草稿已保留。');
      this.ownIdentity(record,result.sessionId);this.ownFile(record,result.sessionFile);result.sessionFile=record.sessionFile;await this.onState(record);record.expectedResume=undefined;
      if(record.settings.runtime==='windows'&&record.attachmentsRestored!==record.sessionFile){await this.restoreAttachments({sessionFile:record.sessionFile,sessionId:record.nativeId,runtime:'windows'});record.attachmentsRestored=record.sessionFile;}
    }
    if(type==='get_state')this.emit(record,{type:'session_state',sessionName:result?.sessionName||'',isSettled:result?.isSettled});
    if(type==='get_messages'){
      this.titles?.restore(record,result?.messages,this,titleRevision);
      const first=result?.messages?.find(m=>m.role==='user');
      const titleHint=resultExcerpt(first?.content,120)||(first?.content?.some?.(b=>b?.type==='image')?'图片任务':'');
      if(titleHint)this.emit(record,{type:'session_metadata',titleHint});
    }
    return result;
  }
  async prepareTextAttachments(id,files){
    const input=validateAttachments(files),record=this.get(id);
    await this.request(id,'get_state');
    if(this.records.get(id)!==record||!record.session.child)throw Error('会话连接已变更，文本附件仍保留在草稿中');
    const state={sessionFile:record.sessionFile,sessionId:record.nativeId,runtime:record.settings.runtime};
    const saved=await this.writeAttachments(state,input);
    if(this.records.get(id)!==record||!record.session.child||record.sessionFile!==state.sessionFile)throw Error('会话连接已变更，文本附件仍保留在草稿中');
    return saved;
  }
  respond(id,data){const record=this.get(id);if(!record.questions.has(data.id))throw new Error('该问题不属于当前会话或已结束');record.session.sendFrame(data);record.questions.delete(data.id);this.emit(record,{type:'question_resolved',id:data.id});}
  close(id){const record=this.records.get(clientId(id));if(record){this.titles?.cancel(record);record.controller.abort(Error('会话启动已取消'));this.emit(record,{type:'client_closing'});}return record?record.session.close():Promise.resolve();}
  list(){return [...this.records.values()].filter(r=>r.session.child).map(r=>({id:r.id,root:r.root,agentDir:r.agentDir,sessionFile:r.sessionFile,runtime:r.settings.runtime,ready:r.session.ready,busy:r.busy,questions:[...r.questions.values()]}));}
  async closeAll(){await Promise.allSettled([...this.records.values()].map(r=>this.close(r.id)));}
}
module.exports={SessionManager,clientId,sessionKey};
