// A single FIFO owns background agent work. Timers enqueue at most one turn
// per service; a busy producer cannot repeatedly jump ahead of other services.
const labels={consolidation:'L3 知识沉淀',maintenance:'自动维护',governance:'重复与冲突检查'};
class KnowledgeScheduler{
 constructor(){this.queue=[];this.owner=null;this.closed=false;}
 run(name,work){
  if(this.closed)return Promise.resolve();
  const existing=this.queue.find(item=>item.name===name);if(existing)return existing.promise;
  let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
  this.queue.push({name,work,resolve,reject,promise,at:Date.now()});this.pump();return promise;
 }
 pump(){
  if(this.closed||this.owner||!this.queue.length)return;
  const item=this.queue.shift();this.owner=item;
  Promise.resolve().then(item.work).then(item.resolve,item.reject).finally(()=>{this.owner=null;this.pump();});
 }
 status(name){const index=this.queue.findIndex(item=>item.name===name);return {active:this.owner?.name===name,waiting:index>=0,position:index+1,owner:this.owner?.name||null,label:labels[this.owner?.name]||'',since:this.owner?.at||null};}
 close(){this.closed=true;for(const item of this.queue.splice(0))item.resolve();}
}
module.exports={KnowledgeScheduler};
