const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',{
  mode:'native',
  getSettings:async()=>({settings:{version:1,runtime:'wsl',windowsExecutable:'',wslExecutable:'omp',wslAgentDir:'',model:'',thinking:'high'},storage:'isolated acceptance profile',workspace:{distro:'fixture',user:'fixture',root:'/fixture'}}),
  listWorks:async()=>[],listConnections:async()=>[],onEvent:()=>()=>{},onTerminal:()=>()=>{},
  getPet:async()=>({settings:{enabled:false},warning:'',sessions:[]}),petContext:async()=>{},onPetNavigate:()=>()=>{},
  knowledgeCatalog:refresh=>ipcRenderer.invoke('knowledge-test','catalog',{refresh}),
  knowledgeDocument:id=>ipcRenderer.invoke('knowledge-test','document',{id}),
  knowledgeCandidates:()=>ipcRenderer.invoke('knowledge-test','candidates'),
  knowledgeReviews:()=>ipcRenderer.invoke('knowledge-test','reviews'),
  knowledgeImage:(id,src)=>ipcRenderer.invoke('knowledge-test','image',{id,src}),
  knowledgeRequest:(kind,args={})=>ipcRenderer.invoke('knowledge-test',kind,args),
  knowledgeSaveFile:(name,bytes)=>ipcRenderer.invoke('knowledge-test-save',name,bytes),
  onKnowledge:fn=>{const listener=(_event,data)=>fn(data);ipcRenderer.on('stele:knowledge-event',listener);return()=>ipcRenderer.removeListener('stele:knowledge-event',listener);},
});
