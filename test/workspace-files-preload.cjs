// Deterministic offline fixture: no filesystem, SSH, Git writes or model calls.
const {contextBridge}=require('electron');
const listeners=new Set(),calls=[];let starts=0;
const emit=event=>{for(const listener of listeners)listener(event);};
const root='/home/demo/work/lucyna',date='2026-11-01T00:00:00Z',oid='a'.repeat(40);
const works=[{name:'lucyna',root,kind:'work',branch:'codex/workspace-files'},{name:'other-work',root:'/home/demo/work/other',kind:'work',branch:'main'},
 {name:'remote-lucyna',root,kind:'work',branch:'build/check',hostId:'fixture-host',hostName:'demo-server',hostStatus:'connected'}];
const patch=(value)=>'diff --git a/src/App.tsx b/src/App.tsx\nindex 1111111..2222222 100644\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,2 +1,2 @@\n-const old = true;\n+const '+value+' = true;\n export {};\n';
const member=name=>({name,path:root+'/repos/'+name,repo:'/home/demo/repos/'+name+'.git',branch:'codex/workspace-files',registeredBranch:'codex/workspace-files',head:oid,base:'main',baseSha:oid,counts:{staged:1,unstaged:1,untracked:1,conflicts:0}});
const session='# Work\n\n## 定位\n- 状态: active\n- 目标: 在对话旁审查本轮改动\n- 当前: 已接入侧栏差异查看\n';
const clientSessionId='review-fixture',sessionFile='/home/demo/omp/review.jsonl';
const turns=[Date.parse(date),Date.parse(date)+90000];
const history=turns.flatMap((timestamp,index)=>[
  {role:'user',timestamp,content:index===0?'把 Git 审查放到对话右侧':'缩窄窗口后保留可读的审查入口'},
  {role:'assistant',timestamp:timestamp+1500,content:index===0?'已将文件差异并排放在对话右侧。':
    '清理完成。\n\n| 项 | 结果 |\n| --- | --- |\n| 本地分支 | 已清理 `feature/very_long_branch_used_to_verify_the_sidebar_table_scroll_boundary` |\n| 草稿 | 关闭窄窗抽屉后可继续编辑 |\n\n可继续核对。'},
]);
let latestReview=false;
let restoreHistory;
const historyReady=new Promise(resolve=>{restoreHistory=resolve;});
contextBridge.exposeInMainWorld('desktop',{
 mode:'demo',listWorks:async()=>works,readWork:async()=>session,
 listConnections:async()=>[{id:clientSessionId,root,sessionFile,runtime:'wsl',ready:true,busy:false}],
 startTerminal:async(terminalRoot,{requestId})=>{calls.push({kind:'terminal',root:terminalRoot});return {id:requestId};},
 closeTerminal:async()=>{},terminalResize:async()=>{},
 getSettings:async()=>({settings:{runtime:'wsl',thinking:'medium'},workspace:{distro:'Ubuntu-22.04',root:'/home/demo/work',user:'demo'},storage:'isolated fixture'}),
 listHistory:async()=>({sessions:[],managed:[]}),workRun:async()=>[],
 listTurnChanges:async id=>id===clientSessionId?turns.slice(0,latestReview?2:1).map(t=>({messageId:'user-'+t,files:1,partial:false})):[],
 readTurnChanges:async (id,key)=>{
   const index=turns.findIndex(timestamp=>key==='user-'+timestamp);
   if(id!==clientSessionId||index<0)return null;
   return {messageId:key,startedAt:turns[index],finishedAt:turns[index]+1500,warnings:[],
     files:[{member:'app',path:'src/App.tsx',patch:patch(index===0?'prior_round':'later_round')}]};
 },
 workDetails:async(workRoot,hostId)=>{if(hostId)throw Error('此主机版本尚不支持文件与 Git');calls.push({kind:'details',root:workRoot});return {root:workRoot,name:workRoot.split('/').pop(),content:session,kind:'work',members:[member('app'),member('tools')],assets:[],issues:[],warnings:[],fetchedAt:date,modifiedAt:date};},
 workGit:async(workRoot,name,action,options={})=>{
   calls.push({kind:'git',root:workRoot,member:name,action,options});
   const result={kind:action,checkedAt:date};
   if(action==='changes')return {...result,files:[{path:'src/App.tsx',code:'MM',staged:true,unstaged:true},{path:'新 文件.md',code:'??',untracked:true}],counts:{staged:1,unstaged:1,untracked:1,conflicts:0}};
   if(action==='diff'){if(options.file==='src/App.tsx')await new Promise(r=>setTimeout(r,100));return {...result,text:patch(name+'_'+options.scope)};}
   if(action==='history')return {...result,commits:[{oid,parents:[],date,author:'Fixture',subject:'工作区文件与 Git 审查'}],nextCursor:null};
   if(action==='commit'||action==='compare')return {...result,text:patch(action)};
   if(action==='refs')return {...result,branches:[{ref:'refs/heads/main',name:'main',oid,date,current:false,remote:false,upstream:'origin/main'},{ref:'refs/heads/codex/workspace-files',name:'codex/workspace-files',oid,date,current:true,remote:false,upstream:''}]};
   if(action==='worktrees')return {...result,worktrees:[{path:root+'/repos/app',branch:'refs/heads/codex/workspace-files',head:oid},{path:'/home/demo/work/other/repos/app',branch:'refs/heads/another',head:oid,locked:'review'}]};
   throw Error('Unexpected fixture action '+action);
 },
 listFiles:async(workRoot,directory,options,hostId)=>{if(hostId)throw Error('此主机版本尚不支持文件与 Git');calls.push({kind:'files',root:workRoot});return {directory:'',entries:[{name:'SESSION.md',path:'SESSION.md',kind:'markdown'},{name:'App.tsx',path:'repos/app/src/App.tsx',kind:'text'}],total:2,nextOffset:null};},
 readPreview:async(workRoot,path)=>{calls.push({kind:'read',root:workRoot,path});return {kind:path.endsWith('.md')?'markdown':'text',name:path.split('/').pop(),path,content:'# 工作区文件\n\n'+workRoot+'\n\n'+Array.from({length:45},(_,i)=>'## 阅读位置 '+i+'\n\n这是演示资料。切换到 Git 或对话后保留当前工作区的阅读状态。\n').join('\n')};},
 onEvent:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};},onTerminal:()=>()=>{},
 start:async()=>{starts++;setTimeout(()=>emit({type:'ready',runtime:'wsl'}),10);return{runtime:'wsl'};},
 request:async type=>type==='get_state'?{isSettled:true,sessionFile}:type==='get_messages'?historyReady:type==='get_available_commands'?{commands:[]}:{},
 copyText:async()=>{},close:async()=>{},respond:async()=>{}
});
contextBridge.exposeInMainWorld('workspaceFixture',{
 stats:()=>({starts,calls}),
 showStoppedTasks:()=>{
   emit({type:'agent_start',clientSessionId});
   emit({type:'prompt_result',clientSessionId,status:'aborted'});
   for(const id of ['inspect','build','verify'])emit({
     type:'subagent_lifecycle',clientSessionId,payload:{id,agent:id,description:'测试任务 '+id,status:'aborted'},
   });
 },
 restoreHistory:()=>restoreHistory({messages:history}),
 completeRound:()=>emit({type:'prompt_result',clientSessionId,status:'completed',sessionSettled:true}),
 publishLatestReview:()=>{latestReview=true;emit({type:'turn_changes_ready',clientSessionId});},
});
