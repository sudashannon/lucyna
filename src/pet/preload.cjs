const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('companion',{
 snapshot:()=>ipcRenderer.invoke('pet:snapshot'),
 action:(action,data)=>ipcRenderer.invoke('pet:action',action,data),
 hit:hit=>ipcRenderer.invoke('pet:hit',hit),
 layout:layout=>ipcRenderer.invoke('pet:layout',layout),
 drag:action=>ipcRenderer.invoke('pet:drag',action),
 subscribe:fn=>{const listener=(_event,data)=>fn(data);ipcRenderer.on('pet:state',listener);return()=>ipcRenderer.removeListener('pet:state',listener);}
});
