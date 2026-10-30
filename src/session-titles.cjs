const {resultExcerpt}=require('./result-excerpt.cjs');
const meaningful=text=>text&&!/^(?:继续|好的?|嗯|看看|你好|测试|hi|hello|test|continue)[。.!！\s]*$/i.test(text)&&!text.startsWith('/');
class SessionTitles {
  constructor(agent,settings){this.agent=agent;this.settings=settings;this.tasks=new Set();}
  cancel(record){const state=record.naming;if(state){state.revision++;state.controller?.abort();}}
  observe(record,event,manager){
    const state=record.naming||={prompt:'',answer:'',attempts:0,revision:0,pending:null};
    if(['process_exit','process_error','session_info_update','agent_start'].includes(event.type)){this.cancel(record);if(event.type==='agent_start')state.answer='';}
    if(event.type==='message_end'){
      const message=event.message;
      if(message?.role==='user'&&!state.prompt){const text=resultExcerpt(message.content,2000);if(meaningful(text))state.prompt=text;}
      if(message?.role==='custom'&&message.customType==='skill-prompt'&&message.attribution==='user'&&!state.prompt){const text=resultExcerpt(message.details?.args,2000);if(meaningful(text))state.prompt=`技能 ${String(message.details?.name||'').slice(0,100)}：${text}`;}
      if(message?.role==='assistant'&&!['error','aborted'].includes(message.stopReason)&&!message.content?.some?.(b=>b.type==='toolCall'))state.answer=resultExcerpt(message.content,1500);
    }
    if(event.type==='prompt_result'&&event.status!=='completed'){this.cancel(record);state.answer='';}
    const settled=event.type==='session_settled'||event.type==='prompt_result'&&event.status==='completed'&&event.sessionSettled!==false;
    if(!settled||!state.prompt||!state.answer||state.pending||state.attempts>=2)return;
    const revision=state.revision,settingsRevision=this.settings.revision;
    const controller=new AbortController();state.controller=controller;
    const current=()=>manager.records.get(record.id)===record&&!!record.session.child&&!record.controller?.signal.aborted&&!record.busy&&state.revision===revision&&this.settings.revision===settingsRevision&&!controller.signal.aborted;
    const run=async()=>{
      const preferences=await (this.settings.get?this.settings.get():this.settings.resolve());if(!preferences.autoTitle||!current())return;
      const before=await manager.request(record.id,'get_state');
      if(!current()||before.sessionName||before.isSettled===false||!before.sessionId||!before.sessionFile)return;
      const config=await this.settings.resolve();if(!config.autoTitle||!current())return;
      state.attempts++;
      const title=await this.agent.title(config,state.prompt,state.answer,controller.signal);
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
    const pending=Promise.resolve().then(run).catch(error=>{if(current())manager.emit(record,{type:'auxiliary_title_error',message:error.message});}).finally(()=>{if(state.pending===pending)state.pending=null;this.tasks.delete(pending);});
    state.pending=pending;this.tasks.add(pending);
  }
}
module.exports={SessionTitles};
