// Offline integration fixture. All IPC is handled by experience-desktop.cjs.
const {contextBridge,ipcRenderer}=require('electron');
const call=(name,...args)=>ipcRenderer.invoke('test:'+name,...args);
contextBridge.exposeInMainWorld('desktop',{
 mode:'demo',
 windowChrome:{enabled:process.argv.includes('--lucyna-titlebar'),menu:(id,position)=>ipcRenderer.invoke('window:menu',id,position),theme:theme=>ipcRenderer.invoke('window:theme',theme),onAction:fn=>{const listener=(_,action)=>fn(action);ipcRenderer.on('window:action',listener);return()=>ipcRenderer.removeListener('window:action',listener);}},
 listWorks:()=>call('works'),listConnections:async()=>[],readWork:async()=>'',getSettings:async()=>({settings:{runtime:'wsl'}}),
 listHistory:root=>call('history',root),previewHistoryDeletion:(source,root)=>call('delete-preview',source,root),deleteHistory:(source,root,token)=>call('delete',source,root,token),restoreHistory:(root,key)=>call('restore',root,key),
 importSession:(source,root)=>call('import',source,root),start:options=>call('start',options),request:(type,data,id)=>call('request',type,data,id),close:id=>call('close',id),
 chooseSession:async()=>null,onTerminal:()=>()=>{},onEvent:fn=>{const listener=(_,event)=>fn(event);ipcRenderer.on('test:event',listener);return()=>ipcRenderer.removeListener('test:event',listener);},
 knowledgeCatalog:()=>call('knowledge','catalog'),knowledgeDocument:id=>call('knowledge','document',{id}),knowledgeCandidates:()=>call('knowledge','candidates'),knowledgeReviews:()=>call('knowledge','reviews'),knowledgeImage:async()=>{throw Error('演示窗口没有外部图片。');},
 openExternal:url=>call('external',url),petContext:async()=>{},copyText:async()=>{},
});
