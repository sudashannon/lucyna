// Public gallery only: synthetic data, no production IPC, filesystem or model calls.
const {contextBridge}=require('electron');
let listener;
const root='/home/demo/work/lucyna',date='2026-10-28T08:00:00Z';
const works=['lucyna','docs-site','design-system'].map(name=>({name,root:'/home/demo/work/'+name,kind:'gitless',health:'ok',state:'active'}));
const session='# Lucyna · 工作摘要\n\n- 状态: active\n- 目标: 让原生 OMP 在桌面上更好用。\n\n## 下一步\n\n- [x] 原生会话与工作区切换\n- [x] 文件阅读与知识引用\n- [ ] 整理下一轮交互反馈\n\n> 此内容为公开截图使用的演示数据。';
const markdown='# 一次工作，留下可复用的知识\n\nLucyna 把 **原生会话**、工作文件与长期知识放在同一个工作台。\n\n## 上下文分层\n\n| 层次 | 保存什么 |\n| --- | --- |\n| Work | 当前目标、进展与共享笔记 |\n| Stele | 跨任务复用的知识与证据 |\n\n## 工作流\n\n```mermaid\nflowchart LR\n  A[任务] --> B[OMP]\n  B --> C[Work]\n  C --> D[Stele]\n```\n\n- [x] 保留原生技能与工具\n- [x] 让阅读位置随工作保留\n- [ ] 持续改进交互体验\n';
const docs=['工作上下文与长期知识','原生会话的生命周期','Markdown 与图表阅读','桌面伙伴的状态设计'].map((title,i)=>({id:'demo-'+i,title,path:'knowledge/'+['context.md','sessions.md','reading.md','companion.md'][i],workspace:'lucyna',type:'knowledge',updatedAt:date,frontmatter:{tags:i?['设计','工作台']:['架构','记忆']}}));
const settings={version:1,runtime:'wsl',windowsExecutable:'omp',wslExecutable:'/usr/local/bin/omp',wslAgentDir:'/home/demo/.omp/agent',model:'',thinking:'medium'};
contextBridge.exposeInMainWorld('desktop',{
  listWorks:async()=>works,readWork:async()=>session,
  getSettings:async()=>({settings,storage:'Demo profile',workspace:{distro:'Ubuntu-22.04',user:'demo',root:'/home/demo/work'}}),
  listHistory:async()=>({sessions:['完善桌面工作流','整理知识库阅读体验','检查文件预览'].map((title,i)=>({title,id:'gallery-'+i,cwd:root,sessionFile:root+'/demo-'+i+'.jsonl',modified:date,runtime:'wsl'})),managed:[]}),
  onEvent:fn=>{listener=fn;return()=>{listener=null;};},onTerminal:()=>()=>{},
  start:async()=>{setTimeout(()=>listener?.({type:'ready',runtime:'wsl'}),20);return{runtime:'wsl'};},close:async()=>{},respond:async()=>{},
  request:async(type)=>{
    if(type==='get_state')return{model:{name:'演示模型'},isSettled:true};
    if(type==='get_messages')return{messages:[]};
    if(type==='get_available_commands')return{commands:[{name:'skill:work-review',source:'skill',description:'检查当前工作状态'}]};
    return{};
  },
  knowledgeCatalog:async()=>({documents:docs,workspaces:[{alias:'lucyna',path:'/home/demo/knowledge',purpose:{goal:'可复用的项目知识'}}],fetchedAt:date}),
  knowledgeDocument:async id=>({component:docs.find(d=>d.id===id)||docs[0],content:markdown,forward:[{from:id,to:'demo-1',kind:'related',source:'demo'}],backlinks:[]}),
  knowledgeCandidates:async()=>[],knowledgeReviews:async()=>[],
  listFiles:async()=>({directory:'',entries:['SESSION.md','architecture.md'].map(name=>({name,path:root+'/'+name,kind:'markdown'})),total:2,nextOffset:null}),
  readPreview:async(_root,reference)=>({kind:'markdown',name:reference.split('/').pop(),path:reference,content:reference.endsWith('SESSION.md')?session:markdown}),
  choosePreview:async()=>null,chooseSession:async()=>null,copyText:async()=>{},
});
contextBridge.exposeInMainWorld('gallery',{
  ready:()=>listener?.({type:'ready',runtime:'wsl'}),
  conversation:()=>{
    listener?.({type:'message_start',messageId:'demo-user',message:{role:'user',content:[{type:'text',text:'整理一下当前工作，把可以复用的经验留到知识库里。'}]}});
    listener?.({type:'tool_execution_start',toolCallId:'demo-read',toolName:'read',args:{path:'SESSION.md'},intent:'读取当前工作摘要'});
    listener?.({type:'tool_execution_end',toolCallId:'demo-read',toolName:'read',result:{content:[{type:'text',text:session}]}});
    listener?.({type:'message_end',messageId:'demo-answer',message:{role:'assistant',content:[{type:'text',text:'工作上下文已经整理好了。\n\n### 让下一次开始更轻松\n\n- **当前进展**留在 Work，继续任务时能直接接上。\n- **可复用的经验**进入 Stele，供不同会话检索和引用。\n- **原生 OMP 能力**保持不变，技能和工具继续由它执行。\n\n你可以从右侧阅读工作摘要，或打开知识库查看关联文档。\n\n> 演示会话 · 用于展示界面，不是实际模型执行记录。'}]}});
    listener?.({type:'prompt_result',status:'completed',sessionSettled:true});
  },
});
