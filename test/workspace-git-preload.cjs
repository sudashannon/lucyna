const {contextBridge,ipcRenderer}=require('electron');
const c=(n,...a)=>ipcRenderer.invoke(n,...a);
contextBridge.exposeInMainWorld('desktop',{
 listWorks:()=>c('fixture:works'),readWork:()=>c('fixture:document'),listConnections:async()=>[],listHistory:async()=>({sessions:[],managed:[]}),
 getSettings:async()=>({settings:{runtime:'wsl'}}),workRun:async()=>[],
 workDetails:(...a)=>c('fixture:details',...a),workGit:(...a)=>c('fixture:read',...a),gitWorkspace:(...a)=>c('fixture:git',...a),
 listFiles:(...a)=>c('fixture:files',...a),readPreview:(...a)=>c('fixture:preview',...a),
 onEvent:()=>()=>{},onTerminal:()=>()=>{},copyText:async()=>{},start:()=>c('fixture:start'),close:async()=>{},request:async()=>({}),petContext:async()=>{}
});
