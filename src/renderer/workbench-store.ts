import type {Desktop, Work, History, HistoryEntry, OmpEvent, WorkEvent} from './types';
import {emptyView, nativeQueue, projectEvent, restoreMessages, textContent, type SessionView, type Queued} from './session-view';
import {normalizeCommands, type SlashCommand} from './command-completion';
import {errorText} from './errors';
const uid = () => crypto.randomUUID();
const label = (s: OmpEvent) => typeof s.model === 'string' ? s.model : s.model?.name || s.model?.id || 'OMP 默认模型';
const fileKey = (p?: string) => (p || '').replaceAll('\\','/').toLowerCase();
type WorkData = {history: History|null; historyError:string; document:string; documentError:string; documentLoading:boolean; documentUpdated:string; historyRevision:number; documentRevision:number};
const blankWork = (): WorkData => ({history:null,historyError:'',document:'',documentError:'',documentLoading:false,documentUpdated:'',historyRevision:0,documentRevision:0});

// A controller stays bound to its work and ID across all asynchronous operations.
// OMP alone owns generation, tools, message queues and cancellation.
class Conversation {
  connection: 'idle'|'starting'|'ready'|'closing' = 'idle';
  view: SessionView = emptyView();
  sessionName=''; sessionFile=''; agentDir=''; runtime=''; error=''; unread=false;
  events:WorkEvent[]=[]; questions:OmpEvent[]=[]; nativeCommands:SlashCommand[]=[];
  commandsStatus:'idle'|'loading'|'ready'|'error'='idle'; commandsError='';
  starting:Promise<void>|null=null; commandTask:Promise<void>|null=null;
  closing:Promise<boolean>|null=null;
  sending=false; importing=false; generation=0; model='OMP 默认模型';
  waiting: {resolve:()=>void;reject:(error:Error)=>void}|null=null;
  historyPending=false;
  loadingHistory=false; retryHistory=false;
  entry?:HistoryEntry;
  constructor(public owner:Workbench,public work:Work,public id:string=uid(),public draftKey=work.root) {}
  get title(){return this.sessionName||textContent(this.view.messages.find(m=>m.role==='user')?.content).slice(0,240).replace(/\s+/g,' ').slice(0,60)||(this.sessionFile?'已恢复的会话':'新会话');}
  get busy(){return !!this.view.run?.active;}
  changed=()=>this.owner.changed();
  request=(type:string,data?:OmpEvent)=>this.owner.api.request(type,data,this.id);
  setError=(message:string)=>{this.error=message;this.changed();};
  log=(text:string,level:WorkEvent['level']='info',detail?:string)=>{this.events=[{id:uid(),time:new Date().toLocaleTimeString('zh-CN',{hour12:false}),text,level,detail,root:this.work.root},...this.events].slice(0,200);this.changed();};
  report=(e:unknown)=>{const message=errorText(e);this.error=message.split('\n')[0];if(this.owner.activeId!==this.id)this.unread=true;this.log('操作失败','error',message);};
  dispatch=(event:OmpEvent)=>{const next=projectEvent(this.view,event);if(next===this.view)return;this.view=next;if(event.type==='message_update'||event.type==='tool_execution_update')this.owner.streamChanged();else this.changed();};
  syncState=(state:OmpEvent)=>{this.sessionName=state.sessionName||'';this.sessionFile=state.sessionFile||this.sessionFile;this.model=label(state);this.owner.persist();this.changed();};
  ready=async(reattaching=false)=>{
    if(this.loadingHistory){if(reattaching)this.retryHistory=true;return;}
    this.loadingHistory=true;
    const generation=this.generation;
    try {
      // OMP refuses paged history while generating. Reattaching a view must
      // never close the existing writer; defer its history until settlement.
      let restoredState:OmpEvent|undefined;
      if(reattaching){
        this.historyPending=true;
        restoredState=await this.request('get_state');
        if(generation!==this.generation)return;
        const changing=restoredState.isSettled===false||restoredState.isStreaming||restoredState.isCompacting;
        if(changing){
          if(!this.busy)this.dispatch({type:'agent_start'});
          this.view={...this.view,queued:nativeQueue(restoredState.queuedMessages)};
          this.syncState(restoredState);this.connection='ready';this.log('已接回运行中的任务；本轮结束后恢复完整历史');
          await this.request('set_ask_dialog',{enabled:true});return;
        }
        if(restoredState.isSettled===true)this.dispatch({type:'session_settled'});
      }
      const [messages,state]=await Promise.all([this.request('get_messages'),restoredState||this.request('get_state'),this.request('set_ask_dialog',{enabled:true})]);
      if(generation!==this.generation)return;
      this.historyPending=false;
      this.view={...this.view,messages:[...restoreMessages(messages.messages||[]),...this.view.messages.filter(m=>m.optimistic)],queued:nativeQueue(state.queuedMessages)};
      this.syncState(state);this.connection='ready';this.waiting?.resolve();this.waiting=null;
      this.log(this.view.messages.length?'OMP 已连接，历史记录已恢复':'OMP 已连接');void this.owner.refreshHistory(this.work.root);
    }catch(e){if(generation!==this.generation)return;if(reattaching){this.historyPending=true;this.connection='ready';this.log('历史暂时未载入，后台任务保持运行','warning',errorText(e));return;}this.report(e);this.waiting?.reject(e instanceof Error?e:new Error(String(e)));this.waiting=null;void this.owner.api.close(this.id).catch(this.report);}
    finally{this.loadingHistory=false;const retry=this.retryHistory;this.retryHistory=false;if(retry&&this.historyPending&&generation===this.generation)void this.ready(true);}
  };
  event=(event:OmpEvent)=>{
    if(event.runtime)this.runtime=event.runtime;
    if(event.type==='ready'){void this.ready();return;}
    if(event.type==='available_commands_update'){
      try{this.nativeCommands=normalizeCommands(event.commands);this.commandsStatus='ready';this.commandsError='';this.changed();}catch(e){this.commandsStatus='error';this.commandsError=String(e);this.changed();}return;
    }
    this.dispatch(event);
    if(event.type==='question_resolved'){this.questions=this.questions.filter(q=>q.id!==event.id);this.changed();return;}
    if(this.historyPending&&(event.type==='session_settled'||event.type==='prompt_result'&&event.sessionSettled!==false))void this.ready(true);
    if(['process_exit','process_error'].includes(event.type)){
      const closing=this.connection==='closing';this.connection='idle';this.generation++;this.commandsStatus='idle';this.nativeCommands=[];this.questions=[];
      this.waiting?.reject(new Error(event.message||'OMP 已退出'));this.waiting=null;
      if(event.type==='process_error'||event.code&&!closing)this.report(event.message||'OMP 异常退出，可重新打开历史会话');
      this.log('会话连接已结束');return;
    }
    if(['stderr','diagnostic'].includes(event.type)){this.log(event.message||event.type);return;}
    if(event.type==='extension_ui_request'){
      if(['confirm','select','input','editor','ask'].includes(event.method)){this.questions=[...this.questions,event];if(this.owner.activeId!==this.id)this.unread=true;}
      else if(event.method==='cancel')this.questions=this.questions.filter(q=>q.id!==event.targetId);
      else if(event.method==='notify'){this.log(event.message||'OMP 通知');if(event.notifyType==='error')this.report(event.message);}
      this.changed();return;
    }
    if(event.type==='prompt_result'){
      if(this.owner.activeId!==this.id)this.unread=true;
      if(event.status==='error')this.report(event.error?.message||'模型请求失败');
      else this.log(event.status==='aborted'?'已停止生成':'本轮生成完成',event.status==='aborted'?'warning':'success');
      const generation=this.generation;void this.request('get_state').then(state=>{if(generation===this.generation)this.syncState(state);}).catch(()=>{});
      void this.owner.refreshHistory(this.work.root);
    }
    if(event.type==='message_end'&&event.message?.stopReason==='error')this.report(event.message.errorMessage||'模型请求失败');
    if(event.type==='tool_execution_start')this.log((event.toolName||'工具')+' · 开始执行');
    if(event.type==='tool_execution_end')this.log((event.toolName||'工具')+' · '+(event.isError?'失败':'完成'),event.isError?'error':'success');
    if(event.type==='auto_retry_start')this.log('OMP 自动重试 · 第 '+(event.attempt??1)+' 次','warning');
    if(event.type==='auto_compaction_start')this.log('OMP 正在整理上下文');
  };
  start=():Promise<void>=>{
    if(this.starting)return this.starting;
    if(this.connection==='ready')return Promise.resolve();
    if(this.connection==='closing')return Promise.reject(new Error('正在结束当前会话，请稍候'));
    if(this.work.kind==='invalid')return Promise.reject(new Error('请先选择有效工作区'));
    this.connection='starting';this.generation++;this.error='';this.commandsStatus='loading';this.changed();
    this.starting=(async()=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      const waiting=new Promise<void>((resolve,reject)=>{this.waiting={resolve,reject};timer=setTimeout(()=>reject(new Error('OMP 启动超时，请查看事件')),75000);});waiting.catch(()=>{});
      try {
        const result=await this.owner.api.start({root:this.work.root,clientSessionId:this.id,resume:this.entry?.sessionFile,agentDir:this.entry?.agentDir,runtime:this.entry?.runtime}) as OmpEvent;
        this.runtime=result.runtime||this.runtime;this.agentDir=result.agentDir||this.agentDir;await waiting;
        this.rememberEntry();this.owner.persist();
      } catch(e){this.waiting=null;await this.owner.api.close(this.id).catch(()=>{});this.connection='idle';this.changed();throw e;}
      finally{clearTimeout(timer);this.starting=null;}
    })();return this.starting;
  };
  rememberEntry=()=>{if(this.sessionFile&&this.agentDir)this.entry={...this.entry,sessionFile:this.sessionFile,agentDir:this.agentDir,runtime:this.runtime as 'wsl'|'windows'};};
  loadCommands=(force=false):Promise<void>=>{
    if(this.commandTask)return this.commandTask;
    if(!force&&this.commandsStatus==='ready'&&this.connection==='ready')return Promise.resolve();
    this.commandsStatus='loading';this.commandsError='';this.changed();
    this.commandTask=(async()=>{try{await this.start();const result=await this.request('get_available_commands');this.nativeCommands=normalizeCommands(result.commands);this.commandsStatus='ready';}catch(e){this.commandsStatus='error';this.commandsError=errorText(e);}finally{this.commandTask=null;this.changed();}})();return this.commandTask;
  };
  send=async(text:string,images:OmpEvent[]=[])=>{
    if(this.sending||this.connection==='closing'||this.importing||this.view.run?.phase==='stopping')return false;
    this.sending=true;this.error='';const queued=this.busy,id=uid();
    if(!queued)this.dispatch({type:'local_send',id,text,images,connecting:this.connection!=='ready'});
    try{await this.start();const result=await this.request('prompt',{message:text,images,streamingBehavior:'followUp'});
      if(result?.agentInvoked===false){if(!queued)this.dispatch({type:'local_command_complete',id});void this.request('get_state').then(this.syncState).catch(()=>{});}
      this.log(queued?'消息已加入 OMP 待处理队列':'消息已提交');this.owner.persist();return true;
    }catch(e){if(!queued)this.dispatch({type:'local_send_failed',id});this.report(e);return false;}finally{this.sending=false;this.changed();}
  };
  close=():Promise<boolean>=>{
    if(this.closing)return this.closing;
    if(this.busy||this.starting||this.sending||this.importing){this.setError('请先停止当前任务，再结束会话连接');return Promise.resolve(false);}
    if(this.connection==='idle')return Promise.resolve(true);
    this.connection='closing';this.changed();
    this.closing=(async()=>{
      try{await this.owner.api.close(this.id);this.connection='idle';this.rememberEntry();this.changed();void this.owner.refreshHistory(this.work.root);return true;}
      catch(e){this.connection='ready';this.report(e);return false;}
      finally{this.closing=null;}
    })();return this.closing;
  };
  stop=async()=>{
    if(!this.busy||this.view.run?.phase==='stopping')return;
    this.dispatch({type:'local_stop'});this.log('已请求停止当前生成','warning');
    try{const result=await this.request('abort_and_restore_queue');if(result.truncated||result.imagesDropped)this.report('待处理消息不完整，请检查草稿和事件');return [...(result.steering||[]),...(result.followUp||[])];}
    catch(e){this.dispatch({type:'local_stop_failed'});this.report(e);}
  };
  removeQueued=async(item:Queued)=>{try{await this.request('remove_queued_message',item);}catch(e){this.report(e);}};
  changeModel=async(provider:string,modelId:string)=>{if(this.busy||this.sending||this.connection==='closing')throw new Error('请先停止当前会话的生成，再切换模型');await this.start();const model=await this.request('set_model',{provider,modelId});this.model=model.name||model.id||modelId;this.changed();};
  answer=async(response:OmpEvent)=>{const question=this.questions[0];if(!question)return;try{await this.owner.api.respond({type:'extension_ui_response',id:question.id,...response},this.id);this.questions=this.questions.filter(q=>q.id!==question.id);this.error='';this.changed();}catch(e){this.report(e);throw e;}};
}

