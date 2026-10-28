const {contextBridge,ipcRenderer}=require('electron');
let listener,activeId,failNext=false;const sent=[];
const root='/home/user/develop/input-replay';
contextBridge.exposeInMainWorld('desktop',{
 listWorks:async()=>[{root,name:'input-replay',kind:'work'}],listConnections:async()=>[],readWork:async()=>'',listHistory:async()=>({sessions:[],managed:[]}),
 getSettings:async()=>({settings:{runtime:'wsl'}}),copyText:async()=>{},
 start:async o=>{activeId=o.clientSessionId;setTimeout(()=>listener?.({type:'ready',clientSessionId:activeId}),0);return {runtime:'wsl',agentDir:'C:/test'};},
 request:async(type,data)=>{if(type==='get_messages')return {messages:await ipcRenderer.invoke('replay:messages')};if(type==='get_state')return {model:{name:'Replay'}};if(type==='prompt'){if(failNext){failNext=false;throw Error('测试发送失败');}sent.push(data);listener?.({type:'agent_start',clientSessionId:activeId});return {};}if(type==='abort_and_restore_queue'){listener?.({type:'prompt_result',status:'aborted',clientSessionId:activeId});return {followUp:[{text:'恢复队列',images:sent.at(-1)?.images||[]}]};}if(type==='get_available_commands')return {commands:[]};return {};},
 close:async()=>{},onEvent:fn=>{listener=fn;return()=>{};},
});
contextBridge.exposeInMainWorld('replay',{sent:()=>sent,fail:()=>{failNext=true;},emit:e=>listener?.({...e,clientSessionId:activeId})});
