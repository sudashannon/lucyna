const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('feedbackAudio',{
 subscribe:fn=>{ipcRenderer.on('feedback:play',(_,data)=>fn(data));ipcRenderer.on('feedback:stop',()=>fn(null));},
 report:result=>ipcRenderer.send('feedback:played',result),
});
