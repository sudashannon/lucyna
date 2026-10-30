import {memo,useEffect,useState} from 'react';
import {createPortal} from 'react-dom';
import {BookOpen,Compass,Inbox,ListChecks,Plus,RefreshCw,Wrench} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {SegmentedControl} from '@cindy/components/ui/segmented-control';
import {api} from '../api';
import {KnowledgePanel as KnowledgeLibrary} from './KnowledgePanel';
import {GraphView,SearchView,SessionsView,CalendarView} from './knowledge/Explore';
import {MaintenanceView} from './knowledge/Maintenance';
import {SourceCaptureDialog,SourcesView} from './knowledge/Sources';
import {TodosView,ReportsView,ActivityView,SettingsView} from './knowledge/Tools';
import {Document} from './Document';
import {Evidence,KnowledgeDialog,OperationNotice,RemoteState,useOperation,useRemote} from './knowledge/shared';
import type {KnowledgeCatalog,KnowledgeDocument,KnowledgeEvidence} from '../knowledge-types';
import '../knowledge-workspace.css';

const groups=[{id:'documents',label:'文档库',icon:BookOpen},{id:'explore',label:'探索',icon:Compass},{id:'sources',label:'来源资料',icon:Inbox},{id:'maintenance',label:'知识维护',icon:Wrench},{id:'tools',label:'待办与报告',icon:ListChecks}];
const tabs:Record<string,{value:string;label:string}[]>={documents:[],sources:[],explore:[{value:'search',label:'证据检索'},{value:'graph',label:'知识图谱'},{value:'sessions',label:'会话记忆'},{value:'calendar',label:'时间线'}],maintenance:[{value:'candidates',label:'候选知识'},{value:'reviews',label:'待核实'}],tools:[{value:'todos',label:'待办'},{value:'reports',label:'报告'},{value:'activity',label:'处理活动'},{value:'settings',label:'知识库设置'}]};
export const KnowledgeWorkspace=memo(function KnowledgeWorkspace({active,workName,onQuote,onBack,sidebarTarget,sidebarExpanded=true}:{active:boolean;workName:string;onQuote:(text:string)=>void;onBack?:()=>void;sidebarTarget?:HTMLElement|null;sidebarExpanded?:boolean}){
  const [libraryTarget,setLibraryTarget]=useState<HTMLDivElement|null>(null);
  const [group,setGroup]=useState('documents'),[tab,setTab]=useState(''),[workspace,setWorkspace]=useState(''),[visited,setVisited]=useState(new Set(['documents'])),[revision,setRevision]=useState(0),[documentId,setDocumentId]=useState(''),[sessionId,setSessionId]=useState(''),[capture,setCapture]=useState(false),[captured,setCaptured]=useState<{workspace:string;id:string}>(),[evidence,setEvidence]=useState<KnowledgeEvidence>(),[ask,setAsk]=useState<KnowledgeDocument>(),[summaryDoc,setSummaryDoc]=useState<KnowledgeDocument>(),[edit,setEdit]=useState<KnowledgeDocument>(),operation=useOperation();
  const catalog=useRemote<KnowledgeCatalog>('catalog',{},active,revision),current=group==='documents'||group==='sources'?group:tab;
  const [searchSeed,setSearchSeed]=useState<{query:string;nonce:number}>();
  const change=()=>setRevision(n=>n+1);
  const searchEvidence=(query:string,scope:string)=>{setWorkspace(scope);setSearchSeed({query,nonce:Date.now()});navigate('explore','search');};
  const navigate=(g:string,t=tabs[g][0]?.value||'')=>{setGroup(g);setTab(t);setVisited(old=>new Set([...old,g==='documents'||g==='sources'?g:t]));};
  const open=(id:string)=>{const node=catalog.data?.documents.find(doc=>doc.id===id);if(node?.type==='session'){setSessionId(id);setWorkspace(node.workspace);navigate('explore','sessions');return;}setDocumentId(id);navigate('documents');};
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>{if(document.visibilityState==='visible')change();},60000);return()=>clearInterval(timer);},[active]);
  const data=catalog.data||null;
  const context=group!=='documents'&&<div className="knowledge-workspace-context"><div>{tabs[group].length>0?(sidebarTarget&&sidebarExpanded?<nav className="knowledge-sidebar-subnav" aria-label="知识功能视图">{tabs[group].map(t=><button key={t.value} aria-current={tab===t.value?'page':undefined} onClick={()=>navigate(group,t.value)}>{t.label}</button>)}</nav>:<SegmentedControl value={tab} options={tabs[group]} onValueChange={v=>navigate(group,v)} aria-label="知识功能视图"/>):<span>保留原文，留下来源</span>}</div>{!['graph','activity','settings'].includes(current)&&<select aria-label="知识功能来源" value={workspace} onChange={e=>setWorkspace(e.target.value)}><option value="">{group==='sources'?'请选择知识来源':'全部来源'}</option>{data?.workspaces.map(w=><option key={w.alias}>{w.alias}</option>)}</select>}</div>;
  const navigation=<nav className={sidebarTarget?'knowledge-sidebar-nav':'knowledge-workspace-nav'} aria-label="知识库功能">{groups.map(({id,label,icon:Icon})=><button type="button" key={id} title={label} aria-label={label} aria-current={group===id?'page':undefined} onClick={()=>navigate(id)}><Icon size={16}/><span>{label}</span></button>)}</nav>;
  const actions=<><button type="button" className="nav-action new-chat" aria-label="添加来源" title="添加来源" onClick={()=>setCapture(true)}><Plus size={16}/><span>添加来源</span></button><button type="button" className="icon-button" title="刷新知识库" aria-label="刷新知识库" disabled={catalog.busy} onClick={change}><RefreshCw size={16}/></button></>;
  return <>{sidebarTarget&&createPortal(<div className={`knowledge-sidebar ${sidebarExpanded?'':'is-compact'}`} hidden={!active}>
    <div className="knowledge-sidebar-actions">{actions}</div>{navigation}
    {sidebarExpanded&&context}
    <div className="knowledge-sidebar-library" ref={setLibraryTarget} hidden={current!=='documents'||!sidebarExpanded}/>
    {sidebarExpanded&&group!=='documents'&&<p className="knowledge-sidebar-note">{data?`${data.workspaces.length} 个来源 · ${data.documents.length.toLocaleString()} 篇文档`:'正在连接 Stele'}<br/>切换页面会保留当前会话和草稿。</p>}
  </div>,sidebarTarget)}<section id="primary-panel-knowledge" role="tabpanel" aria-labelledby="primary-tab-knowledge" className="knowledge-screen knowledge-workspace" hidden={!active} aria-label="知识库">
    <header className="knowledge-workspace-heading"><div><BookOpen size={19}/><h1>知识库</h1><span>{sidebarTarget?groups.find(g=>g.id===group)?.label:'把做过的事，变成下次的起点。'}</span></div>{!sidebarTarget&&<div>{actions}{onBack&&<Button compact variant="secondary" onClick={onBack}>返回工作台</Button>}</div>}</header>
    {!sidebarTarget&&navigation}
    {(!sidebarTarget||!sidebarExpanded)&&context}
    {catalog.error&&<div className="knowledge-alert" role="alert"><span>{catalog.error}</span><Button compact variant="secondary" onClick={catalog.refresh}>重试连接</Button></div>}
    <div className="knowledge-workspace-content">
      <KnowledgeLibrary sidebarTarget={sidebarExpanded?libraryTarget:null} active={active&&current==='documents'} workName={workName} onQuote={onQuote} navigateTo={documentId} refreshKey={revision} onAsk={setAsk} onEdit={setEdit} onSummary={setSummaryDoc} onSession={open} onSearchEvidence={searchEvidence}/>
      {visited.has('search')&&<div className="knowledge-view" hidden={current!=='search'}><SearchView seed={searchSeed} active={active&&current==='search'} revision={revision} workspace={workspace} onEvidence={setEvidence} onQuote={onQuote}/></div>}
      {visited.has('graph')&&<div className="knowledge-view" hidden={current!=='graph'}><GraphView active={active&&current==='graph'} revision={revision} onOpen={open}/></div>}
      {visited.has('sessions')&&<div className="knowledge-view" hidden={current!=='sessions'}><SessionsView active={active&&current==='sessions'} revision={revision} workspace={workspace} catalog={data} onOpen={open} onChanged={change} focusId={sessionId}/></div>}
      {visited.has('calendar')&&<div className="knowledge-view" hidden={current!=='calendar'}><CalendarView active={active&&current==='calendar'} revision={revision} workspace={workspace} onOpen={open}/></div>}
      {visited.has('sources')&&<div className="knowledge-view" hidden={current!=='sources'}><SourcesView active={active&&current==='sources'} revision={revision} workspace={workspace} focusId={captured?.workspace===workspace?captured.id:undefined} onCapture={()=>setCapture(true)} onEvidence={setEvidence} onChanged={()=>{setCaptured(undefined);change();}} onCandidate={()=>navigate('maintenance','candidates')}/></div>}
      {(['candidates','reviews'] as const).map(view=>visited.has(view)&&<div className="knowledge-view" key={view} hidden={current!==view}><MaintenanceView tab={view} active={active&&current===view} revision={revision} workspace={workspace} catalog={data} onEvidence={setEvidence} onOpen={open} onChanged={change}/></div>)}
      {visited.has('todos')&&<div className="knowledge-view" hidden={current!=='todos'}><TodosView active={active&&current==='todos'} revision={revision} workspace={workspace} catalog={data} onOpen={open} onChanged={change}/></div>}
      {visited.has('reports')&&<div className="knowledge-view" hidden={current!=='reports'}><ReportsView active={active&&current==='reports'} revision={revision} workspace={workspace}/></div>}
      {visited.has('activity')&&<div className="knowledge-view" hidden={current!=='activity'}><ActivityView active={active&&current==='activity'} revision={revision}/></div>}
      {visited.has('settings')&&<div className="knowledge-view" hidden={current!=='settings'}><SettingsView active={active&&current==='settings'} revision={revision} workspace={workspace} catalog={data} onChanged={change}/></div>}
    </div>
    {capture&&<SourceCaptureDialog open onClose={()=>setCapture(false)} catalog={data} workspace={workspace} onComplete={(scope,result)=>{setCaptured({workspace:scope,id:result.id});setWorkspace(scope);change();navigate('sources');}}/>}
    {evidence&&<EvidenceReader reference={evidence} onClose={()=>setEvidence(undefined)} onOpen={id=>{setEvidence(undefined);open(id);}}/>}
    {ask&&<KnowledgeChat doc={ask} onClose={()=>setAsk(undefined)} onEvidence={setEvidence} onQuote={text=>{setAsk(undefined);onQuote(text);}} onCandidate={()=>{setAsk(undefined);change();navigate('maintenance','candidates');}}/>}
    {summaryDoc&&<KnowledgeSummary doc={summaryDoc} onClose={()=>setSummaryDoc(undefined)}/>}
    {edit&&<DocumentEditor doc={edit} onClose={()=>setEdit(undefined)} onSaved={()=>{setEdit(undefined);change();}}/>}
  </section></>;
});

