// Consume existing, settled OMP notices. No new task loop or transcript parsing.
const {defaults}=require('./settings.cjs');
const priority={attention:0,error:1,completed:2};
class FeedbackPolicy{
 constructor(){this.settings=defaults();this.quiet=false;this.locked=false;this.focused=false;this.visibleId='';this.watermark=0;this.current=new Map();this.pending=new Map();}
 context(patch){Object.assign(this,patch);if(this.locked||this.quiet||this.settings.mode==='silent'||!this.settings.volume)this.pending.clear();}
 eligible(n){return n&&!n.read&&!n.snoozed&&n.kind in priority&&this.settings[n.kind]&&!this.locked&&!this.quiet&&this.settings.mode!=='silent'&&this.settings.volume>0&&!(this.settings.mode==='focus'&&this.focused&&n.sessionId===this.visibleId);}
 observe(snapshot){
  this.quiet=!!snapshot.settings.quiet;this.locked=!!snapshot.locked;
  this.current=new Map(snapshot.notices.map(n=>[n.id,n]));
  for(const n of snapshot.notices){
   if(n.order<=this.watermark)continue;
   if(this.eligible(n))this.pending.set(n.id,n);
  }
  // Sequence is monotonic even after a notice is removed or hidden by settings.
  this.watermark=Math.max(this.watermark,snapshot.sequence||0,...snapshot.notices.map(n=>n.order));
  for(const id of this.pending.keys())if(!this.eligible(this.current.get(id)))this.pending.delete(id);
 }
 flush(){
  const entries=[...this.pending.keys()].map(id=>this.current.get(id)).filter(n=>this.eligible(n));this.pending.clear();
  if(!entries.length)return null;
  entries.sort((a,b)=>priority[a.kind]-priority[b.kind]||a.order-b.order);
  return {kind:entries[0].kind,count:entries.length,ids:entries.map(n=>n.id)};
 }
}
module.exports={FeedbackPolicy};
