const {BrowserWindow,ipcMain,screen,Tray,Menu,nativeImage,powerMonitor}=require('electron');
const path=require('node:path');
const {PetState,Preferences}=require('./state.cjs');
const {windowShape}=require('./shape.cjs');
const atlases=require('./animation-data.js');
const {applicationIcon,trayIcon}=require('../app-icon.cjs');
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
function place(area,size,position){return {x:Math.round(clamp(area.x+area.width-size.width-(position?.right??24),area.x,area.x+area.width-size.width)),y:Math.round(clamp(area.y+area.height-size.height-(position?.bottom??24),area.y,area.y+area.height-size.height)),...size};}
class PetController{
 constructor({directory,getMain,getSessions,onQuit}){this.getMain=getMain;this.getSessions=getSessions;this.onQuit=onQuit;this.preferences=new Preferences(directory);this.model=new PetState();this.hidden=false;this.locked=false;this.manual=false;this.theme='light';this.listeners=[];this.handlers=[];this.disposed=false;this.serial=Promise.resolve();}
 get settings(){return this.preferences.value;}
 async init(){await this.preferences.load();this.listen(screen,'display-added',()=>this.reposition());this.listen(screen,'display-removed',()=>this.reposition());this.listen(screen,'display-metrics-changed',()=>this.reposition());this.listen(powerMonitor,'lock-screen',()=>this.suspend());this.listen(powerMonitor,'suspend',()=>this.suspend());this.listen(powerMonitor,'unlock-screen',()=>this.resume());this.listen(powerMonitor,'resume',()=>this.resume());
  this.handle('pet:snapshot',()=>this.snapshot());
  this.handle('pet:action',(_event,action,data)=>this.action(action,data));
  this.handle('pet:hit',(event,hit)=>{if(event.sender!==this.pet?.webContents||typeof hit!=='boolean')throw Error('无效命中区域');if(!this.drag)this.setHit(hit);});
  this.handle('pet:layout',(event,layout)=>{if(event.sender!==this.pet?.webContents)throw Error('无效桌宠布局来源');return this.setLayout(layout);});
  this.handle('pet:drag',(event,action)=>{if(event.sender!==this.pet?.webContents)throw Error('无效拖拽来源');return this.dragAction(action);});
  await this.apply();return this;
 }
 listen(target,name,fn){target.on(name,fn);this.listeners.push(()=>target.removeListener(name,fn));}
 handle(name,fn){ipcMain.handle(name,(event,...args)=>{if(this.disposed)return false;if(![this.pet?.webContents,this.bubble?.webContents].includes(event.sender))throw Error('Unauthorized pet IPC sender');return fn(event,...args);});this.handlers.push(name);}
 snapshot(){return {...this.model.snapshot(this.settings),theme:this.theme,hidden:this.hidden,locked:this.locked,manual:this.manual,warning:this.preferences.warning||''};}
 ingest(event){if(this.model.ingest(event))this.schedule();}
 context(context){if(!context||!['light','dark'].includes(context.theme))throw Error('无效桌宠上下文');this.theme=context.theme;if(typeof context.id==='string'){const s=this.model.sessions.get(context.id);if(s&&typeof context.title==='string')s.title=context.title.slice(0,160);}this.schedule();}
 save(patch){const next=this.serial.then(async()=>{const value=await this.preferences.save(patch);if(patch.enabled===true)this.hidden=false;await this.apply();return value;});this.serial=next.catch(()=>{});return next;}
 schedule(){if(this.disposed||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;this.publish();},250);}
 publish(){if(this.disposed)return;const snapshot=this.snapshot();for(const win of [this.pet,this.bubble,this.getMain()])if(win&&!win.isDestroyed())win.webContents.send('pet:state',snapshot);this.updateBubble(snapshot);this.updateTray();}
 size(){const scale={small:.75,medium:1,large:1.25}[this.settings.size],base=this.settings.appearance==='cat'?168:224;return {width:Math.round(base*scale),height:Math.round((base+30)*scale)};}
 display(){return screen.getAllDisplays().find(d=>d.id===this.settings.position?.displayId)||screen.getPrimaryDisplay();}
 async createWindow(kind){
  const sprite=kind==='sprite';
  // Keep small overlay surfaces painting when shown without activation. On
  // Windows/RDP native occlusion can otherwise leave them visibly blank.
  // Their only animation is explicitly paused when hidden/locked.
  const win=new BrowserWindow({show:false,width:sprite?this.size().width:350,height:sprite?this.size().height:260,frame:false,transparent:sprite,backgroundColor:sprite?'#00000000':'#f8f8f5',hasShadow:!sprite,resizable:false,maximizable:false,minimizable:false,fullscreenable:false,skipTaskbar:true,focusable:!sprite,alwaysOnTop:this.settings.alwaysOnTop,icon:applicationIcon,title:sprite?'Cindy 桌面伙伴':'Cindy 会话提醒',webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
  win.on('close',event=>{if(!this.disposed&&this.settings.enabled){event.preventDefault();if(sprite)this.hide();else{this.manual=false;const n=this.model.snapshot(this.settings).notices.find(n=>n.popup);if(n)this.model.snooze(n.id);win.hide();}}});
  if(sprite){this.pet=win;this.nativeShape=false;win.setIgnoreMouseEvents(true,{forward:true});this.hit=false;}else this.bubble=win;
  await win.loadFile(path.join(__dirname,sprite?'sprite.html':'bubble.html'));
  return win;
 }
 async apply(){
  if(this.disposed)return;
  if(!this.settings.enabled){if(this.getMain()&&!this.getMain().isVisible())this.showMain();this.destroyWindows();this.tray?.destroy();this.tray=null;this.publish();return;}
  if(!this.tray){this.trayKey='';const icon=nativeImage.createFromPath(trayIcon).resize({width:20,height:20});this.tray=new Tray(icon);this.tray.on('click',()=>{this.hidden=false;this.manual=false;this.reposition();this.publish();});this.tray.on('double-click',()=>this.showMain());}
  try{if(!this.pet||this.pet.isDestroyed())await this.createWindow('sprite');if(!this.bubble||this.bubble.isDestroyed())await this.createWindow('bubble');}
  catch(e){this.hidden=true;this.destroyWindows();this.preferences.warning='桌宠窗口打开失败：'+e.message;this.updateTray();throw e;}
  for(const win of [this.pet,this.bubble])win.setAlwaysOnTop(this.settings.alwaysOnTop,'floating');
  this.reposition();this.publish();
 }
 reposition(){if(!this.pet||this.pet.isDestroyed())return;this.pet.setBounds(place(this.display().workArea,this.size(),this.settings.position));if(!this.hidden&&!this.locked)this.pet.showInactive();this.positionBubble();}
 positionBubble(){if(!this.pet||!this.bubble||this.pet.isDestroyed()||this.bubble.isDestroyed())return;const p=this.pet.getBounds(),area=screen.getDisplayMatching(p).workArea;const width=Math.min(350,area.width),height=Math.min(260,area.height),x=clamp(p.x+p.width-width,area.x,area.x+area.width-width),above=p.y-height-8,y=above>=area.y?above:clamp(p.y+p.height+8,area.y,area.y+area.height-height);this.bubble.setBounds({x:Math.round(x),y:Math.round(y),width,height});}
 updateBubble(snapshot){clearTimeout(this.expiry);if(!this.bubble||this.bubble.isDestroyed())return;if(!this.settings.enabled||this.hidden||this.locked){this.pet?.hide();this.bubble.hide();return;}
  const popup=snapshot.notices.find(n=>n.popup);if(this.manual||!this.settings.quiet&&popup){this.positionBubble();if(!this.bubble.isVisible())this.bubble.showInactive();}else this.bubble.hide();
  const complete=snapshot.notices.filter(n=>n.kind==='completed'&&n.popup);if(complete.length){const when=Math.min(...complete.map(n=>n.createdAt+6000));this.expiry=setTimeout(()=>this.publish(),Math.max(50,when-Date.now()+10));}
 }
 updateTray(){if(!this.tray)return;const s=this.snapshot();this.tray.setToolTip(`Cindy OMP · ${s.activeCount} 个运行中 · ${s.pendingCount} 条待处理`);const key=[this.hidden,this.settings.quiet].join(':');if(this.trayKey===key)return;this.trayKey=key;this.tray.setContextMenu(Menu.buildFromTemplate([
  {label:'打开工作台',click:()=>this.showMain()},
  {label:this.hidden?'显示桌面伙伴':'隐藏桌面伙伴',click:()=>{if(this.hidden){this.hidden=false;this.reposition();this.publish();}else this.hide();}},
  {label:'勿扰',type:'checkbox',checked:this.settings.quiet,click:item=>{void this.save({quiet:item.checked}).catch(e=>this.fail(e));}},
  {label:'重置桌宠位置',click:()=>{void this.save({position:null}).catch(e=>this.fail(e));}},
  {type:'separator'},{label:'退出 OMP 工作台',click:()=>this.onQuit()}
 ]));}
 fail(error){this.preferences.warning=String(error.message||error);this.showMain();this.publish();}
 hide(){this.hidden=true;this.manual=false;this.drag=null;this.setHit(false);this.pet?.hide();this.bubble?.hide();this.publish();}
 showMain(){const main=this.getMain();if(main&&!main.isDestroyed()){if(main.isMinimized())main.restore();main.show();main.focus();}}
 shouldKeepAlive(){return this.settings.enabled&&this.settings.closeToTray&&!!this.tray;}
 setLayout(layout){
  if(!this.pet||this.pet.isDestroyed()||layout?.appearance!==this.settings.appearance)return;
  if(process.platform!=='win32'&&process.platform!=='linux')return;
  const bounds=this.pet.getContentBounds();
  // A move across mixed-DPI displays or a size setting can leave an in-flight
  // renderer measurement one frame behind the native window. Never apply it.
  if(!Number.isFinite(layout.viewport?.width)||!Number.isFinite(layout.viewport?.height))throw Error('无效桌宠尺寸');
  if(Math.abs(layout.viewport.width-bounds.width)>3||Math.abs(layout.viewport.height-bounds.height)>3)return false;
  const animated=layout.frame!==undefined;
  if(animated&&(!this.settings.animated||!Number.isInteger(layout.frame)||!atlases[layout.appearance]?.frames[layout.frame]))return false;
  const key=layout.appearance+':'+animated;
  this.assetMasks||=new Map();let asset=this.assetMasks.get(key);
  if(!asset){const image=nativeImage.createFromPath(path.join(__dirname,animated?atlases[layout.appearance].file:'assets/'+(layout.appearance==='cat'?'cat.png':'companions.png')));asset={...image.getSize(),bitmap:image.toBitmap()};this.assetMasks.set(key,asset);}
  const source=animated?atlases[layout.appearance].frames[layout.frame]:undefined;
  // Each animation frame is cached at the current layout. No alpha scan per token.
  const regionKey=JSON.stringify([key,layout.frame,layout.image,layout.badge,bounds.width,bounds.height]);
  this.regionCache||=new Map();let rects=this.regionCache.get(regionKey);
  if(!rects){rects=windowShape({...asset,image:layout.image,badge:layout.badge,bounds,source});if(this.regionCache.size>=64)this.regionCache.clear();this.regionCache.set(regionKey,rects);}
  if(!rects.length)throw Error('桌宠命中区域为空');
  this.pet.setShape(rects);this.shapeCount=rects.length;this.nativeShape=true;this.pet.setIgnoreMouseEvents(false);this.hit=true;return true;
 }
 setHit(hit){if(this.nativeShape||!this.pet||this.pet.isDestroyed()||this.hit===hit)return;this.hit=hit;this.pet.setIgnoreMouseEvents(!hit,{forward:true});}
 async dragAction(action){if(action==='start'){this.drag={cursor:screen.getCursorScreenPoint(),bounds:this.pet.getBounds()};this.setHit(true);return;}
  if(!this.drag)return;
  if(action==='move'){const point=screen.getCursorScreenPoint(),b=this.drag.bounds;this.pet.setPosition(Math.round(b.x+point.x-this.drag.cursor.x),Math.round(b.y+point.y-this.drag.cursor.y));this.positionBubble();return;}
  if(action!=='end')throw Error('无效拖拽操作');const previous=this.drag.bounds;this.drag=null;this.setHit(false);const b=this.pet.getBounds();if(b.x===previous.x&&b.y===previous.y)return;const d=screen.getDisplayMatching(b),a=d.workArea;await this.preferences.save({position:{displayId:d.id,right:Math.max(0,a.x+a.width-b.x-b.width),bottom:Math.max(0,a.y+a.height-b.y-b.height)}});this.reposition();this.publish();
 }
 async action(action,data){
  if(action==='inbox'){this.manual=true;this.publish();return;}
  if(action==='hide'){this.hide();return;}
  if(action==='close-bubble'){this.manual=false;for(const n of this.model.notices.values()){if(n.kind==='attention'||n.kind==='error')n.snoozed=true;else this.model.read(n.id);}this.publish();return;}
  if(action==='main'){this.showMain();return;}
  if(action==='quiet'){await this.save({quiet:!this.settings.quiet});return;}
  if(action==='pin'){if(typeof data!=='string'||data&&!this.model.sessions.has(data))throw Error('会话已失效');await this.save({pinnedSessionId:data});return;}
  if(!['open','snooze'].includes(action)||typeof data!=='string')throw Error('不支持的桌宠操作');
  const notice=this.model.notices.get(data);if(!notice)throw Error('提示已失效');
  if(action==='snooze'){this.model.snooze(data);this.manual=false;this.publish();return;}
  // Open an existing renderer conversation. Never resume/start a native writer here.
  if(!this.model.sessions.has(notice.sessionId))throw Error('会话已关闭');
  this.showMain();this.getMain()?.webContents.send('pet:navigate',{id:notice.sessionId});this.model.read(data);this.manual=false;this.publish();
 }
 suspend(){this.locked=true;this.drag=null;this.pet?.hide();this.bubble?.hide();clearTimeout(this.expiry);this.publish();}
 resume(){this.locked=false;this.reposition();this.publish();for(const record of this.getSessions()?.list()||[])void this.getSessions().request(record.id,'get_state').catch(()=>{});}
 destroyWindows(){this.drag=null;this.nativeShape=false;for(const win of [this.pet,this.bubble])if(win&&!win.isDestroyed())win.destroy();this.pet=null;this.bubble=null;}
 dispose(){this.disposed=true;clearTimeout(this.timer);clearTimeout(this.expiry);for(const off of this.listeners)off();this.destroyWindows();this.tray?.destroy();this.tray=null;const handlers=this.handlers.splice(0);setTimeout(()=>{for(const name of handlers)ipcMain.removeHandler(name);},100).unref();}
}
module.exports={PetController,place};
