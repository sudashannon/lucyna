import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ArrowUpRight,BookOpen,Check,ChevronLeft,ChevronRight,ListPlus,RefreshCw,Search,Sparkles,Trash2,X} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {api} from '../../api';
import type {KnowledgeCatalog,KnowledgeReview,KnowledgeReviewAdvice} from '../../knowledge-types';
import {Document} from '../Document';
import {KnowledgeDialog,OperationNotice,RemoteState,Split,useOperation,useRemote} from './shared';
import {reviewPresentation} from './review-presentation';
import '../../knowledge-reviews.css';
import {errorText} from '../../errors';

type Props={active:boolean;revision:number;workspace:string;catalog:KnowledgeCatalog|null;onOpen:(id:string)=>void;onChanged:()=>void};
const normalize=(value:string)=>value.trim().replace(/\s+/g,' ').toLocaleLowerCase();
const reviewVersion=(item:KnowledgeReview)=>JSON.stringify([item.id,item.workspace,item.issue.inputRevision||'']);
type DeleteTarget={review:KnowledgeReview;title:string;source:string;path:string;count:number;operationId:string;documentId?:string;documentRevision?:string;readError?:string};
type DeleteResult={deleted:boolean;documentId:string;operationId:string;indexed:boolean;warning?:string};

export function ReviewsView({active,revision,workspace,catalog,onOpen,onChanged}:Props){
  const remote=useRemote<KnowledgeReview[]>('reviews',{},active,revision),operation=useOperation(),deletion=useOperation();
  const [selected,setSelected]=useState(''),[reading,setReading]=useState(false),[query,setQuery]=useState(''),[rule,setRule]=useState('all'),[includeDismissed,setIncludeDismissed]=useState(false),[retract,setRetract]=useState<KnowledgeReview|null>(null),[adviceRefreshEpoch,setAdviceRefreshEpoch]=useState(0);
  const pane=useRef<HTMLElement>(null);
  const surface=useRef<HTMLDivElement>(null),focusAfterDelete=useRef(false);
  const [deleteTarget,setDeleteTarget]=useState<DeleteTarget|null>(null),[deletedVersions,setDeletedVersions]=useState<Set<string>>(()=>new Set()),[deleteWarning,setDeleteWarning]=useState('');
  const busy=operation.busy||deletion.busy;
  const documents=useMemo(()=>new Map(catalog?.documents.map(d=>[d.id,d])||[]),[catalog]);
  const sourceName=(alias:string)=>catalog?.workspaces.find(w=>w.alias===alias)?.name||alias;
  const title=(review:KnowledgeReview)=>documents.get(review.issue.componentId)?.title||'待核实文档';
  const scoped=(remote.data||[]).filter(r=>(!workspace||r.workspace===workspace)&&!deletedVersions.has(reviewVersion(r)));
  const visible=scoped.filter(r=>includeDismissed||!r.dismissed),search=normalize(query);
  const rules=[...new Set(visible.map(r=>r.issue.rule))];
  const rows=visible.filter(r=>(rule==='all'||r.issue.rule===rule)&&(!search||normalize([title(r),sourceName(r.workspace),reviewPresentation(r.issue).label,r.issue.detail].join(' ')).includes(search)));
  const item=rows.find(r=>r.id===selected)||rows[0],position=item?rows.indexOf(item):-1;
  const presentation=item?reviewPresentation(item.issue):undefined;
  const resetFilters=()=>{setQuery('');setRule('all');setSelected('');setReading(false);};
  useEffect(()=>{setSelected('');setReading(false);},[workspace]);
  useEffect(()=>{setDeletedVersions(new Set());},[remote.data]);
  useEffect(()=>{
    if(!deleteTarget&&focusAfterDelete.current){
      focusAfterDelete.current=false;
      requestAnimationFrame(()=>{const heading=pane.current?.querySelector<HTMLElement>('h2');const fallback=surface.current?.querySelector<HTMLElement>('.knowledge-review-title h2');(heading||fallback)?.focus({preventScroll:true});});
    }
  },[deleteTarget]);
  useEffect(()=>{pane.current?.parentElement?.scrollTo({top:0});},[item?.id]);
  useEffect(()=>{
    const list=pane.current?.closest('.knowledge-native-split')?.querySelector<HTMLElement>('.knowledge-native-list'),row=list?.querySelector<HTMLElement>('.knowledge-review-row[aria-current="true"]');
    if(!list||!row||!list.getClientRects().length)return;
    const bounds=list.getBoundingClientRect(),current=row.getBoundingClientRect(),inset=list.querySelector('.knowledge-review-list-heading')?.clientHeight||0;
    if(current.top<bounds.top+inset)list.scrollTop+=current.top-bounds.top-inset;
    else if(current.bottom>bounds.bottom)list.scrollTop+=current.bottom-bounds.bottom;
  },[item?.id,reading,active]);
  useEffect(()=>{if(reading&&pane.current?.closest('.knowledge-native-split')?.querySelector('.knowledge-native-list')?.getClientRects().length===0)pane.current.querySelector('h2')?.focus({preventScroll:true});},[reading,item?.id]);
  const choose=(id:string)=>{setSelected(id);setReading(true);operation.clear();deletion.clear();};
  const back=()=>{setReading(false);requestAnimationFrame(()=>pane.current?.closest('.knowledge-native-split')?.querySelector<HTMLButtonElement>('.knowledge-review-row[aria-current="true"]')?.focus({preventScroll:true}));};
  const perform=async(action:string,target=item)=>{
    if(!target)return;
    await operation.run(async()=>{
      await api.knowledgeRequest('reviewAction',{id:target.id,workspace:target.workspace,revision:target.issue.inputRevision,action});
      setRetract(null);remote.refresh();onChanged();
    },`${title(target)}：${{dismiss:'已忽略此版本',todo:'已转为待办',reverify:'已确认仍适用',retract:'已撤回结论'}[action]||'操作已完成'}`);
  };
  const readDeleteVersion=async(target:DeleteTarget)=>{
    setDeleteTarget(current=>current?.operationId===target.operationId?{...current,readError:undefined}:current);
    try{
      const snapshot=await api.knowledgeRequest('libraryRead',{document:target.review.issue.componentId}) as {id:string;revision:string;workspace:string};
      if(!snapshot.id||!snapshot.revision||snapshot.workspace!==target.review.workspace)throw Error('暂时无法确认文档版本，请关闭对话框并刷新列表。');
      setDeleteTarget(current=>current?.operationId===target.operationId?{...current,documentId:snapshot.id,documentRevision:snapshot.revision}:current);
    }catch(error){setDeleteTarget(current=>current?.operationId===target.operationId?{...current,readError:errorText(error)}:current);}
  };
  const openDelete=()=>{
    if(!item||busy||!item.issue.inputRevision)return;
    operation.clear();deletion.clear();
    const target={review:item,title:title(item),source:sourceName(item.workspace),path:documents.get(item.issue.componentId)?.path||item.issue.componentId,count:(remote.data||[]).filter(r=>r.workspace===item.workspace&&r.issue.componentId===item.issue.componentId).length,operationId:crypto.randomUUID()};
    setDeleteTarget(target);void readDeleteVersion(target);
  };
  const deleteDocument=async()=>{
    if(!deleteTarget?.documentId||!deleteTarget.documentRevision)return;
    const target=deleteTarget;
    await deletion.run(async()=>{
      const result=await api.knowledgeRequest('reviewDelete',{id:target.review.id,workspace:target.review.workspace,revision:target.review.issue.inputRevision,documentId:target.documentId,documentRevision:target.documentRevision,operationId:target.operationId}) as DeleteResult;
      if(!result?.deleted)throw Error('未能确认删除结果，请重试。');
      const removed=(remote.data||[]).filter(r=>r.workspace===target.review.workspace&&r.issue.componentId===target.review.issue.componentId);
      setDeletedVersions(previous=>new Set([...previous,reviewVersion(target.review),...removed.map(reviewVersion)]));
      const warning=result.warning||(!result.indexed?'文档已删除，检索索引尚未更新。请稍后刷新。':'');
      setDeleteWarning(warning?`${target.title}：${warning}`:'');
      focusAfterDelete.current=true;setDeleteTarget(null);remote.refresh();onChanged();
    },`${target.title}：已删除文档`);
  };
  return <div className="knowledge-reviews" ref={surface}>
    <header className="knowledge-review-toolbar">
      <div className="knowledge-review-title"><h2 tabIndex={-1}>待核实</h2><span>{remote.data?`${scoped.filter(r=>!r.dismissed).length.toLocaleString()} 项待处理`:'正在读取提醒…'}</span></div>
      <div className="knowledge-review-filters">
        <label className="knowledge-review-search"><Search size={16} aria-hidden="true"/><input aria-label="筛选待核实文档" placeholder="搜索文档或问题" value={query} onChange={e=>{setQuery(e.target.value);setReading(false);}}/>{query&&<button type="button" aria-label="清除搜索" onClick={()=>setQuery('')}><X size={14}/></button>}</label>
        <select aria-label="核实问题类型" value={rule} onChange={e=>{setRule(e.target.value);setSelected('');setReading(false);}}><option value="all">全部问题</option>{rules.map(r=><option key={r} value={r}>{reviewPresentation({rule:r,componentId:'',detail:''}).label}</option>)}{rule!=='all'&&!rules.includes(rule)&&<option value={rule}>{reviewPresentation({rule,componentId:'',detail:''}).label}</option>}</select>
        <label className="knowledge-review-dismissed"><input type="checkbox" checked={includeDismissed} onChange={e=>{setIncludeDismissed(e.target.checked);setReading(false);}}/>包含已忽略</label>
        <button type="button" className="knowledge-review-refresh" aria-label="刷新待核实列表" title="刷新待核实列表" disabled={remote.busy} onClick={()=>{setAdviceRefreshEpoch(epoch=>epoch+1);remote.refresh();}}><RefreshCw size={16}/></button>
      </div>
    </header>
    <div className="knowledge-review-notice"><OperationNotice operation={operation}/>{!deleteTarget&&<OperationNotice operation={deletion}/>} {deleteWarning&&<p className="knowledge-review-delete-warning" role="status">{deleteWarning}</p>}</div>
    <RemoteState busy={remote.busy&&!remote.data} error={remote.error} onRetry={remote.refresh}>
      {!rows.length?<div className="knowledge-review-empty"><Check size={24}/><h3>{search||rule!=='all'?'没有符合条件的提醒':'当前没有待核实内容'}</h3><p>{search||rule!=='all'?'试试其他关键词或问题类型。':'文档检查产生的新提醒会出现在这里。'}</p>{(search||rule!=='all')&&<Button compact variant="secondary" onClick={resetFilters}>清除筛选</Button>}</div>:<Split reading={reading} onBack={back} list={<>
        <div className="knowledge-review-list-heading"><span>{search||rule!=='all'?'筛选结果':'文档与问题'}</span><span>{rows.length.toLocaleString()} 项</span></div>
        {rows.map(r=>{const summary=reviewPresentation(r.issue);return <button type="button" key={r.id} className="knowledge-review-row" aria-current={item?.id===r.id?'true':undefined} onClick={()=>choose(r.id)}>
          <strong>{title(r)}</strong>
          <span className="knowledge-review-row-meta"><span>{summary.label}</span><span>{r.dismissed?'已忽略':sourceName(r.workspace)}</span></span>
        </button>;})}
      </>}>
        {item&&presentation&&<article ref={pane} className="knowledge-native-article knowledge-review-detail" key={item.id}>
          <h2 tabIndex={-1}>{title(item)}</h2>
          <div className="knowledge-review-position"><span>{sourceName(item.workspace)}<span className="knowledge-review-state">{item.dismissed?'已忽略':'待处理'}</span></span><div><span>{position+1} / {rows.length}</span><button type="button" aria-label="上一条提醒" disabled={position<=0} onClick={()=>choose(rows[position-1].id)}><ChevronLeft size={16}/></button><button type="button" aria-label="下一条提醒" disabled={position>=rows.length-1} onClick={()=>choose(rows[position+1].id)}><ChevronRight size={16}/></button></div></div>
          <section className="knowledge-review-issue" aria-label="核实原因"><h3>{presentation.label}</h3><p>{presentation.summary}</p>{item.issue.rule==='stale-claim'&&<blockquote className="knowledge-review-claim">{claimText(item.issue.detail)}</blockquote>}{item.issue.rule==='dead-link'&&item.issue.target&&<p className="knowledge-review-target">关联目标：<code>{item.issue.target}</code></p>}<p className="knowledge-review-guidance">{presentation.guidance}</p></section>
          <div className="knowledge-review-actions" aria-busy={busy}>
            <Button compact variant={item.issue.rule==='stale-claim'?'secondary':'cta'} onClick={()=>onOpen(item.issue.componentId)}><BookOpen size={15}/>查看原文</Button>
            {item.issue.rule==='stale-claim'&&<Button compact variant="cta" disabled={busy||!item.issue.inputRevision} onClick={()=>void perform('reverify')}>确认仍适用</Button>}
            <Button compact variant="secondary" disabled={busy||!item.issue.inputRevision} onClick={()=>void perform('todo')}><ListPlus size={15}/>转为待办</Button>
            {item.issue.rule==='stale-claim'&&<button className="knowledge-review-text-action" disabled={busy||!item.issue.inputRevision} onClick={()=>setRetract(item)}>撤回结论</button>}
            <button className="knowledge-review-text-action" disabled={busy||item.dismissed||!item.issue.inputRevision} onClick={()=>void perform('dismiss')}>{item.dismissed?'此版本已忽略':'忽略此版本'}</button>
            <Button compact tone="danger" disabled={busy||!item.issue.inputRevision} onClick={openDelete}><Trash2 size={15}/>删除文档</Button>
          </div>
          {operation.busy&&<p className="knowledge-review-footnote" role="status">正在保存处理结果…</p>}
          <p className="knowledge-review-footnote">忽略仅对本次检查版本生效，文档或相关依据变化后可能再次提醒。</p>
          {!item.issue.inputRevision&&<p className="knowledge-operation-error" role="alert">暂时无法确认检查版本。你仍可查看原文，请刷新列表后再处理。</p>}
          <ReviewAdvice item={item} revision={revision} refreshEpoch={adviceRefreshEpoch} active={active} onOpen={onOpen} sourceName={sourceName}/>
          <ReviewPreview id={item.issue.componentId} title={title(item)} active={active} revision={revision} onOpen={onOpen}/>
          <details className="knowledge-review-diagnostics"><summary>查看检查详情</summary><dl><div><dt>检查规则</dt><dd>{item.issue.rule}</dd></div>{documents.get(item.issue.componentId)?.path&&<div><dt>文档路径</dt><dd>{documents.get(item.issue.componentId)?.path}</dd></div>}</dl><p>{item.issue.detail}</p>{item.issue.target&&<p>关联目标：{item.issue.target}</p>}</details>
        </article>}
      </Split>}
    </RemoteState>
    <KnowledgeDialog open={!!retract} onClose={()=>{if(!operation.busy)setRetract(null);}} title="撤回这条结论？"><p>撤回后保留历史，结论将不再参与活跃召回。</p><div className="knowledge-native-actions"><Button compact variant="secondary" disabled={operation.busy} onClick={()=>setRetract(null)}>取消</Button><Button compact variant="cta" loading={operation.busy} onClick={()=>void perform('retract',retract||undefined)}>确认撤回</Button></div><OperationNotice operation={operation}/></KnowledgeDialog>
    <KnowledgeDialog open={!!deleteTarget} onClose={()=>{if(!deletion.busy){setDeleteTarget(null);deletion.clear();}}} title="删除这篇文档？">
      {deleteTarget&&<div className="knowledge-review-delete-confirm">
        <div className="knowledge-review-delete-target"><strong>{deleteTarget.title}</strong><span>{deleteTarget.source}</span><span>{deleteTarget.path}</span></div>
        <p>文档将从知识目录移除，同时清除它的 {deleteTarget.count} 条核实提醒。历史版本保留在本地删除记录中。</p>
        <p className="knowledge-review-delete-note">其他文档中指向它的链接可能失效。导入前的来源文件和附件不会删除。</p>
        {!deleteTarget.documentRevision&&!deleteTarget.readError&&<p role="status">正在核对文档版本…</p>}
        {deleteTarget.readError&&<p className="knowledge-operation-error" role="alert">{deleteTarget.readError}<button type="button" className="knowledge-review-text-action" onClick={()=>void readDeleteVersion(deleteTarget)}>重试读取</button></p>}
        <div className="knowledge-native-actions"><Button compact variant="secondary" disabled={deletion.busy} onClick={()=>{setDeleteTarget(null);deletion.clear();}}>取消</Button><Button compact tone="danger-solid" className="knowledge-review-delete-submit" disabled={!deleteTarget.documentRevision} loading={deletion.busy} onClick={()=>void deleteDocument()}>确认删除</Button></div>
        {deletion.busy&&<p role="status">正在删除文档…</p>}
        <OperationNotice operation={deletion}/>
        {deletion.error&&<p className="knowledge-review-delete-note">若提示版本已变化，请取消并刷新列表后重新核对。</p>}
      </div>}
    </KnowledgeDialog>
  </div>;
}