export class Workbench {
  works:Work[]=[];loading=true;activeId='';sessions=new Map<string,Conversation>();data=new Map<string,WorkData>();
  lastByWork=new Map<string,string>();listeners=new Set<()=>void>();revision=0;off?:()=>void;disposed=false;
  fallback=new Conversation(this,{name:'',root:'',kind:'invalid'},'unselected','');
  offNavigate?:()=>void;pendingSelection='';
  constructor(public api:Desktop){}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  snapshot=()=>this.revision;
  notifyTimer:ReturnType<typeof setTimeout>|undefined;
  changed=()=>{clearTimeout(this.notifyTimer);this.notifyTimer=undefined;this.revision++;for(const listener of this.listeners)listener();};
  streamChanged=()=>{if(this.notifyTimer===undefined)this.notifyTimer=setTimeout(()=>this.changed(),32);};
  get active(){return this.sessions.get(this.activeId)||this.fallback;}
  workData=(root:string)=>{if(!this.data.has(root))this.data.set(root,blankWork());return this.data.get(root)!;};
  persist=()=>{try{localStorage.setItem('omp.openSessions.v1',JSON.stringify({activeId:this.activeId,sessions:[...this.sessions.values()].map(s=>({id:s.id,root:s.work.root,draftKey:s.draftKey,title:s.title,sessionFile:s.sessionFile,agentDir:s.agentDir,runtime:s.runtime,source:s.entry?.path}))}));}catch{this.active.error='会话列表暂时无法保存，请保留草稿';}};
  connect=()=>{this.disposed=false;this.off=this.api.onEvent(event=>{const target=this.sessions.get(event.clientSessionId)||(!event.clientSessionId?this.active:undefined);target?.event(event);});this.offNavigate=this.api.onPetNavigate?.(({id})=>{if(this.sessions.has(id))this.selectSession(id);else this.pendingSelection=id;});void this.initialize();};
  dispose=()=>{this.disposed=true;this.off?.();this.offNavigate?.();clearTimeout(this.notifyTimer);this.notifyTimer=undefined;};
  initialize=async()=>{
    await this.loadWorks();if(this.disposed)return;
    let saved:any;try{saved=JSON.parse(localStorage.getItem('omp.openSessions.v1')||'null');}catch{}
    const live=await this.api.listConnections?.().catch(()=>[])||[];
    for(const item of Array.isArray(saved?.sessions)?saved.sessions:[]){const work=this.works.find(w=>w.root===item.root);if(!work||typeof item.id!=='string')continue;const s=new Conversation(this,work,item.id,item.draftKey||item.id);s.sessionName=item.title||'';s.sessionFile=item.sessionFile||'';s.agentDir=item.agentDir||'';s.runtime=item.runtime||'';if(s.sessionFile&&s.agentDir)s.entry={sessionFile:s.sessionFile,agentDir:s.agentDir,runtime:s.runtime as 'wsl'|'windows',path:item.source};this.sessions.set(s.id,s);this.lastByWork.set(work.root,s.id);}
    for(const item of live){const work=this.works.find(w=>w.root===item.root);if(!work)continue;const s=this.sessions.get(item.id)||new Conversation(this,work,item.id,item.id);s.agentDir=item.agentDir;s.runtime=item.runtime;s.sessionFile=item.sessionFile;s.connection='starting';s.questions=item.questions||[];this.sessions.set(s.id,s);this.lastByWork.set(work.root,s.id);if(item.busy)s.dispatch({type:'agent_start'});if(item.ready)void s.ready(true);}
    if(this.sessions.has(saved?.activeId))this.selectSession(saved.activeId);
    else{const work=this.works.find(w=>w.root===localStorage.getItem('omp.work'));if(work)this.selectWork(work);}
    if(this.pendingSelection){this.selectSession(this.pendingSelection);this.pendingSelection='';}
    this.changed();
  };
  loadWorks=async()=>{this.loading=true;this.changed();try{
    this.works=await this.api.listWorks();
    for(const session of this.sessions.values()){
      const next=this.works.find(work=>work.root===session.work.root);if(!next)continue;
      const previous=session.work;session.work=next;
      if(previous.kind==='invalid'&&next.kind!=='invalid'){
        if(session.error===(previous.error||'工作区校验失败'))session.error='';
        if(session===this.active){void this.refreshHistory(next.root);void this.refreshDocument(next.root);}
      }
    }
  }catch(e){this.active.report(e);}finally{this.loading=false;this.changed();}};
  selectSession=(id:string)=>{const s=this.sessions.get(id);if(!s)return;this.activeId=id;s.unread=false;this.lastByWork.set(s.work.root,id);this.persist();this.changed();if(s.work.kind==='invalid'){s.setError(s.work.error||'工作区校验失败');return;}void this.refreshHistory(s.work.root);if(!this.workData(s.work.root).document)void this.refreshDocument(s.work.root);if(s.entry?.sessionFile&&!s.view.messages.length&&s.connection==='idle')void s.start().catch(s.report);};
  selectWork=async(work:Work)=>{const previous=this.lastByWork.get(work.root);if(previous&&this.sessions.has(previous)){this.selectSession(previous);return;}this.create(work,work.root);};
  create=(work:Work,draftKey?:string)=>{const s=new Conversation(this,work,uid(),draftKey||uid());this.sessions.set(s.id,s);this.selectSession(s.id);return s;};
  newSession=async()=>{if(!this.active.work.root)return false;this.create(this.active.work);return true;};
  dismiss=async(id:string)=>{const s=this.sessions.get(id);if(!s||!await s.close())return;this.sessions.delete(id);if(this.activeId===id){const next=[...this.sessions.values()].find(x=>x.work.root===s.work.root);if(next)this.selectSession(next.id);else this.create(s.work);}this.persist();this.changed();};
  refreshHistory=async(root=this.active.work.root)=>{if(!root)return;const d=this.workData(root),revision=++d.historyRevision;d.historyError='';try{const history=await this.api.listHistory(root);if(revision===d.historyRevision)d.history=history;}catch(e){if(revision===d.historyRevision)d.historyError=errorText(e);}this.changed();};
  refreshDocument=async(root=this.active.work.root)=>{if(!root)return;const d=this.workData(root),revision=++d.documentRevision;d.documentLoading=true;d.documentError='';this.changed();try{const content=await this.api.readWork(root);if(revision===d.documentRevision){d.document=content;d.documentUpdated=new Date().toLocaleTimeString('zh-CN',{hour12:false});}}catch(e){if(revision===d.documentRevision)d.documentError=errorText(e);}finally{if(revision===d.documentRevision)d.documentLoading=false;this.changed();}};
  imports=new Map<string,Promise<void>>();
  resume=async(entry?:HistoryEntry)=>{
    const origin=this.active,work=origin.work;if(!work.root)return;
    try{
      if(!entry){const source=await this.api.chooseSession();if(!source)return;entry={path:source};}
      const source=fileKey(entry.sessionFile||entry.path),pending=this.imports.get(source);if(pending)return pending;
      const existing=[...this.sessions.values()].find(s=>fileKey(s.sessionFile)===source||fileKey(s.entry?.path)===source);
      if(existing){this.selectSession(existing.id);if(existing.closing)await existing.closing;if(existing.connection==='idle'||existing.connection==='starting')await existing.start();return;}
      const selectedEntry=entry;
      const task=(async()=>{
        const runtime=(await this.api.getSettings()).settings.runtime;
        let selected=selectedEntry;
        if(selectedEntry.path||selectedEntry.runtime&&selectedEntry.runtime!==runtime)selected=await this.api.importSession(selectedEntry.sessionFile||selectedEntry.path!,work.root);
        const s=this.create(work);s.entry={...selected,path:selectedEntry.path};s.sessionFile=selected.sessionFile||'';s.agentDir=selected.agentDir||'';s.sessionName=selectedEntry.title||'';s.runtime=runtime;
        this.persist();try{await s.start();}catch(e){s.report(e);}
      })();this.imports.set(source,task);try{await task;}finally{this.imports.delete(source);}
    }catch(e){origin.report(e);}
  };
  view(){
    const s=this.active,d=this.workData(s.work.root);
    return {works:this.works,loading:this.loading,work:s.work.root?s.work:null,...d,...s.view,connection:s.connection,busy:s.busy,model:s.model,error:s.error,events:s.events,questions:s.questions,title:s.title,sessionFile:s.sessionFile,
      id:s.id,draftKey:s.draftKey,runtime:s.runtime,sessions:[...this.sessions.values()].map(c=>({id:c.id,root:c.work.root,title:c.title,busy:c.busy,connection:c.connection,unread:c.unread,questions:c.questions.length,error:!!c.error,outcome:c.view.run?.outcome,report:c.report})),
      report:s.report,setError:s.setError,log:s.log,loadWorks:this.loadWorks,selectWork:this.selectWork,selectSession:this.selectSession,newSession:this.newSession,dismiss:this.dismiss,
      refreshHistory:this.refreshHistory,refreshDocument:this.refreshDocument,start:s.start,send:s.send,resume:this.resume,close:s.close,stop:s.stop,answer:s.answer,changeModel:s.changeModel,removeQueued:s.removeQueued,request:s.request,
      nativeCommands:s.nativeCommands,commandsStatus:s.commandsStatus,commandsError:s.commandsError,loadCommands:s.loadCommands};
  }
}

