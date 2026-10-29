// Independent visual preview. No OMP sessions, shared profile, or pet IPC.
const {app,BrowserWindow}=require('electron'),path=require('node:path');
app.setPath('userData',path.resolve(__dirname,'../.runtime/pet-animation-preview-profile'));
app.whenReady().then(async()=>{const win=new BrowserWindow({width:1120,height:650,title:'Lucyna · 动画预览',autoHideMenuBar:true,backgroundColor:'#f8f8f5',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));await win.loadFile(path.resolve(__dirname,'../design/pixel-pet-v2/preview.html'));});app.on('window-all-closed',()=>app.quit());