function ReviewAdvice({item,revision,refreshEpoch,active,onOpen,sourceName}:{item:KnowledgeReview;revision:number;refreshEpoch:number;active:boolean;onOpen:(id:string)=>void;sourceName:(alias:string)=>string}){
  const identity=JSON.stringify([item.id,item.workspace,item.issue.inputRevision||'',revision,refreshEpoch]);
  const recordIdentity=JSON.stringify([item.id,item.workspace,item.issue.inputRevision||'']);
  const sequence=useRef({cache:0,generation:0});
  const generationRequests=useRef(new Map<string,number>()),latestIdentity=useRef(identity),latestItem=useRef(item),mounted=useRef(true);
  latestIdentity.current=identity;latestItem.current=item;
  const [state,setState]=useState<{identity:string;loading:boolean;generating:boolean;checked:boolean;error:string;advice?:KnowledgeReviewAdvice}>({identity,loading:false,generating:false,checked:false,error:''});
  const current=state.identity===identity?state:undefined;
  const advice=current?.advice;
  const generating=generationRequests.current.has(recordIdentity);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;sequence.current.cache++;};},[]);
  useEffect(()=>{
    if(!active)return;
    const request=++sequence.current.cache;
    const generationInFlight=generationRequests.current.has(recordIdentity);
    setState({identity,loading:!!item.issue.inputRevision&&!generationInFlight,generating:generationInFlight,checked:!item.issue.inputRevision,error:''});
    if(!item.issue.inputRevision||generationInFlight)return ()=>{sequence.current.cache++;};
    void api.knowledgeRequest('reviewAdvice',{id:item.id,workspace:item.workspace,revision:item.issue.inputRevision,generate:false}).then(result=>{
      const value=result as KnowledgeReviewAdvice|null;
      if(sequence.current.cache===request&&mounted.current){
        const latest=latestItem.current;
        const matches=!value||(value.reviewId===latest.id&&value.workspace===latest.workspace&&value.inputRevision===latest.issue.inputRevision&&value.documentId===latest.issue.componentId&&value.rule===latest.issue.rule);
        setState({identity,loading:false,generating:false,checked:true,error:matches?'':'这条提醒的版本已变化，请刷新列表后重新生成建议。',advice:matches?value||undefined:undefined});
      }
    }).catch(error=>{
      if(sequence.current.cache===request&&mounted.current)setState({identity,loading:false,generating:false,checked:true,error:errorText(error)});
    });
    return ()=>{sequence.current.cache++;};
  },[active,identity,item.id,item.issue.componentId,item.issue.inputRevision,item.issue.rule,item.workspace,revision,refreshEpoch]);
  const generate=async(refresh=!!advice)=>{
    if(!item.issue.inputRevision||generationRequests.current.has(recordIdentity))return;
    const request=++sequence.current.generation;
    generationRequests.current.set(recordIdentity,request);
    sequence.current.cache++;
    setState({identity,loading:false,generating:true,checked:true,error:'',advice});
    try{
      const result=await api.knowledgeRequest('reviewAdvice',{id:item.id,workspace:item.workspace,revision:item.issue.inputRevision,generate:true,refresh});
      const value=result as KnowledgeReviewAdvice;
      const latest=latestItem.current,stillSelected=recordIdentity===JSON.stringify([latest.id,latest.workspace,latest.issue.inputRevision||'']);
      if(generationRequests.current.get(recordIdentity)===request&&mounted.current&&stillSelected){
        const matches=value.reviewId===latest.id&&value.workspace===latest.workspace&&value.inputRevision===latest.issue.inputRevision&&value.documentId===latest.issue.componentId&&value.rule===latest.issue.rule;
        setState({identity:latestIdentity.current,loading:false,generating:false,checked:true,error:matches?'':'这条提醒的版本已变化，请刷新列表后重新生成建议。',advice:matches?value:undefined});
      }
    }catch(error){
      const latest=latestItem.current,stillSelected=recordIdentity===JSON.stringify([latest.id,latest.workspace,latest.issue.inputRevision||'']);
      if(generationRequests.current.get(recordIdentity)===request&&mounted.current&&stillSelected)setState({identity:latestIdentity.current,loading:false,generating:false,checked:true,error:errorText(error),advice:latestIdentity.current===identity?advice:undefined});
    }finally{
      if(generationRequests.current.get(recordIdentity)===request)generationRequests.current.delete(recordIdentity);
    }
  };
  const copy=async(text:string)=>{try{await api.copyText(text);}catch(error){if(latestIdentity.current===identity)setState(old=>old.identity===identity?{...old,error:errorText(error)}:old);}};
  const checking=!current&&active&&!!item.issue.inputRevision;
  return <section className="knowledge-review-advice" aria-label="Agent 处理建议" aria-busy={generating}>
    <div className="knowledge-review-advice-heading"><h3><Sparkles size={15}/>Agent 处理建议</h3><Button compact variant="secondary" aria-label={advice?'重新生成建议':'生成处理建议'} disabled={!item.issue.inputRevision||checking||!!current?.loading||generating} loading={generating} onClick={()=>void generate()}>{advice?'重新生成建议':'生成处理建议'}</Button></div>
    {!item.issue.inputRevision?<p className="knowledge-review-footnote">这条提醒缺少可确认的版本信息，暂时无法生成建议。请刷新待核实列表。</p>:generating?<p className="knowledge-review-footnote" role="status">正在生成处理意见…</p>:checking?<p className="knowledge-review-footnote" role="status">正在核对当前版本的已保存建议…</p>:current?.loading?<p className="knowledge-review-footnote" role="status">正在查找这条记录已保存的建议…</p>:null}
    {current?.error&&<p className="knowledge-review-advice-error" role="alert">{current.error}<button type="button" onClick={()=>void generate(!!advice)}>重试</button></p>}
    {advice&&<div className="knowledge-review-advice-content">
      <p className="knowledge-review-advice-summary">{advice.summary}</p>
      {!!advice.steps?.length&&<><h4>建议处理</h4><ol>{advice.steps.map((step,index)=><li key={index}>{step}</li>)}</ol></>}
      {advice.suggestedText&&<div className="knowledge-review-suggestion"><header><h4>可选补充内容</h4><button type="button" className="knowledge-review-text-action" onClick={()=>void copy(advice.suggestedText!)}>复制内容</button></header><div className="knowledge-review-suggestion-body"><Document content={advice.suggestedText} onError={error=>setState(old=>old.identity===identity?{...old,error:errorText(error)}:old)}/></div></div>}
      {!!advice.questions?.length&&<><h4>核实前请确认</h4><ul>{advice.questions.map((question,index)=><li key={index}>{question}</li>)}</ul></>}
      {!!advice.references?.length&&<div className="knowledge-review-advice-evidence"><h4>参考文档</h4>{advice.references.map((ref,index)=><blockquote key={`${ref.id}-${index}`}><button type="button" onClick={()=>onOpen(ref.id)}>{ref.title||ref.path||'打开参考文档'}</button><span>{sourceName(ref.workspace)}{ref.partial?' · 节选':''}</span><p>{ref.quote}</p></blockquote>)}</div>}
      {!!advice.limitations?.length&&<p className="knowledge-review-footnote">{advice.limitations.join(' ')}</p>}
      <p className="knowledge-review-footnote">{advice.cached?'已保存的建议':'刚生成的建议'} · {Number.isFinite(advice.generatedAt)?new Date(advice.generatedAt).toLocaleString('zh-CN'):''}</p>
    </div>}
    {!advice&&!checking&&!current?.loading&&!generating&&!current?.error&&current?.checked&&<p className="knowledge-review-footnote">结合这类问题、当前原文和可找到的相关文档，生成一份待你核对的处理意见。</p>}
    <p className="knowledge-review-advice-disclaimer">建议仅供核对，不代表事实已确认，也不会自动改动文档。</p>
  </section>;
}

