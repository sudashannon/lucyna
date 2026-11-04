import type {OmpEvent} from './types';

export type TaskStatus = 'running'|'stopping'|'completed'|'failed'|'aborted'|'unknown';
export type SessionTask = {
  key:string; id:string; kind:'agent'|'job'|'daemon'; title:string; status:TaskStatus;
  parentToolCallId?:string; ownerId?:string; sessionFile?:string; startedAt?:number; endedAt?:number;
  durationMs?:number; resultAt?:number;
  command?:string; cwd?:string; output:string; detail:string; error?:string; exitCode?:number;
  stale:boolean; cancellable:boolean; revision:number; cursor?:number; history?:string; expanded?:boolean;
};
const terminal=(s:TaskStatus)=>['completed','failed','aborted'].includes(s);
const tail=(s:unknown,limit=65536)=>typeof s==='string'?s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(-limit):'';
const status=(s:string):TaskStatus=>({started:'running',pending:'running',ready:'running',starting:'running',restarting:'running',cancelled:'aborted',exited:'completed'}[s]||s) as TaskStatus;
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
const unsupported=(e:unknown)=>/unknown command|unsupported|not supported|unavailable/i.test(errorText(e));
export const taskActive=(task:SessionTask)=>!terminal(task.status);
export const taskCounts=(tasks:SessionTask[])=>({running:tasks.filter(t=>!t.stale&&(t.status==='running'||t.status==='stopping')).length,unknown:tasks.filter(t=>t.status==='unknown'||t.stale&&taskActive(t)).length,failed:tasks.filter(t=>t.status==='failed').length});