function EvidenceReader({reference,onClose,onOpen}:{reference:KnowledgeEvidence;onClose:()=>void;onOpen:(id:string)=>void}){
  const snapshot=useRemote<{content:string;version:string;workspace:string}>('snapshot',{id:reference.id},true),match=snapshot.data?.version===reference.version&&snapshot.data?.workspace===reference.workspace;
  return <KnowledgeDialog open onClose={onClose} title={reference.title||'核对原始证据'} wide><div className="knowledge-native-meta"><span>{reference.workspace}</span><span>{reference.lineStart?`原文第 ${reference.lineStart} 至 ${reference.lineEnd||reference.lineStart} 行`:''}</span></div><RemoteState {...snapshot} onRetry={snapshot.refresh}>{snapshot.data&&<>{!match&&<p className="knowledge-operation-error" role="alert">原文版本已变化或引用未提供可匹配版本。下面保留引用片段，请重新核对当前来源。</p>}<Evidence reference={reference} onOpen={()=>onOpen(reference.id)}/>{match&&reference.lineStart?<div className="knowledge-evidence-lines" aria-label="原文定位">{snapshot.data.content.split('\n').slice(Math.max(0,reference.lineStart-3),Math.min(snapshot.data.content.split('\n').length,(reference.lineEnd||reference.lineStart)+2)).map((line,i)=>{const number=Math.max(1,reference.lineStart!-2)+i;return <div key={number} className={number>=reference.lineStart!&&number<=(reference.lineEnd||reference.lineStart!)?'highlight':''}><span>{number}</span><pre>{line||' '}</pre></div>;})}</div>:<Document content={snapshot.data.content} onError={()=>{}}/>}<Button compact variant="secondary" onClick={()=>onOpen(reference.id)}>阅读全文</Button></>}</RemoteState></KnowledgeDialog>;
}
function DocumentEditor({doc,onClose,onSaved}:{doc:KnowledgeDocument;onClose:()=>void;onSaved:()=>void}){
  const snapshot=useRemote<{content:string;etag:string}>('snapshot',{id:doc.id}),[text,setText]=useState(''),operation=useOperation();
  useEffect(()=>{if(snapshot.data)setText(snapshot.data.content);},[snapshot.data]);
  return <KnowledgeDialog open onClose={()=>{if(!operation.busy)onClose();}} title={'编辑文档：'+doc.title} wide><p className="knowledge-native-muted">直接修改来源文档，保存时校验当前文件版本。发生冲突时保留你的编辑内容。</p><RemoteState {...snapshot} onRetry={snapshot.refresh}><label className="knowledge-field">Markdown 正文<textarea className="knowledge-document-editor" aria-label="文档 Markdown 正文" rows={20} value={text} onChange={e=>setText(e.target.value)} disabled={operation.busy}/></label><div className="knowledge-native-actions"><Button compact variant="secondary" disabled={operation.busy} onClick={onClose}>取消</Button><Button compact variant="cta" disabled={!snapshot.data?.etag||!text.trim()} loading={operation.busy} onClick={()=>void operation.run(async()=>{await api.knowledgeRequest('artifactWrite',{id:doc.id,content:text,etag:snapshot.data!.etag});onSaved();})}>保存文档</Button></div></RemoteState><OperationNotice operation={operation}/></KnowledgeDialog>;
}
function KnowledgeChat({doc,onClose,onEvidence,onQuote,onCandidate}:{doc:KnowledgeDocument;onClose:()=>void;onEvidence:(ref:KnowledgeEvidence)=>void;onQuote:(text:string)=>void;onCandidate:()=>void}){
  const [question,setQuestion]=useState(''),[complete,setComplete]=useState(false),[evidenceOnly,setEvidenceOnly]=useState(true),[answer,setAnswer]=useState(''),[references,setReferences]=useState<KnowledgeEvidence[]>([]),[requestId,setRequestId]=useState(''),operation=useOperation();
  const history=useRemote<{messages:{role:string;content:{type:string;text?:string}[]}[]}>('chatSession',{workspace:doc.workspace,componentId:doc.id,change:doc.id});
  useEffect(()=>{if(!requestId)return;return api.onKnowledge(data=>{if(data.requestId!==requestId)return;if(data.event.type==='delta')setAnswer(text=>text+(data.event.content||''));if(data.event.references)setReferences(data.event.references);});},[requestId]);
  useEffect(()=>()=>{if(requestId)void api.knowledgeRequest('chatCancel',{requestId}).catch(()=>{});},[requestId]);
  const submit=()=>{if(operation.busy)return;const id=crypto.randomUUID();setRequestId(id);setComplete(false);setAnswer('');setReferences([]);void operation.run(async()=>{const result=await api.knowledgeRequest('chat',{workspace:doc.workspace,componentId:doc.id,change:doc.id,message:question,evidenceOnly,requestId:id});setAnswer(result.answer);setReferences(result.references||[]);setComplete(true);history.refresh();});};
  return <KnowledgeDialog open onClose={onClose} title={'询问：'+doc.title} wide><label className="knowledge-checkbox"><input type="checkbox" checked={evidenceOnly} onChange={e=>setEvidenceOnly(e.target.checked)} disabled={operation.busy}/>仅使用选定文档证据</label>{!answer&&history.data&&history.data?.messages?.length>0&&<details className="knowledge-chat-history"><summary>查看已有对话（{history.data?.messages?.length} 条）</summary>{history.data?.messages?.map((message,i)=><section key={i}><strong>{message.role==='user'?'你':'回答'}</strong><Document content={message.content.filter(b=>b.type==='text').map(b=>b.text||'').join('\n')} onError={()=>{}}/></section>)}</details>}{history.error&&<p className="knowledge-operation-error">历史读取失败：{history.error}</p>}{answer&&<div className="knowledge-chat-answer"><Document content={answer} streaming={operation.busy} onError={()=>{}}/>{references.map((ref,i)=><Evidence reference={ref} key={ref.id+i} onOpen={onEvidence}/>)}{!operation.busy&&complete&&<div className="knowledge-native-actions"><Button compact variant="secondary" onClick={()=>onQuote(`参考知识问答：${doc.title}\n来源：${doc.path}\n\n${answer}`)}>引用到草稿</Button><Button compact variant="secondary" disabled={!references.length} onClick={()=>void operation.run(async()=>{await api.knowledgeRequest('candidateCreate',{workspace:doc.workspace,componentId:doc.id,title:question.slice(0,100),text:answer,references});onCandidate();})}>整理为候选</Button></div>}</div>}<label className="knowledge-field">你的问题<textarea aria-label="文档问答问题" rows={3} value={question} disabled={operation.busy} onChange={e=>setQuestion(e.target.value)}/></label><div className="knowledge-native-actions"><Button compact variant="cta" disabled={!question.trim()||operation.busy} loading={operation.busy} onClick={submit}>发送问题</Button>{operation.busy&&<Button compact variant="secondary" onClick={()=>void api.knowledgeRequest('chatCancel',{requestId})}>停止回答</Button>}</div><OperationNotice operation={operation}/></KnowledgeDialog>;
}






function KnowledgeSummary({doc,onClose}:{doc:KnowledgeDocument;onClose:()=>void}){const remote=useRemote<{summary:string}>('summary',{id:doc.id});return <KnowledgeDialog open onClose={onClose} title={'文档摘要：'+doc.title} wide><RemoteState {...remote} onRetry={remote.refresh}>{remote.data&&<Document content={remote.data.summary} onError={()=>{}}/>}</RemoteState></KnowledgeDialog>;}