function claimText(detail:string){
  const match=/^[^:\n]+:\s*([\s\S]+) \(workspace: [\s\S]*, reason: [\s\S]*, stale since: [\s\S]*\)$/.exec(detail);
  return match?.[1]||detail;
}

function ReviewPreview({id,title,active,revision,onOpen}:{id:string;title:string;active:boolean;revision:number;onOpen:(id:string)=>void}){
  const remote=useRemote<{content:string}>('snapshot',{id},active,revision),[mediaError,setMediaError]=useState('');
  const resolveImage=useCallback((src:string)=>api.knowledgeImage(id,src),[id]);
  let content=(remote.data?.content||'').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'').trim();
  const heading=/^#\s+([^\n]+)\r?\n?/.exec(content);
  if(heading&&normalize(heading[1])===normalize(title))content=content.slice(heading[0].length).trim();
  const clipped=content.length>3000;
  if(clipped){const cut=content.lastIndexOf('\n',3000);content=content.slice(0,cut>2000?cut:3000);}
  return <section className="knowledge-review-preview" aria-label="当前原文预览">
    <div className="knowledge-review-preview-heading"><h3>当前原文预览</h3><button type="button" className="knowledge-review-text-action" onClick={()=>onOpen(id)}>阅读全文<ArrowUpRight size={14}/></button></div>
    <RemoteState busy={remote.busy&&!remote.data} error={remote.error} onRetry={remote.refresh}>
      {content?<Document content={content} onError={e=>setMediaError(String(e))} resolveImage={resolveImage}/>:<p className="knowledge-review-footnote">当前文档暂无正文。</p>}
      {clipped&&<p className="knowledge-review-footnote">这里只展示开头片段，请打开原文核对完整内容。</p>}
      {mediaError&&<p className="knowledge-operation-error" role="alert">{mediaError} 可打开原文继续查看。</p>}
    </RemoteState>
  </section>;
}