// Each Conversation owns one controller. Nested agent events never enter the
// parent transcript reducer, and a lost connection never implies completion.
export class SessionTasks {
  items:SessionTask[]=[]; background:'checking'|'available'|'unsupported'='checking'; error='';
  connected=false; revision=0; epoch=0; timer?:ReturnType<typeof setTimeout>; polling=false;
  private historyEpoch?:number;
  cancelling=new Map<string,TaskStatus|undefined>();
  constructor(readonly request:(type:string,data?:OmpEvent)=>Promise<any>,readonly changed:()=>void){}
  private put(task:SessionTask,notify=true){
    this.items=this.items.some(t=>t.key===task.key)?this.items.map(t=>t.key===task.key?task:t):[...this.items,task];
    const active=this.items.filter(taskActive),done=this.items.filter(t=>!taskActive(t)).slice(-80);
    this.items=[...done,...active];if(notify)this.changed();
  }
  private agent(p:OmpEvent, lifecycle=false){
    const progress=p.progress||{},id=String(p.id||progress.id||'');if(!id)return;
    const key=`agent:${id}:${p.parentToolCallId||p.sessionFile||''}`;
    const old=this.items.find(t=>t.key===key),now=Date.now();
    const next=status(lifecycle?p.status:progress.status||p.status||'running');
    if(old&&terminal(old.status)&&!terminal(next))return;
    if(this.cancelling.has(key)&&terminal(next))this.cancelling.set(key,next);
    const state=this.cancelling.has(key)||old?.status==='stopping'&&!terminal(next)?'stopping':next;
    this.put({...old,key,id,kind:'agent',title:p.description||progress.description||p.agent||old?.title||'子代理',
      parentToolCallId:p.parentToolCallId||old?.parentToolCallId,sessionFile:p.sessionFile||old?.sessionFile,
      status:state,startedAt:old?.startedAt||(Number.isFinite(progress.durationMs)?now-progress.durationMs:now),
      endedAt:terminal(state)?old?.endedAt||now:undefined,command:progress.currentToolArgs||old?.command,
      detail:progress.currentToolIntent||progress.lastIntent||progress.currentTool||p.task||old?.detail||'',
      output:Array.isArray(progress.recentOutput)?tail(progress.recentOutput.join('\n')):old?.output||'',
      stale:false,cancellable:!terminal(next),revision:++this.revision,error:terminal(next)?undefined:old?.error});
  }
  event(event:OmpEvent){
    if(event.type==='subagent_lifecycle')this.agent(event.payload||event,true);
    if(event.type==='subagent_progress')this.agent(event.payload||event);
    if(event.type==='subagent_event'){
      const {id,event:nested}=event.payload||{};
      const task=this.items.find(t=>t.kind==='agent'&&t.id===id&&taskActive(t));
      if(task?.expanded&&nested?.type==='tool_execution_end')this.put({...task,history:tail((task.history||'')+'\n'+(nested.toolName||'工具')+'\n'+contentText(nested.result?.content)),revision:++this.revision});
    }
    if(event.type==='message_end')this.restoreHistory([event.message]);
    if(['remote_disconnected','process_exit','process_error','remote_interrupted'].includes(event.type))this.disconnect();
  }
  restoreHistory(messages:OmpEvent[],missingAtRevision?:number){
    const outcomes=new Map<string,{job:OmpEvent;state:TaskStatus;resultAt?:number}>();
    for(const item of messages){
      const message=item?.message??item;
      const details=message?.details;
      const asyncResult=message?.customType==='async-result';
      const jobReport=message?.role==='toolResult'&&!message.isError&&
        (message.toolName==='wait'&&details?.op==='wait'||message.toolName==='cancel'&&details?.op==='cancel');
      // A later launch can reuse the same job ID. Its older result no longer applies.
      if(message?.role==='toolResult'&&details?.async?.state==='running')outcomes.delete(details.async.jobId);
      if((!asyncResult&&!jobReport)||!Array.isArray(details?.jobs))continue;
      const timestamp=message.timestamp??item.timestamp;
      const time=typeof timestamp==='string'?Date.parse(timestamp):timestamp;
      const resultAt=Number.isFinite(time)?time:undefined;
      for(const job of details.jobs){
        const id=asyncResult?job?.jobId:job?.id;
        if(typeof id!=='string'||!id)continue;
        const state=status(job.status||(asyncResult?'completed':''));
        // A coordination report can say cancelled as soon as abort is requested.
        if(state==='running'||jobReport&&state==='aborted')outcomes.delete(id);
        if(!terminal(state)||jobReport&&state==='aborted')continue;
        outcomes.delete(id);
        outcomes.set(id,{job,state,resultAt});
      }
    }
    let changed=false;
    for(const [id,{job,state,resultAt}] of outcomes){
      const key=`job:${id}`,old=this.items.find(task=>task.key===key);
      if(missingAtRevision!==undefined&&(!old?.stale||!taskActive(old)||old.revision>missingAtRevision))continue;
      if(resultAt!==undefined&&resultAt<Math.max(old?.startedAt??0,old?.endedAt??0,old?.resultAt??0))continue;
      const durationMs=Number.isFinite(job.durationMs)&&job.durationMs>=0?job.durationMs:undefined;
      // Keep exact native timing when the result agrees with an already ended instance.
      const nativeEnd=old?.status===state&&old.endedAt!==undefined&&
        (durationMs===undefined||old.startedAt!==undefined&&old.endedAt-old.startedAt===durationMs);
      if(nativeEnd||old?.resultAt!==undefined&&old.resultAt===resultAt&&old.status===state)continue;
      const previousOutput=old?.output||'';
      const output=job.resultText??job.errorText??(previousOutput.startsWith('Running background task ')?'':previousOutput);
      this.put({...old,key,id,kind:'job',title:job.intent||job.label||old?.title||job.type||'后台任务',
        status:state,resultAt,durationMs,endedAt:undefined,output:tail(output),
        detail:'来自会话记录',error:undefined,exitCode:Number.isInteger(job.exitCode)?job.exitCode:undefined,
        stale:false,cancellable:false,revision:++this.revision},false);
      changed=true;
    }
    if(changed)this.changed();
  }
  async reconcileHistory(){
    const {epoch,revision}=this;
    if(!this.connected||this.historyEpoch===epoch)return;
    const taskIds=this.items.filter(task=>task.kind==='job'&&task.stale&&taskActive(task)).slice(-80).map(task=>task.id);
    if(!taskIds.length)return;
    this.historyEpoch=epoch;
    try{
      const result=await this.request('get_background_task_history',{taskIds});
      if(epoch===this.epoch&&Array.isArray(result?.messages))this.restoreHistory(result.messages,revision);
    }catch{ /* An older host or oversized history may not support reconciliation. */ }
    finally{if(this.historyEpoch===epoch)this.historyEpoch=undefined;}
  }
  refreshNow=async()=>{await this.refresh();await this.reconcileHistory();};
  saved(){return this.items.slice(-80).map(t=>({...t,output:tail(t.output,2048),history:undefined,expanded:false,error:undefined}));}
  restore(saved:unknown){if(!Array.isArray(saved))return;this.items=saved.filter(t=>t&&typeof t.key==='string'&&typeof t.id==='string'&&['agent','job','daemon'].includes(t.kind)).slice(-80).map(t=>({...t,output:tail(t.output,2048),history:undefined,expanded:false,stale:!terminal(t.status),cancellable:false,status:terminal(t.status)?t.status:'unknown',revision:++this.revision}));}
  disconnect(){this.connected=false;this.epoch++;clearTimeout(this.timer);this.polling=false;this.items=this.items.map(t=>taskActive(t)?{...t,stale:true,cancellable:false}:t);this.changed();}
  async connect(){
    this.disconnect();this.connected=true;const epoch=this.epoch;this.background='checking';
    try{await this.request('set_subagent_subscription',{level:'progress'});}catch(e){if(epoch===this.epoch)this.error=errorText(e);}
    if(epoch===this.epoch)await this.refresh();
  }
  refresh=async()=>{
    if(!this.connected||this.polling)return;this.polling=true;clearTimeout(this.timer);
    const epoch=this.epoch,revision=this.revision;
    try{
      const results=await Promise.allSettled([this.request('get_subagents'),this.background==='unsupported'?Promise.resolve(null):this.request('get_background_tasks')]);
      if(epoch!==this.epoch)return;
      const [agents,jobs]=results;
      if(agents.status==='fulfilled'&&Array.isArray(agents.value?.subagents)){
        const seen=new Set<string>();
        for(const p of agents.value.subagents){const id=String(p.id);seen.add(id);const old=this.items.find(t=>t.kind==='agent'&&t.id===id&&t.revision>revision);if(!old)this.agent(p);}
        this.items=this.items.map(t=>t.kind==='agent'&&taskActive(t)&&t.revision<=revision&&!seen.has(t.id)?{...t,status:'unknown',stale:true,cancellable:false,detail:'当前快照中已无此任务；结束状态待核对'}:t);
      }else if(agents.status==='rejected')this.error=errorText(agents.reason);
      if(jobs.status==='fulfilled'&&jobs.value){
        this.background='available';const seen=new Set<string>();
        for(const value of jobs.value.tasks||[]){
          if(value.agentId&&this.items.some(t=>t.kind==='agent'&&t.id===value.agentId))continue;
          const key=`${value.kind}:${value.id}`,old=this.items.find(t=>t.key===key);seen.add(key);if(old&&old.revision>revision)continue;
          const next=status(value.status),same=old?.startedAt===value.startedAt;
          const recorded=value.kind==='job'&&old?.resultAt!==undefined&&value.startedAt<=old.resultAt;
          if(value.kind==='job'&&old&&terminal(old.status)&&(same||recorded)&&!terminal(next))continue;
          const previous=same||recorded?old:undefined;
          this.put({...previous,...value,key,resultAt:undefined,durationMs:undefined,
            output:tail(value.output??previous?.output??''),detail:value.detail||'',stale:false,
            status:same&&old?.status==='stopping'&&!terminal(next)?'stopping':next,revision:++this.revision});
        }
        this.items=this.items.map(t=>t.kind!=='agent'&&taskActive(t)&&t.revision<=revision&&!seen.has(t.key)?{...t,status:'unknown',stale:true,cancellable:false,detail:'任务已不在原生快照中'}:t);
        this.error=jobs.value.warning||'';
      }else if(jobs.status==='rejected'){if(unsupported(jobs.reason))this.background='unsupported';else this.error=errorText(jobs.reason);}
      await Promise.allSettled(this.items.filter(t=>!t.stale&&(t.expanded||t.kind==='daemon'&&taskActive(t))).slice(-20).map(t=>this.readOutput(t,epoch)));
    }finally{if(epoch===this.epoch){this.polling=false;this.changed();if(this.connected)this.timer=setTimeout(this.refresh,2500);}}
  };
  private async readOutput(task:SessionTask,epoch:number){
    if(task.resultAt!==undefined)return;
    try{
      const result=await this.request(task.kind==='agent'?'get_subagent_messages':'get_background_task_output',task.kind==='agent'?{subagentId:task.id,fromByte:task.cursor||0,expectedSessionFile:task.sessionFile}:{taskId:task.id,kind:task.kind,startedAt:task.startedAt});
      if(epoch!==this.epoch)return;const current=this.items.find(t=>t.key===task.key);if(!current||current.startedAt!==task.startedAt||current.resultAt!==task.resultAt)return;
      if(task.kind==='agent')this.put({...current,cursor:result.nextByte,history:tail((result.reset?'':current.history||'')+(result.messages||[]).map((m:OmpEvent)=>`\n${m.role||''} ${contentText(m.content)}`).join('\n'))});
      else this.put({...current,output:tail(result.output),exitCode:result.exitCode??current.exitCode});
    }catch(e){if(epoch===this.epoch){const current=this.items.find(t=>t.key===task.key);if(current&&current.startedAt===task.startedAt&&current.resultAt===task.resultAt)this.put({...current,error:errorText(e)});}}
  }
  expand=async(key:string)=>{const task=this.items.find(t=>t.key===key);if(!task)return;this.put({...task,expanded:!task.expanded});if(!task.expanded&&this.connected)await this.readOutput({...task,expanded:true},this.epoch);};
  cancel=async(key:string)=>{
    const task=this.items.find(t=>t.key===key);if(!task||!this.connected||task.stale||!task.cancellable||task.status==='stopping'||terminal(task.status))return;
    const epoch=this.epoch;if(task.kind==='agent')this.cancelling.set(key,undefined);this.put({...task,status:'stopping',error:undefined,revision:++this.revision});
    try{
      // Snapshot guards reuse of a logical ID before the destructive request.
      if(task.kind==='agent'){
        const snapshot=await this.request('get_subagents');
        if(!snapshot.subagents?.some((p:OmpEvent)=>p.id===task.id&&p.sessionFile===task.sessionFile&&p.parentToolCallId===task.parentToolCallId))throw Error('任务已变化，请刷新后核对');
        if(epoch!==this.epoch)return;
        const result=await this.request('cancel_subagent',{subagentId:task.id,expectedSessionFile:task.sessionFile,expectedParentToolCallId:task.parentToolCallId});
        // Native cancel_subagent awaits release + abort; unlike a background
        // job's `accepted`, cancelled=true is an exit confirmation.
        const confirmed=this.cancelling.get(key)||(result?.cancelled===true?'aborted':undefined);this.cancelling.delete(key);
        const current=this.items.find(t=>t.key===key);
        if(epoch===this.epoch&&confirmed&&current)this.put({...current,status:confirmed,endedAt:Date.now(),cancellable:false,error:undefined,revision:++this.revision});
      }else await this.request('cancel_background_task',{taskId:task.id,kind:task.kind,startedAt:task.startedAt});
      // Acceptance is not termination; lifecycle/snapshot confirms the result.
      if(epoch===this.epoch)await this.refresh();
    }catch(e){if(epoch===this.epoch){const current=this.items.find(t=>t.key===key);if(current&&!terminal(current.status))this.put({...current,error:`停止结果待确认：${errorText(e)}`,stale:true,cancellable:false});}}finally{this.cancelling.delete(key);}
  };
}
function contentText(content:unknown):string{return typeof content==='string'?content:Array.isArray(content)?content.map(b=>b?.type==='text'?b.text:b?.type==='toolCall'?`${b.name} ${JSON.stringify(b.arguments)}`:'').filter(Boolean).join('\n'):'';}
