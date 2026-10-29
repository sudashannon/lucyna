import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, FileText, Link2, RefreshCw, Search, X} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {Input} from '@cindy/components/ui/input';
import {Spinner} from '@cindy/components/ui/spinner';
import {SegmentedControl} from '@cindy/components/ui/segmented-control';
import {api} from '../api';
import {errorText} from '../errors';
import type {KnowledgeCatalog, KnowledgeCandidate, KnowledgeDetail, KnowledgeDocument, KnowledgeReview} from '../knowledge-types';
import {Document} from './Document';

type View = 'documents'|'candidates'|'reviews';
const views = [{value:'documents' as const,label:'文档库'},{value:'candidates' as const,label:'候选知识'},{value:'reviews' as const,label:'待核实'}];
const typeNames:Record<string,string> = {knowledge:'知识',proposal:'提案',plan:'计划',spec:'规范',tasks:'任务',report:'报告',change:'变更',artifact:'资料',design:'设计',session:'会话',diagram:'图表'};
const rules:Record<string,string> = {'dead-link':'失效链接','orphan':'孤立文档','orphan-component':'孤立文档','missing-frontmatter':'缺少元数据','low-quality':'内容待完善','stale-claim':'知识已过期','stale-evidence':'证据需更新'};
const candidateNames:Record<string,string> = {pending:'待审核',adopted:'已采纳',rejected:'已拒绝'};
const pageSize=40;
const date = (value?:string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}) : '更新时间未知';
const tags = (doc:KnowledgeDocument) => [...new Set(['tags','_derivedTags','_inheritedTags'].flatMap(key=>Array.isArray(doc.frontmatter?.[key]) ? (doc.frontmatter![key] as unknown[]).filter((t):t is string=>typeof t==='string') : []))];
const bodyText = (content:string) => content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'').trim();
const basename = (path:string) => path.split('/').pop() || path;
const normalPath = (base:string, href:string) => {
  const value=decodeURIComponent(href.split(/[?#]/)[0]);
  const parts=(value.startsWith('/')?value:base.slice(0,base.lastIndexOf('/')+1)+value).split('/'), out:string[]=[];
  for(const part of parts){if(part==='..')out.pop();else if(part&&part!=='.')out.push(part);}
  return '/'+out.join('/');
};

export const KnowledgePanel = memo(function KnowledgePanel({active,workName,onQuote,navigateTo,refreshKey=0,onAsk,onEdit,onSummary,onSession,onSearchEvidence,sidebarTarget}:{sidebarTarget?:HTMLElement|null;active:boolean;workName:string;onQuote:(text:string)=>void;navigateTo?:string;refreshKey?:number;onAsk?:(doc:KnowledgeDocument)=>void;onEdit?:(doc:KnowledgeDocument)=>void;onSummary?:(doc:KnowledgeDocument)=>void;onSession?:(id:string)=>void;onSearchEvidence?:(query:string,workspace:string)=>void}) {
  const [catalog,setCatalog]=useState<KnowledgeCatalog|null>(null),[loading,setLoading]=useState(false),[catalogError,setCatalogError]=useState('');
  const [view,setView]=useState<View>('documents'),[query,setQuery]=useState(''),[workspace,setWorkspace]=useState(''),[type,setType]=useState('knowledge'),[sort,setSort]=useState('recent');
  const [candidates,setCandidates]=useState<KnowledgeCandidate[]|null>(null),[reviews,setReviews]=useState<KnowledgeReview[]|null>(null),[extraLoading,setExtraLoading]=useState(false),[extraError,setExtraError]=useState('');
  const [status,setStatus]=useState('all'),[showDismissed,setShowDismissed]=useState(false),[page,setPage]=useState(0);
  const [selected,setSelected]=useState<Record<View,string>>({documents:'',candidates:'',reviews:''}),[readerOpen,setReaderOpen]=useState(false);
  const [loadedDetail,setDetail]=useState<KnowledgeDetail|null>(null),[detailBusy,setDetailBusy]=useState(false),[detailFailure,setDetailFailure]=useState<{id:string;message:string}>(),[actionError,setActionError]=useState('');
  const [reload,setReload]=useState(0),[relatedMore,setRelatedMore]=useState(false);
  const list=useRef<HTMLDivElement>(null),reader=useRef<HTMLDivElement>(null),reading=useRef(new Map<string,number>()),request=useRef(0),extraRequest=useRef(0);
  const listPosition=useRef(0);
  useLayoutEffect(()=>{if(active&&list.current)list.current.scrollTop=listPosition.current;},[active,sidebarTarget]);
  const catalogRequested=useRef(false),catalogBusy=useRef(false);
  const loadCatalog=useCallback(async(refresh=false)=>{if(catalogBusy.current)return;catalogBusy.current=true;setLoading(true);setCatalogError('');try{setCatalog(await api.knowledgeCatalog(refresh));}catch(e){setCatalogError(errorText(e));}finally{catalogBusy.current=false;setLoading(false);}},[]);
  useEffect(()=>{if(active&&!catalogRequested.current){catalogRequested.current=true;void loadCatalog();}},[active,loadCatalog]);
  const loadExtra=useCallback(async(next:View)=>{
    if(next==='documents')return;
    const token=++extraRequest.current;setExtraLoading(true);setExtraError('');
    try {const data=next==='candidates'?await api.knowledgeCandidates():await api.knowledgeReviews();if(token!==extraRequest.current)return;if(next==='candidates')setCandidates(data as KnowledgeCandidate[]);else setReviews(data as KnowledgeReview[]);}
    catch(e){if(token===extraRequest.current)setExtraError(errorText(e));}finally{if(token===extraRequest.current)setExtraLoading(false);}
  },[]);
  useEffect(()=>{++extraRequest.current;setExtraLoading(false);setExtraError('');if(view==='candidates'&&!candidates||view==='reviews'&&!reviews)void loadExtra(view);},[view,loadExtra]);
  useEffect(()=>{if(!active)return;const timer=window.setInterval(()=>{if(document.visibilityState!=='visible')return;void loadCatalog(true);if(view!=='documents')void loadExtra(view);},60000);return()=>window.clearInterval(timer);},[active,view,loadCatalog,loadExtra]);
  const documents=catalog?.documents||[];
  const byId=useMemo(()=>new Map(documents.map(d=>[d.id,d])),[documents]);
  const selectedId=selected[view], selectedCandidate=candidates?.find(c=>c.id===selectedId), selectedReview=reviews?.find(r=>r.id===selectedId);
  const docId=view==='documents'?selectedId:view==='reviews'?selectedReview?.issue.componentId||'':'';
  const detail=loadedDetail?.component.id===docId?loadedDetail:null;
  const detailError=detailFailure?.id===docId?detailFailure.message:'';
  // Selection changes render before the effect starts the next request.
  // Never interpret a missing response as an empty document.
  const waitingForDetail=view!=='candidates'&&!!docId&&(detailBusy||(!detail&&!detailError));
  const readingKey=view+':'+selectedId;
  const readingReady=view==='candidates'?!!selectedCandidate:!!detail;
  useEffect(()=>{
    const token=++request.current;setDetail(null);setDetailFailure(undefined);setActionError('');setRelatedMore(false);setDetailBusy(!!docId);
    if(!docId)return;
    void api.knowledgeDocument(docId).then(value=>{if(token===request.current)setDetail(value);}).catch(e=>{if(token===request.current)setDetailFailure({id:docId,message:errorText(e)});}).finally(()=>{if(token===request.current)setDetailBusy(false);});
  },[docId,reload]);
  useLayoutEffect(()=>{if(active&&readingReady&&reader.current)reader.current.scrollTop=reading.current.get(readingKey)||0;},[readingKey,detail,readerOpen,active,readingReady]);
  const normalized=query.trim().toLocaleLowerCase();
  const rows=useMemo(()=>{
    const match=(text:string)=>!normalized||normalized.split(/\s+/).every(word=>text.toLocaleLowerCase().includes(word));
    if(view==='documents')return documents.filter(d=>(!workspace||d.workspace===workspace)&&(!type||d.type===type)&&match([d.title,d.path,...tags(d)].join(' '))).sort((a,b)=>sort==='title'?a.title.localeCompare(b.title,'zh-CN'):(Date.parse(b.updatedAt||'')||0)-(Date.parse(a.updatedAt||'')||0)).map(d=>({id:d.id,title:d.title||basename(d.path),workspace:d.workspace,meta:typeNames[d.type]||d.type,description:d.path,time:date(d.updatedAt),tags:tags(d)}));
    if(view==='candidates')return (candidates||[]).filter(c=>(!workspace||c.workspace===workspace)&&(status==='all'||c.status===status)&&match(c.title+' '+c.text)).map(c=>({id:c.id,title:c.title,workspace:c.workspace,meta:candidateNames[c.status]||c.status,description:c.text.slice(0,180),time:'',tags:[] as string[]}));
    return (reviews||[]).filter(r=>(!workspace||r.workspace===workspace)&&(showDismissed||!r.dismissed)&&match([r.issue.detail,r.issue.componentId,byId.get(r.issue.componentId)?.title||'',r.issue.rule].join(' '))).map(r=>({id:r.id,title:byId.get(r.issue.componentId)?.title||basename(r.issue.componentId),workspace:r.workspace,meta:r.dismissed?'已忽略':rules[r.issue.rule]||r.issue.rule,description:r.issue.detail,time:'',tags:[] as string[]}));
  },[view,documents,candidates,reviews,normalized,workspace,type,sort,status,showDismissed,byId]);
  const maxPage=Math.max(0,Math.ceil(rows.length/pageSize)-1),currentPage=Math.min(page,maxPage),visible=rows.slice(currentPage*pageSize,(currentPage+1)*pageSize);
  const resetPage=()=>{listPosition.current=0;setPage(0);if(list.current)list.current.scrollTop=0;};
  const changeView=(next:View)=>{setView(next);setReaderOpen(false);setActionError('');resetPage();};
  const choose=(id:string)=>{if(view==='documents'&&byId.get(id)?.type==='session'&&onSession){onSession(id);return;}setSelected(s=>({...s,[view]:id}));setReaderOpen(true);setActionError('');};
  const openDocument=(id:string)=>{if(byId.get(id)?.type==='session'&&onSession){onSession(id);return;}setView('documents');setSelected(s=>({...s,documents:id}));setReaderOpen(true);setActionError('');};
  useEffect(()=>{if(navigateTo)openDocument(navigateTo);},[navigateTo]);
  useEffect(()=>{if(refreshKey){void loadCatalog(true);if(docId)setReload(v=>v+1);}},[refreshKey,loadCatalog]);
  const refresh=()=>{void loadCatalog(true);if(view!=='documents')void loadExtra(view);if(docId)setReload(v=>v+1);};
  const native=()=>{void api.webPreview('http://127.0.0.1:18989').catch(e=>setActionError(errorText(e)));};
  const selectedDoc=detail?.component||byId.get(docId);
  const content=view==='candidates'?selectedCandidate?.text||'':detail?.content||'';
  const title=view==='candidates'?selectedCandidate?.title:selectedDoc?.title;
  const currentWorkspace=view==='candidates'?selectedCandidate?.workspace:selectedDoc?.workspace||selectedReview?.workspace;
  const docBody=useMemo(()=>{const body=bodyText(content),heading=/^#\s+([^\n]+)\n?/.exec(body);return heading&&heading[1].replace(/\s/g,'')===title?.replace(/\s/g,'')?body.slice(heading[0].length).trim():body;},[content,title]);
  const relations=useMemo(()=>detail?[...detail.forward.map(edge=>({...edge,id:edge.to,direction:'引用'})),...detail.backlinks.map(edge=>({...edge,id:edge.from,direction:'被引用'}))]:[],[detail]);
  const onNavigate=useCallback((href:string)=>{
    try{if(!selectedDoc)return;const target=normalPath(selectedDoc.path,href);const found=documents.find(d=>d.path===target||d.id===target);if(!found)throw new Error('链接目标未被 Stele 索引，可在 Stele 中继续查看。');openDocument(found.id);}catch(e){setActionError(errorText(e));}
  },[selectedDoc,documents]);
  const resolveImage=useCallback((src:string)=>api.knowledgeImage(docId,src),[docId]);
  const quote=()=>{
    const selection=window.getSelection(),selectedText=selection&&!selection.isCollapsed&&reader.current?.contains(selection.anchorNode)&&reader.current?.contains(selection.focusNode)?selection.toString():'';
    const excerpt=selectedText||docBody.slice(0,2000);
    const source=view==='candidates'?`候选 ${selectedCandidate?.id}（${candidateNames[selectedCandidate?.status||'']||'尚未审核'}）`:selectedDoc?.path||docId;
    onQuote(`参考 Stele ${view==='candidates'?'候选知识':'知识'}：${title||source}\n来源：${source}\n知识库：${currentWorkspace||'未知'}\n\n${excerpt}${!selectedText&&docBody.length>2000?'\n（已截取前 2,000 字符，请按来源读取全文）':''}`);
  };
  const library=<section className="knowledge-library" hidden={!active} aria-label="知识列表">
        <div className="knowledge-filters"><div className="knowledge-search"><Search size={15} aria-hidden="true"/><Input aria-label="搜索知识库" placeholder={view==='documents'?'搜索标题、路径或标签…':'搜索标题或内容…'} value={query} onChange={v=>{setQuery(v);resetPage();}} trailing={query?<button className="icon-button" aria-label="清空知识库搜索" onClick={()=>{setQuery('');resetPage();}}><X size={13}/></button>:undefined}/></div>
          {view==='documents'&&onSearchEvidence&&<button className="knowledge-search-evidence" onClick={()=>onSearchEvidence(query,workspace)}><Search size={13}/>搜索正文与证据<ArrowUpRight size={13}/></button>}<div className="knowledge-filter-row"><select aria-label="知识库来源" value={workspace} onChange={e=>{setWorkspace(e.target.value);resetPage();}}><option value="">全部来源</option>{catalog?.workspaces.map(s=><option key={s.alias} value={s.alias}>{s.alias}</option>)}</select>{view==='documents'?<select aria-label="文档类型" value={type} onChange={e=>{setType(e.target.value);resetPage();}}><option value="">全部类型</option>{[...new Set(documents.map(d=>d.type))].sort().map(t=><option key={t} value={t}>{typeNames[t]||t}</option>)}</select>:view==='candidates'?<select aria-label="候选状态" value={status} onChange={e=>{setStatus(e.target.value);resetPage();}}><option value="all">全部状态</option>{Object.entries(candidateNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>:<label className="knowledge-checkbox"><input type="checkbox" checked={showDismissed} onChange={e=>{setShowDismissed(e.target.checked);resetPage();}}/>包含已忽略</label>}</div>
          <div className="knowledge-result-caption"><span role="status">{loading&&!catalog||extraLoading?'正在读取…':`${rows.length.toLocaleString()} ${view==='reviews'?'项待核实':view==='candidates'?'条候选':'篇文档'}`}</span>{view==='documents'&&<select aria-label="知识排序" value={sort} onChange={e=>{setSort(e.target.value);resetPage();}}><option value="recent">最近更新</option><option value="title">标题排序</option></select>}</div>
        </div>
        <div key={view} className="knowledge-list" data-view={view} ref={list} onScroll={()=>{if(active&&list.current)listPosition.current=list.current.scrollTop;}}>{extraError?<div className="knowledge-empty" role="alert"><p>{extraError}</p><Button variant="secondary" compact onClick={()=>void loadExtra(view)}>重试读取</Button></div>:loading&&!catalog||extraLoading?<div className="knowledge-empty" role="status"><Spinner size={20}/><p>正在读取 Stele…</p></div>:!visible.length?<div className="knowledge-empty"><Search size={24} aria-hidden="true"/><h2>{query||workspace?'没有匹配的内容':view==='reviews'?'暂无待核实项':view==='candidates'?'暂无候选知识':'暂无文档'}</h2><p>{query||workspace?'列表只匹配标题、路径和标签。也可以搜索正文与证据。':'内容来自 Stele 的原生索引。'}</p>{(query||workspace||type)&&<Button variant="secondary" compact onClick={()=>{setQuery('');setWorkspace('');setType('');setStatus('all');resetPage();}}>清除筛选</Button>}</div>:visible.map(row=><button key={`${view}:${row.id}`} className={`knowledge-row ${row.id===selectedId?'selected':''}`} aria-current={row.id===selectedId?'true':undefined} onClick={()=>choose(row.id)} title={row.title}><span className="knowledge-row-meta"><span>{row.workspace}</span><span>{row.meta}</span></span><strong>{row.title}</strong><span className="knowledge-row-description">{view==='documents'?row.description.split('/').slice(-3).join('/'):row.description}</span><span className="knowledge-row-bottom"><time>{row.time}</time>{row.tags.length>0&&<span>{row.tags.slice(0,2).join(' / ')}</span>}</span></button>)}</div>
        <div className="knowledge-pagination"><span>{rows.length?`${currentPage*pageSize+1}–${Math.min((currentPage+1)*pageSize,rows.length)} / ${rows.length}`:'0 条'}</span><div><button className="icon-button" aria-label="知识上一页" disabled={!currentPage} onClick={()=>{setPage(currentPage-1);list.current?.scrollTo(0,0);}}><ChevronLeft size={16}/></button><button className="icon-button" aria-label="知识下一页" disabled={currentPage>=maxPage} onClick={()=>{setPage(currentPage+1);list.current?.scrollTo(0,0);}}><ChevronRight size={16}/></button></div></div>
      </section>;
  return <section hidden={!active} className={`knowledge-screen ${readerOpen?'knowledge-reading':''} ${sidebarTarget?'knowledge-docked':''}`} aria-label="知识库">
    <header className="knowledge-header"><div><BookOpen size={19} aria-hidden="true"/><h1>知识库</h1><span className="knowledge-origin">Stele</span></div></header>
    <div className="knowledge-toolbar"><SegmentedControl value={view} onValueChange={changeView} options={views} role="tablist" aria-label="知识库视图"/><div className="knowledge-tools"><span className="knowledge-sync" title={catalog?.fetchedAt?`读取于 ${new Date(catalog.fetchedAt).toLocaleString('zh-CN')}`:''}>{catalog?`${catalog.workspaces.length} 个来源`:'连接 Stele'}</span><button className="icon-button" aria-label="刷新知识库" disabled={loading||extraLoading} onClick={refresh}>{loading||extraLoading?<Spinner size={15}/>:<RefreshCw size={15}/>}</button><Button variant="secondary" compact onClick={native}>在 Stele 中管理<ArrowUpRight size={13} aria-hidden="true"/></Button></div></div>
    {catalogError&&<div className="knowledge-alert" role="alert"><span>{catalogError}</span><Button variant="secondary" compact onClick={()=>void loadCatalog(true)} disabled={loading}>重试连接</Button></div>}
    {actionError&&<div className="knowledge-alert" role="alert"><span>{actionError}</span><button className="icon-button" aria-label="关闭知识库提示" onClick={()=>setActionError('')}><X size={15}/></button></div>}
    <div className="knowledge-body">
      {sidebarTarget?createPortal(library,sidebarTarget):library}
      <section className="knowledge-detail" aria-label="知识详情">
        <div className="knowledge-detail-toolbar"><button className="knowledge-back" onClick={()=>setReaderOpen(false)}><ChevronLeft size={15} aria-hidden="true"/>返回列表</button><span>{selectedId?'来源与正文':'阅读知识'}</span>{onEdit&&selectedDoc&&<Button compact variant="secondary" disabled={waitingForDetail||!!detailError||!!detail?.contentError} onClick={()=>onEdit(selectedDoc)}>编辑</Button>}{onSummary&&selectedDoc&&<Button compact variant="secondary" disabled={waitingForDetail||!!detailError||!!detail?.contentError} onClick={()=>onSummary(selectedDoc)}>摘要</Button>}{onAsk&&selectedDoc&&<Button compact variant="secondary" disabled={waitingForDetail||!!detailError||!!detail?.contentError} onClick={()=>onAsk(selectedDoc)}>询问文档</Button>}<Button compact disabled={!docBody||!workName||waitingForDetail||!!detailError||!!detail?.contentError} onClick={quote} title={workName?`追加到 ${workName} 的草稿；选中文本可仅引用选段`:'先选择一个工作区'}><Link2 size={13} aria-hidden="true"/>引用到对话</Button></div>
        <div className="knowledge-reader" ref={reader} onScroll={()=>{if(active&&readingReady&&reader.current)reading.current.set(readingKey,reader.current.scrollTop);}} tabIndex={0}>
          {!selectedId?<div className="knowledge-empty knowledge-reader-empty"><BookOpen size={32} strokeWidth={1.4} aria-hidden="true"/><h2>把知识带回正在做的事</h2><p>从左侧选择一篇文档，阅读来源与关联内容。<br/>选取需要的段落，引用到工作台的草稿。</p><span className="knowledge-empty-note">{workName?`当前工作区：${workName}`:'选择工作区后即可引用知识'}</span></div>:<>
            {selectedReview&&<div className="knowledge-review-note"><strong>{rules[selectedReview.issue.rule]||selectedReview.issue.rule}</strong><p>{selectedReview.issue.detail}</p><span>Stele 自动检查结果，需结合原文核实。</span></div>}
            {waitingForDetail?<div className="knowledge-empty" role="status"><Spinner size={20}/><p>读取正文与关联…</p></div>:detailError?<div className="knowledge-empty" role="alert"><h2>暂时无法读取文档</h2><p>{detailError}</p><Button variant="secondary" compact onClick={()=>setReload(v=>v+1)}>重试正文</Button></div>:<>
              <div className="knowledge-document-heading"><h2>{title||'知识详情'}</h2><div className="knowledge-document-meta"><span>{currentWorkspace}</span><span>{view==='candidates'?candidateNames[selectedCandidate?.status||'']||'候选知识':typeNames[selectedDoc?.type||'']||selectedDoc?.type}</span>{selectedDoc?.updatedAt&&<time>更新于 {date(selectedDoc.updatedAt)}</time>}</div>{selectedDoc&&<details className="knowledge-source"><summary>查看来源路径</summary><p>{selectedDoc.path}</p></details>}{view==='candidates'&&<p className="knowledge-candidate-note">{selectedCandidate?.status==='adopted'?'已采纳的知识候选，保留提炼时的证据。':'此内容是候选记录，使用前请核实原始证据。'} 编辑、采纳与拒绝可在 Stele 中完成。</p>}</div>
              {detail?.contentError?<div className="knowledge-alert" role="alert"><span>{detail.contentError}</span><Button compact variant="secondary" onClick={()=>setReload(v=>v+1)}>重试正文</Button></div>:<Document key={readingKey} content={docBody||'此文档暂无正文。'} onError={e=>setActionError(errorText(e))} onNavigate={onNavigate} resolveImage={view==='documents'||view==='reviews'?resolveImage:undefined}/>}
              {view==='candidates'&&<section className="knowledge-relations"><h3>原始证据 <span>{selectedCandidate?.references?.length||0}</span></h3>{selectedCandidate?.references?.length?selectedCandidate.references.map((ref,i)=><div key={ref.id||i} className="knowledge-evidence"><span>{ref.workspace} / {ref.freshness==='stale'?'证据已过期':ref.freshness==='current'?'证据当前有效':'有效性未知'}</span><button className="knowledge-related" disabled={!byId.has(ref.id)&&!documents.some(d=>d.path===ref.path)} onClick={()=>openDocument(byId.has(ref.id)?ref.id:documents.find(d=>d.path===ref.path)!.id)}>{ref.title||ref.path||ref.id}<ArrowUpRight size={14}/></button><p>{ref.excerpt}</p>{ref.path&&<small>{ref.path}{ref.lineStart?`:${ref.lineStart}`:''}</small>}</div>):<p className="helper-text">此候选没有附带证据，请在使用前核实来源。</p>}</section>}
              {detail&&<section className="knowledge-relations"><h3>关联文档 <span>{relations.length}</span></h3><p className="helper-text">区分文档引用与 Stele 检索到的相似内容。</p>{detail.relationsError&&<p role="alert" className="error-text">{detail.relationsError}</p>}{!relations.length&&!detail.relationsError&&<p className="helper-text">Stele 暂未返回关联文档。</p>}{(relatedMore?relations:relations.slice(0,8)).map((rel,i)=><button key={rel.id+rel.kind+i} className="knowledge-related" onClick={()=>openDocument(rel.id)}><FileText size={15} aria-hidden="true"/><span>{byId.get(rel.id)?.title||basename(rel.id)}<small>{rel.kind==='similar'?'相似内容':rel.direction+' · '+rel.kind}{byId.get(rel.id)?.workspace?' / '+byId.get(rel.id)?.workspace:''}</small></span><ChevronRight size={14} aria-hidden="true"/></button>)}{relations.length>8&&<button className="text-action" onClick={()=>setRelatedMore(v=>!v)}>{relatedMore?'收起关联':`查看全部 ${relations.length} 条关联`}</button>}</section>}
            </>}
          </>}
        </div>
        <footer className="knowledge-reader-footer">{workName?`引用将追加到 ${workName} 的当前草稿`:'先选择工作区，即可引用到对话'}<span>不会自动发送</span></footer>
      </section>
    </div>
  </section>;
});
