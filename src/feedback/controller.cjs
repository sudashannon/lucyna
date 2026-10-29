const {BrowserWindow,ipcMain,powerMonitor}=require('electron');
const path=require('node:path'),{randomUUID}=require('node:crypto');
const {FeedbackPreferences,validate}=require('./settings.cjs');
const {FeedbackPolicy}=require('./policy.cjs');
class FeedbackController{
 constructor({directory,getMain,onChange=()=>{}}){this.preferences=new FeedbackPreferences(directory);this.getMain=getMain;this.onChange=onChange;this.policy=new FeedbackPolicy();this.listeners=[];this.acks=new Map();this.warning='';this.disposed=false;this.blocked=new Set();}
 async init(legacyReducedMotion=false){
  await this.preferences.load(legacyReducedMotion);this.policy.settings=this.preferences.value;
  for(const [event,key,blocked]of [['lock-screen','lock',true],['unlock-screen','lock',false],['suspend','sleep',true],['resume','sleep',false]])this.listen(powerMonitor,event,()=>this.setBlocked(key,blocked));
  const main=this.getMain();if(main){this.listen(main,'focus',()=>this.policy.context({focused:true}));for(const event of ['blur','hide','minimize'])this.listen(main,event,()=>this.policy.context({focused:false}));this.policy.focused=main.isFocused();}
  this.report=(_e,result)=>{if(_e.sender!==this.player?.webContents||!result||typeof result.id!=='string')return;const ack=this.acks.get(result.id);if(!ack)return;clearTimeout(ack.timer);this.acks.delete(result.id);result.ok?ack.resolve():ack.reject(Error('音效无法播放，请检查系统音频输出。'));};
  ipcMain.on('feedback:played',this.report);this.publish();return this;
 }
 listen(target,name,fn){target.on(name,fn);this.listeners.push(()=>target.removeListener(name,fn));}
 snapshot(){return {settings:{...this.preferences.value},warning:this.preferences.warning||this.warning};}
 publish(){const value=this.snapshot(),main=this.getMain();if(main&&!main.isDestroyed())main.webContents.send('feedback:settings-changed',value);this.onChange(value.settings);}
 async save(patch){const value=await this.preferences.save(patch);this.policy.context({settings:value});this.stop();this.publish();return value;}
 context({id,visible=true}){this.policy.context({visibleId:visible&&typeof id==='string'?id:''});}
 observe(snapshot){if(this.disposed)return;this.policy.observe({...snapshot,locked:snapshot.locked||this.blocked.size>0});if(this.policy.quiet||this.policy.locked)this.stop(this.policy.quiet&&!this.policy.locked);if(!this.timer&&this.policy.pending.size)this.timer=setTimeout(()=>{this.timer=null;const batch=this.policy.flush();if(batch)void this.play(batch).catch(()=>{});},2000);}
 setBlocked(key,blocked){if(blocked)this.blocked.add(key);else this.blocked.delete(key);this.policy.context({locked:this.blocked.size>0});if(blocked)this.stop();}
 async ensurePlayer(){
  if(this.player&&!this.player.isDestroyed())return this.loading;
  const win=new BrowserWindow({show:false,width:1,height:1,skipTaskbar:true,focusable:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
  this.player=win;win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
  this.loading=win.loadFile(path.join(__dirname,'player.html'));await this.loading;
 }
 async play(batch,preview){
  const settings=preview?validate({style:preview.style,volume:preview.volume}):this.preferences.value;
  try{
   await this.ensurePlayer();
   if(this.disposed||this.blocked.size||(!preview&&(this.policy.locked||this.policy.quiet||settings.mode==='silent'||!settings.volume)))return;
   // Focus/settings may change while the isolated audio surface is loading.
   if(!preview&&!batch.ids.some(id=>this.policy.eligible(this.policy.current.get(id))))return;
   const id=randomUUID();this.previewing=!!preview;
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.acks.delete(id);reject(Error('音频输出没有响应；会话继续运行。'));},4000);this.acks.set(id,{resolve,reject,timer});this.player.webContents.send('feedback:play',{id,kind:batch.kind,style:settings.style,volume:settings.volume});});
   if(this.warning){this.warning='';this.publish();}
  }catch(error){this.warning=error.message;this.publish();throw error;}
 }
 preview(input){if(!input||!['completed','attention','error'].includes(input.kind))throw Error('请选择要试听的提示');if(this.blocked.size)throw Error('锁屏或休眠期间暂停试听');return this.play({kind:input.kind},input);}
 stopPreview(){if(this.previewing&&this.player&&!this.player.isDestroyed()){this.player.webContents.send('feedback:stop');this.previewing=false;}}
 stop(preservePreview=false){clearTimeout(this.timer);this.timer=null;this.policy.pending.clear();if((!preservePreview||!this.previewing)&&this.player&&!this.player.isDestroyed())this.player.webContents.send('feedback:stop');}
 dispose(){this.disposed=true;this.stop();for(const off of this.listeners)off();ipcMain.removeListener('feedback:played',this.report);for(const ack of this.acks.values()){clearTimeout(ack.timer);ack.resolve();}this.acks.clear();this.player?.destroy();this.player=null;}
}
module.exports={FeedbackController};
