const fs=require('node:fs'),path=require('node:path');

// One serialized scheduler owns startup, debounced writes, polling and retries.
class KnowledgeAutoSync {
 constructor(sync,{delayMs=30000,pollMs=300000,retryMs=60000,maxRetryMs=900000,clock=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}){
  this.sync=sync;this.file=path.join(sync.root,'automatic.json');this.delayMs=delayMs;this.pollMs=pollMs;this.retryMs=retryMs;this.maxRetryMs=maxRetryMs;this.clock=clock;this.setTimer=setTimer;this.clearTimer=clearTimer;this.timer=null;this.pending=false;this.active=null;this.started=false;this.failures=0;
  this.state={enabled:false,status:'disabled',lastAttempt:null,lastSuccess:null,error:'',conflicts:[],nextAt:null};
  try{const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));if(typeof saved.enabled!=='boolean')throw Error('invalid');this.state={...this.state,...saved,status:saved.enabled?'waiting':'disabled',nextAt:null};}catch(e){if(e.code!=='ENOENT')throw Error('自动同步配置无法读取');}
 }
 persist(){this.sync.store.atomic(this.file,Buffer.from(JSON.stringify(this.state,null,2)+'\n'));}
 status(){return {...this.state,running:!!this.active};}
 start(){if(this.started)return;this.started=true;if(this.state.enabled)this.schedule(this.delayMs);}
 async setEnabled(enabled){if(typeof enabled!=='boolean')throw Error('自动同步设置无效');this.state.enabled=enabled;this.state.error='';this.state.conflicts=[];this.state.status=enabled?'waiting':'disabled';this.pending=false;this.cancelTimer();this.state.nextAt=null;this.persist();if(enabled&&this.started)this.schedule(this.delayMs);return this.status();}
 cancelTimer(){if(this.timer){this.clearTimer(this.timer);this.timer=null;}}
 schedule(delay){if(!this.started||!this.state.enabled)return;this.cancelTimer();this.state.nextAt=this.clock()+delay;this.persist();this.timer=this.setTimer(()=>{this.timer=null;void this.run().catch(()=>{});},delay);this.timer.unref?.();}
 changed(){if(!this.state.enabled||!this.started)return;this.pending=true;if(!this.active){this.state.status='waiting';this.schedule(this.delayMs);}}
 run(){if(this.active){this.pending=true;return this.active;}this.cancelTimer();this.pending=false;this.state.status='syncing';this.state.lastAttempt=this.clock();this.state.nextAt=null;this.state.error='';this.persist();
  this.active=(async()=>{let result;try{result=await Promise.resolve().then(()=>this.sync.run());if(result.action==='conflict'){this.state.status='conflict';this.state.conflicts=result.conflicts;this.state.error='存在需要核对的文档冲突';this.failures=0;}else{this.state.status='ok';this.state.lastSuccess=this.clock();this.state.conflicts=[];this.failures=0;}return result;}catch(e){this.state.status='error';this.state.error=String(e.message||'同步失败').slice(0,1000);this.failures++;throw e;}finally{this.active=null;if(!this.state.enabled)this.state.status='disabled';this.persist();if(this.state.enabled&&this.started){const delay=this.pending?this.delayMs:this.state.status==='error'?Math.min(this.maxRetryMs,this.retryMs*2**Math.min(this.failures-1,10)):this.pollMs;this.schedule(delay);}}})();return this.active;
 }
 async stop(){this.started=false;this.cancelTimer();if(this.active)await this.active.catch(()=>{});}
}
module.exports={KnowledgeAutoSync};
