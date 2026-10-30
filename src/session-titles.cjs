const {resultExcerpt}=require('./result-excerpt.cjs');
const meaningful=text=>text&&!/^(?:继续|好的?|嗯|看看|你好|测试|hi|hello|test|continue)[。.!！\s]*$/i.test(text)&&!text.startsWith('/');
function userText(message){
  if(message?.role==='user')return resultExcerpt(message.content,1000);
  if(message?.role==='custom'&&message.customType==='skill-prompt'&&message.attribution==='user'&&message.display!==false){const text=resultExcerpt(message.details?.args,900);if(meaningful(text))return `技能 ${String(message.details?.name||'').slice(0,100)}：${text}`;}
  return '';
}
const finalText=message=>message?.role==='assistant'&&!['error','aborted'].includes(message.stopReason)&&!message.content?.some?.(b=>b?.type==='toolCall')?resultExcerpt(message.content,1500):'';
const taskContext=(first,last)=>first===last?first:`最初任务：${first}\n最近任务：${last}`;
class SessionTitles {
  constructor(agent,settings){this.agent=agent;this.settings=settings;this.tasks=new Set();this.active=0;this.waiters=[];}
  state(record){return record.naming||={prompt:'',firstPrompt:'',answer:'',historyEligible:false,attempts:0,revision:0,round:0,pending:null,lastAttemptKey:''};}
  revision(record){return this.state(record).revision;}
  cancel(record){const state=this.state(record);state.revision++;state.controller?.abort();}
  restore(record,messages,manager,revision){
    const state=this.state(record);
    if(manager.records.get(record.id)!==record||revision!==undefined&&revision!==state.revision||!Array.isArray(messages))return;
    let first='',last='',answer='';
    for(const entry of messages){const message=entry?.message||entry,text=userText(message);
      if(message?.role==='user'||message?.role==='custom'&&message.customType==='skill-prompt'&&message.attribution==='user')answer='';
      if(meaningful(text)){first||=text;last=text;}
      if(message?.role==='assistant'){const final=finalText(message);if(final)answer=final;else if(['error','aborted'].includes(message.stopReason))answer='';}
    }
    const prompt=first?taskContext(first,last):'';
    if(state.pending&&(state.prompt!==prompt||state.answer!==answer))this.cancel(record);
    state.firstPrompt=first;state.prompt=prompt;state.answer=answer;state.historyEligible=!!first;
    this.schedule(record,manager);
  }
  refresh(record,manager){this.cancel(record);const state=this.state(record);state.attempts=0;state.lastAttemptKey='';this.schedule(record,manager);}
  async acquire(signal){
    signal.throwIfAborted();
    if(this.active<2){this.active++;return;}
    await new Promise((resolve,reject)=>{
      const waiter={resolve:()=>{signal.removeEventListener('abort',abort);resolve();}};
      const abort=()=>{const i=this.waiters.indexOf(waiter);if(i!==-1)this.waiters.splice(i,1);reject(signal.reason);};
      this.waiters.push(waiter);signal.addEventListener('abort',abort,{once:true});
    });
  }
  release(){const waiter=this.waiters.shift();if(waiter)waiter.resolve();else this.active--;}
  observe(record,event,manager){
    const state=this.state(record);
    if(['process_exit','process_error','session_info_update','agent_start'].includes(event.type)){this.cancel(record);if(event.type==='agent_start'){state.answer='';state.historyEligible=false;state.round++;}}
    if(event.type==='message_end'){
      const message=event.message,text=userText(message);
      if(meaningful(text)){state.firstPrompt||=text;state.prompt=taskContext(state.firstPrompt,text);}
      const answer=finalText(message);if(answer)state.answer=answer;
    }
    if(event.type==='prompt_result'&&event.status!=='completed'){this.cancel(record);state.answer='';state.historyEligible=false;}
    const settled=event.type==='session_settled'||event.type==='prompt_result'&&event.status==='completed'&&event.sessionSettled!==false;
    if(settled)this.schedule(record,manager);
  }
  schedule(record,manager){
    const state=this.state(record);
    if(!state.prompt||!state.answer&&!state.historyEligible||state.attempts>=2||record.busy||!record.session.child||record.controller?.signal.aborted||manager.records.get(record.id)!==record)return;
    const revision=state.revision,settingsRevision=this.settings.revision;
    const task=state.prompt,answer=state.answer,key=JSON.stringify([settingsRevision,state.round,task,answer]);
    if(state.lastAttemptKey===key)return;
    if(state.pending){if(state.pendingKey!==key||state.pendingRevision!==revision)state.reschedule=true;return;}
    const controller=new AbortController();state.controller=controller;
    const current=()=>manager.records.get(record.id)===record&&!!record.session.child&&!record.controller?.signal.aborted&&!record.busy&&state.revision===revision&&this.settings.revision===settingsRevision&&!controller.signal.aborted;
    const run=async()=>{
      const preferences=await (this.settings.get?this.settings.get():this.settings.resolve());if(!preferences.autoTitle||!current())return;
      const before=await manager.request(record.id,'get_state');
      if(!current()||before.sessionName||before.isSettled===false||!before.sessionId||!before.sessionFile)return;
      const config=await this.settings.resolve();if(!config.autoTitle||!current())return;
      await this.acquire(controller.signal);
      let title;
      try{if(!current())return;state.attempts++;state.lastAttemptKey=key;title=await this.agent.title(config,task,answer,controller.signal);}
      finally{this.release();}
      if(!current())return;
      const after=await manager.request(record.id,'get_state');
      if(!current()||after.sessionName||after.isSettled===false||after.sessionId!==before.sessionId||after.sessionFile!==before.sessionFile)return;
      await record.session.request('set_session_name',{name:title});
      if(manager.records.get(record.id)!==record||!record.session.child)return;
      state.attempts=2;
      const appliedRevision=state.revision,applied=await manager.request(record.id,'get_state');
      if(manager.records.get(record.id)!==record||state.revision!==appliedRevision||applied.sessionId!==after.sessionId||applied.sessionFile!==after.sessionFile||!applied.sessionName)return;
      // Older native hosts do not emit title events for this RPC command.
      manager.emit(record,{type:'session_info_update',title:applied.sessionName,sessionId:applied.sessionId});
    };
    const pending=Promise.resolve().then(run).catch(error=>{if(current())manager.emit(record,{type:'auxiliary_title_error',message:error.message});}).finally(()=>{if(state.pending===pending)state.pending=null;this.tasks.delete(pending);if(state.reschedule){state.reschedule=false;this.schedule(record,manager);}});
    state.pending=pending;state.pendingKey=key;state.pendingRevision=revision;this.tasks.add(pending);
  }
}
module.exports={SessionTitles};
