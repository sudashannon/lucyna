// Controlled failure/latency fixture. Loaded only by renderer-behavior.cjs.
const {contextBridge,ipcRenderer} = require('electron');
let listener, picker, closeGate, promptGate, failStart=true, immediate=false, failResponse=false;
let followUp=[]; const requests=[];
let catalogMode='normal',catalogPending;const catalog=[{name:'skill:fixture-work',source:'skill',description:'工作技能'},{name:'work-review',source:'file',description:'只读检查'}];
let terminalListener;const terminalRequests=[];
const calls={starts:0,prompts:0,closes:0,responses:[]};
const roots=['fixture-a','fixture-b'].map(name=>({name,root:'/home/user/develop/'+name,kind:'work'}));
contextBridge.exposeInMainWorld('desktop',{
  copyText:text=>ipcRenderer.invoke('fixture:copy-text',text),
  listWorks:async()=>roots,readWork:async()=> '# Fixture SESSION',listHistory:async()=>({sessions:[],managed:[]}),
  start:async()=>{calls.starts++;if(failStart){failStart=false;throw Error('fixture startup failure');}setTimeout(()=>listener?.({type:'ready'}),10);return {runtime:'wsl'};},
  close:async()=>{calls.closes++;if(closeGate)await new Promise(resolve=>{closeGate=resolve;});listener?.({type:'process_exit',code:0});},
  request:async(type,data)=>{
    requests.push({type,data});
    if(type==='get_messages')return {messages:[]};if(type==='get_state')return {model:{name:'fixture-model'}};
    if(type==='get_available_commands'){if(catalogMode==='fail')throw Error('fixture catalog failure');if(catalogMode==='hold')return new Promise(resolve=>catalogPending=resolve);return {commands:catalog};}
    if(type==='prompt'&&data.message==='/fixture-local'){calls.prompts++;return {agentInvoked:false};}
    if(type==='prompt'){calls.prompts++;if(immediate){if(data.message.startsWith('Queued')){followUp.push(data.message);listener?.({type:'queue_update',steering:[],followUp:[...followUp]});}return {};}return new Promise(resolve=>{promptGate=resolve;});}
    if(type==='remove_queued_message'){const index=followUp.indexOf(data.message);if(index>=0)followUp.splice(index,1);listener?.({type:'queue_update',steering:[],followUp:[...followUp]});return {removed:index>=0};}
    if(type==='abort_and_restore_queue'){const restored=followUp.map(text=>({text}));followUp=[];listener?.({type:'queue_update',steering:[],followUp:[]});listener?.({type:'prompt_result',status:'aborted',sessionSettled:true});return {steering:[],followUp:restored};}
    return {};
  },
  onEvent:callback=>{listener=callback;return ()=>{listener=null;};},
  respond:async response=>{if(failResponse){failResponse=false;throw Error('fixture reply failure');}calls.responses.push(response);},
  chooseSession:()=>new Promise(resolve=>{picker=resolve;}),
  importSession:async()=>{throw Error('cancelled picker should not import');},
  startTerminal:async(root,dimensions)=>new Promise(resolve=>{terminalRequests.push({id:dimensions.requestId,root,resolve});}),
  closeTerminal:async id=>{terminalListener?.({type:'exit',id,cancelled:true});return true;},
  terminalInput:async()=>{},terminalResize:async()=>true,
  onTerminal:callback=>{terminalListener=callback;return ()=>{terminalListener=null;};},
});
contextBridge.exposeInMainWorld('fixture',{
  snapshot:()=>({...calls,pickerPending:!!picker,closePending:typeof closeGate==='function'}),
  failNextResponse:()=>{failResponse=true;},
  cancelPicker:()=>{picker?.(null);picker=null;},
  complete:()=>{promptGate?.({});promptGate=null;listener?.({type:'prompt_result',status:'completed',sessionSettled:true});},
  holdClose:()=>{closeGate=true;}, releaseClose:()=>{const resolve=closeGate;closeGate=null;if(typeof resolve==='function')resolve();},
  emit:e=>listener?.(e),
  immediate:()=>{immediate=true;}, requests:()=>requests,
  catalogMode:mode=>{catalogMode=mode;}, catalogPending:()=>!!catalogPending,
  releaseCatalog:commands=>{const resolve=catalogPending;catalogPending=null;resolve?.({commands});},
  terminalStarts:()=>terminalRequests.map(({id,root})=>({id,root})),
  terminalReady:index=>{const request=terminalRequests[index];request.resolve({id:request.id});},
  terminalExit:index=>{terminalListener?.({type:'exit',id:terminalRequests[index].id,exitCode:0});},
});
