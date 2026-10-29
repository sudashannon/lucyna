const {Menu,ipcMain,nativeTheme,shell}=require('electron');
const height=36;
const palette={light:{color:'#f8f6f0',symbolColor:'#38383d'},dark:{color:'#262727',symbolColor:'#e8e8eb'}};
function enabled(){return process.platform==='win32'&&process.env.OMP_CINDY_NATIVE_TITLEBAR!=='1'&&process.env.OMP_CINDY_LEGACY_UI!=='1';}
function windowOptions(){return enabled()?{titleBarStyle:'hidden',titleBarOverlay:{...palette.light,height},autoHideMenuBar:false}:{};}
function installWindowChrome(window){
 const send=action=>{if(!window.isDestroyed())window.webContents.send('window:action',action);};
 const action=(label,name,accelerator)=>({label,...(accelerator?{accelerator}:{}),click:()=>send(name)});
 const menu=Menu.buildFromTemplate([
  {id:'file',label:'文件',submenu:[action('新会话','new-session','CmdOrCtrl+N'),action('切换工作区…','search-work','CmdOrCtrl+K'),{type:'separator'},action('设置…','settings','CmdOrCtrl+,'),{type:'separator'},{label:'关闭窗口',accelerator:'Alt+F4',click:()=>window.close()}]},
  {id:'edit',label:'编辑',submenu:[{label:'撤销',role:'undo'},{label:'重做',role:'redo'},{type:'separator'},{label:'剪切',role:'cut'},{label:'复制',role:'copy'},{label:'粘贴',role:'paste'},{label:'全选',role:'selectAll'}]},
  {id:'view',label:'视图',submenu:[action('显示 / 隐藏左侧栏','toggle-sidebar','CmdOrCtrl+B'),action('显示 / 隐藏右侧栏','toggle-panel','CmdOrCtrl+Alt+B'),action('知识库','knowledge'),action('活跃会话','sessions'),{type:'separator'},{label:'实际大小',role:'resetZoom'},{label:'放大',role:'zoomIn'},{label:'缩小',role:'zoomOut'},{type:'separator'},{label:'切换全屏',role:'togglefullscreen'}]},
  {id:'window',label:'窗口',submenu:[{label:'最小化',role:'minimize'},{label:'最大化 / 还原',click:()=>{if(window.isMaximized())window.unmaximize();else window.maximize();}}]},
  {id:'help',label:'帮助',submenu:[action('关于 Lucyna 与快捷键','about'),{label:'项目文档',click:()=>void shell.openExternal('https://github.com/sudashannon/lucyna#readme').catch(()=>{})}]},
 ]);
 // Keep native role accelerators, but never expose a second menu bar on Alt.
 window.setMenu(menu);window.setAutoHideMenuBar(false);window.setMenuBarVisibility(false);
 const authorize=event=>{if(window.isDestroyed()||event.sender!==window.webContents)throw Error('Unauthorized window IPC sender');};
 ipcMain.handle('window:menu',(event,id,position)=>{
  authorize(event);const item=menu.items.find(item=>item.id===id);if(!item?.submenu)throw Error('未知菜单');
  const [width,height]=window.getContentSize();
  if(!Number.isFinite(position?.x)||!Number.isFinite(position?.y))throw Error('无效菜单位置');
  const zoom=window.webContents.getZoomFactor();
  const x=Math.round(Math.max(0,Math.min(width,position.x*zoom))),y=Math.round(Math.max(0,Math.min(height,position.y*zoom)));
  return new Promise(resolve=>item.submenu.popup({window,x,y,callback:()=>resolve(true)}));
 });
 ipcMain.handle('window:theme',(event,theme)=>{
  authorize(event);if(!Object.hasOwn(palette,theme))throw Error('无效窗口主题');
  window.setTitleBarOverlay({...palette[theme],height});nativeTheme.themeSource=theme;
 });
 const altMenus={f:'file',e:'edit',v:'view',w:'window',h:'help'};
 window.webContents.on('before-input-event',(event,input)=>{
  if(input.type==='keyDown'&&(input.control||input.meta)&&!input.shift){
   const key=input.key.toLowerCase(),action=input.alt?(key==='b'?'toggle-panel':null):({b:'toggle-sidebar',k:'search-work',n:'new-session',',':'settings'})[key];
   // One routing point prevents native accelerators and renderer shortcuts from
   // both toggling the same pane. Editing/zoom shortcuts keep their native roles.
   if(action){event.preventDefault();send(action);return;}
  }
  if(input.type==='keyDown'&&input.alt&&!input.control&&!input.meta&&altMenus[input.key.toLowerCase()]){event.preventDefault();send('menu:'+altMenus[input.key.toLowerCase()]);}
 });
 window.once('closed',()=>{ipcMain.removeHandler('window:menu');ipcMain.removeHandler('window:theme');});
 return menu;
}
module.exports={enabled,windowOptions,installWindowChrome,height};
