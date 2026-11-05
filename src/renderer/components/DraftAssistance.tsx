import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type RefObject} from 'react';
import {AlertCircle,BookOpen,Check,ChevronRight,Clock3,FileText,LoaderCircle,Sparkles,X} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {api} from '../api';
import {errorText} from '../errors';
import {Document} from './Document';
import {sensitiveDocument} from '../../work-knowledge-policy.cjs';
import type {WorkGuidanceAsset,WorkGuidanceCompletion,WorkGuidanceCoverage,WorkGuidanceMaterial,WorkGuidanceOperation,WorkGuidanceResponse,WorkGuidanceResult} from '../work-guidance-types';
import '../draft-assistance.css';

type Target={root:string;hostId?:string;workId:string;sessionKey:string};
type Props={
  target:Target;
  enabled:boolean;
  disabled:boolean;
  draft:string;
  setDraft:(value:string)=>void;
  inputRef:RefObject<HTMLTextAreaElement|null>;
  caret:number;
  selectionEnd:number;
  composing:boolean;
  commandMenuOpen:boolean;
  focused:boolean;
  typingSequence:number;
};
type RequestSnapshot=Target&{target:Target;identity:string;revision:number;draft:string;caret:number;requestId?:string;draftHash:string;sourceRevision:number;completions:WorkGuidanceCompletion[];assets:WorkGuidanceAsset[];coverage?:WorkGuidanceCoverage};
type ActiveRequest={target:Target;identity:string;revision:number;draft:string;caret:number;requestId?:string;completed?:boolean};
type WorkContext={identity:string;ready:boolean;enabled:boolean;hasSources:boolean;sourceRevision?:number;updatedAt?:number;sessionTitles:Record<string,string>};
type SuggestState={kind:'loading'|'complete'|'paused'|'waiting_model'|'stale'|'error';message?:string;request?:RequestSnapshot};
type MaterialState={kind:'loading'|'ready'|'error';request:RequestSnapshot;asset:WorkGuidanceAsset;material?:WorkGuidanceMaterial;message?:string;selectedText?:string};
type WorkGuidanceTransport={workGuidance?:(operation:WorkGuidanceOperation,args:Record<string,unknown>)=>Promise<WorkGuidanceResult>};
const MAX_DRAFT=6000,MAX_INSERT_EXCERPT=6000;
let revisionSequence=Math.floor(Date.now()*1000);
const nextRevision=()=>{revisionSequence=Number.isSafeInteger(revisionSequence+1)?revisionSequence+1:1;return revisionSequence;};
const identityOf=(target:Target)=>`${target.hostId||'local'}\0${target.root}\0${target.workId}\0${target.sessionKey}`;
const sha256Hex=async(text:string)=>{
  const value=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(value),byte=>byte.toString(16).padStart(2,'0')).join('');
};
const roleLabel=(role:string)=>role==='user'?'你':'OMP';
const assetOriginLabel=(origin:string)=>origin==='work-file'?'Work 文件':origin==='saved'?'已保存快照':origin;
const isMaterial=(value:WorkGuidanceResult):value is WorkGuidanceMaterial=>!!value&&typeof value==='object'&&'assetId'in value&&'content'in value;
const isResponse=(value:WorkGuidanceResult):value is WorkGuidanceResponse=>!!value&&typeof value==='object'&&'draftHash'in value&&'caret'in value&&'completions'in value;
const safeExcerpt=(value:string)=>{
  const text=value.trim();
  if(text.length<=MAX_INSERT_EXCERPT)return {text,truncated:false};
  let end=MAX_INSERT_EXCERPT;
  const last=text.charCodeAt(end-1),next=text.charCodeAt(end);
  if(last>=0xD800&&last<=0xDBFF&&next>=0xDC00&&next<=0xDFFF)end--;
  return {text:text.slice(0,end),truncated:true};
};

export function DraftAssistance({target,enabled,disabled,draft,setDraft,inputRef,caret,selectionEnd,composing,commandMenuOpen,focused,typingSequence}:Props){
  const identity=identityOf(target),transport=(api as unknown as WorkGuidanceTransport).workGuidance;
  const [contextState,setContextState]=useState<WorkContext>({identity:'',ready:false,enabled:false,hasSources:false,sessionTitles:{}});
  const workContext=contextState.identity===identity?contextState:{identity,ready:false,enabled:false,hasSources:false,sessionTitles:{}};
  const contextRef=useRef<WorkContext>(workContext);
  contextRef.current=workContext;
  const [retrySequence,setRetrySequence]=useState(0);
  const latest=useRef({target,identity,enabled,disabled,draft,caret,selectionEnd,composing,commandMenuOpen,focused,typingSequence,inputRef,workEnabled:workContext.enabled,workHasSources:workContext.hasSources,contextReady:workContext.ready});
  latest.current={target,identity,enabled,disabled,draft,caret,selectionEnd,composing,commandMenuOpen,focused,typingSequence,inputRef,workEnabled:workContext.enabled,workHasSources:workContext.hasSources,contextReady:workContext.ready};
  const sourceRevision=useRef<number|undefined>(undefined);
  const activeRequest=useRef<ActiveRequest|null>(null);
  const previewSequence=useRef(0);
  const lastContextIdentity=useRef(identity);
  if(lastContextIdentity.current!==identity){lastContextIdentity.current=identity;sourceRevision.current=undefined;}
  const lastAttempt=useRef('');
  const [suggestion,setSuggestion]=useState<SuggestState|null>(null);
  const [material,setMaterial]=useState<MaterialState|null>(null);
  const [ignored,setIgnored]=useState<Record<string,boolean>>({});
  const [ignoredAssets,setIgnoredAssets]=useState<Record<string,boolean>>({});
  const suggestionRef=useRef(suggestion);suggestionRef.current=suggestion;
  const previewRef=useRef<HTMLDivElement|null>(null);
  const previewBody=useRef<HTMLDivElement>(null);
  const targetMatches=useCallback((request:Pick<RequestSnapshot,'identity'|'target'|'draft'|'caret'>)=>{
    const current=latest.current,el=current.inputRef.current;
    if(current.identity!==request.identity||current.target.root!==request.target.root||(current.target.hostId||'')!==(request.target.hostId||'')||current.target.workId!==request.target.workId||current.target.sessionKey!==request.target.sessionKey)return false;
    if(!current.enabled||current.disabled||!current.contextReady||!current.workEnabled||!current.workHasSources||current.composing||current.commandMenuOpen||current.draft!==request.draft||current.caret!==request.caret||current.selectionEnd!==request.caret)return false;
    return !!el&&el.selectionStart===request.caret&&el.selectionEnd===request.caret;
  },[]);
  const cancelRequest=useCallback((request:ActiveRequest|null)=>{
    if(!request||!transport||request.completed)return;
    void transport('cancel',{root:request.target.root,...(request.target.hostId?{hostId:request.target.hostId}:{}),sessionKey:request.target.sessionKey,revision:request.revision,...(request.requestId?{requestId:request.requestId}:{})}).catch(()=>{});
  },[transport]);
  const sendFeedback=useCallback((request:RequestSnapshot,feedback:'accepted'|'edited'|'ignored'|'asset_used'|'asset_ignored',completionId?:string,assetId?:string)=>{
    if(!transport||!request.requestId)return;
    void transport('feedback',{root:request.root,...(request.hostId?{hostId:request.hostId}:{}),sessionKey:request.sessionKey,requestId:request.requestId,...(completionId?{completionId}:{}),...(assetId?{assetId}:{}),feedback}).catch(()=>{});
  },[transport]);

  useEffect(()=>{
    let live=true;
    const consume=(snapshot:import('../work-assistant-types').WorkAssistantSnapshot)=>{
      if(snapshot.root!==target.root||(snapshot.hostId||'')!==(target.hostId||''))return;
      const revision=Number.isSafeInteger(snapshot.sourceRevision)?snapshot.sourceRevision:undefined;
      const previous=contextRef.current;
      if(previous.identity===identity&&revision!==undefined&&previous.sourceRevision!==undefined&&revision<previous.sourceRevision)return;
      if(previous.identity===identity&&revision===previous.sourceRevision&&(snapshot.updatedAt||0)<(previous.updatedAt||0))return;
      const next={identity,ready:true,enabled:snapshot.enabled,hasSources:snapshot.coverage.visibleMessages>0,sourceRevision:revision??previous.sourceRevision,updatedAt:snapshot.updatedAt,sessionTitles:Object.fromEntries(snapshot.sessions.map(session=>[session.sessionId,session.title||session.sessionId]))};
      contextRef.current=next;
      if(revision!==undefined)sourceRevision.current=revision;
      setContextState(next);
      const active=activeRequest.current;
      const currentSuggestion=suggestionRef.current;
      if(active?.identity===identity&&currentSuggestion?.request&&revision!==undefined&&revision!==currentSuggestion.request.sourceRevision){
        cancelRequest(active);activeRequest.current=null;previewSequence.current++;setSuggestion({kind:'stale',message:'Work 资料已经更新，请继续输入以获取新建议。'});setMaterial(null);
      }
    };
    if(contextRef.current.identity!==identity){contextRef.current={identity,ready:false,enabled:false,hasSources:false,sessionTitles:{}};sourceRevision.current=undefined;}
    const unsubscribe=api.onWorkAssistant?.(consume);
    if(api.workAssistant){
      void api.workAssistant('status',{root:target.root,...(target.hostId?{hostId:target.hostId}:{})}).then(snapshot=>{if(live)consume(snapshot);}).catch(()=>{if(live)setContextState(previous=>previous.identity===identity?previous:{identity,ready:false,enabled:false,hasSources:false,sessionTitles:{}});});
    }
    return()=>{live=false;unsubscribe?.();};
  },[target.root,target.hostId,identity,cancelRequest]);

  useLayoutEffect(()=>{
    const request=activeRequest.current;
    if(request&&!targetMatches({identity:request.identity,target:request.target,draft:request.draft,caret:request.caret})){
      activeRequest.current=null;cancelRequest(request);previewSequence.current++;setSuggestion(null);setMaterial(null);
    }
  },[identity,draft,caret,selectionEnd,composing,commandMenuOpen,enabled,disabled,typingSequence,targetMatches,cancelRequest]);
  useEffect(()=>()=>{const request=activeRequest.current;if(request?.identity===identity){cancelRequest(request);activeRequest.current=null;}},[identity,cancelRequest]);
  useEffect(()=>{
    if(material?.kind!=='ready')return;
    const frame=requestAnimationFrame(()=>{
      previewRef.current?.scrollIntoView({block:'nearest',inline:'nearest'});
      previewBody.current?.scrollIntoView({block:'nearest',inline:'nearest'});
    });
    return()=>cancelAnimationFrame(frame);
  },[material?.kind,material?.asset.id]);

  const eligible=enabled&&!disabled&&workContext.ready&&workContext.enabled&&workContext.hasSources&&focused&&!composing&&!commandMenuOpen&&selectionEnd===caret&&draft.trim().length>0&&draft.length<=MAX_DRAFT&&!/^\s*\//.test(draft)&&!sensitiveDocument(draft);
  const privateReason=useMemo(()=>sensitiveDocument(draft),[draft]);
  useEffect(()=>{
    const attemptKey=`${identity}\0${typingSequence}\0${retrySequence}\0${workContext.sourceRevision??'pending'}\0${Number(workContext.ready)}\0${Number(workContext.enabled)}\0${Number(workContext.hasSources)}\0${Number(composing)}`;
    if(!eligible||!transport){
      const request=activeRequest.current;
      if(request&&request.identity===identity&&!request.completed){cancelRequest(request);activeRequest.current=null;}
      return;
    }
    if(lastAttempt.current===attemptKey)return;
    const timer=window.setTimeout(()=>{
      const current=latest.current;
      const currentSensitive=sensitiveDocument(current.draft);
      const el=current.inputRef.current;
      if(!current.enabled||current.disabled||!current.contextReady||!current.workEnabled||!current.workHasSources||!current.focused||current.composing||current.commandMenuOpen||current.selectionEnd!==current.caret||!current.draft.trim()||current.draft.length>MAX_DRAFT||/^\s*\//.test(current.draft)||currentSensitive||!el||el.selectionStart!==current.caret||el.selectionEnd!==current.caret)return;
      lastAttempt.current=attemptKey;
      const prior=activeRequest.current;if(prior)cancelRequest(prior);
      const revision=nextRevision(),targetSnapshot={...current.target};
      const request={identity:current.identity,target:targetSnapshot,revision,draft:current.draft,caret:current.caret};
      activeRequest.current={identity:current.identity,target:targetSnapshot,revision,draft:request.draft,caret:request.caret};
      previewSequence.current++;setSuggestion({kind:'loading'});setMaterial(null);setIgnored({});setIgnoredAssets({});
      void (async()=>{
        try{
          const response=await transport('suggest',{root:targetSnapshot.root,...(targetSnapshot.hostId?{hostId:targetSnapshot.hostId}:{}),sessionKey:targetSnapshot.sessionKey,revision,draft:request.draft,caret:request.caret});
          if(!targetMatches(request)||activeRequest.current?.revision!==revision||!isResponse(response))return;
          const hash=await sha256Hex(request.draft);
          if(!targetMatches(request)||activeRequest.current?.revision!==revision)return;
          if(response.root!==targetSnapshot.root||(response.hostId||'')!==(targetSnapshot.hostId||'')||response.sessionKey!==targetSnapshot.sessionKey||response.revision!==revision||response.caret!==request.caret||response.draftHash!==hash){
            activeRequest.current=null;setSuggestion({kind:'stale',message:'草稿或光标已变化，已丢弃这次建议。'});return;
          }
          if(sourceRevision.current!==undefined&&response.sourceRevision!==sourceRevision.current){activeRequest.current=null;setSuggestion({kind:'stale',message:'Work 资料已经更新，请继续输入以获取新建议。'});return;}
          sourceRevision.current=response.sourceRevision;
          const snapshot:RequestSnapshot={...targetSnapshot,...request,requestId:response.requestId,draftHash:response.draftHash,sourceRevision:response.sourceRevision,completions:response.completions||[],assets:response.assets||[],coverage:response.coverage};
          activeRequest.current={identity:snapshot.identity,target:snapshot.target,revision:snapshot.revision,draft:snapshot.draft,caret:snapshot.caret,requestId:snapshot.requestId,completed:true};
          setSuggestion({kind:response.status==='complete'?'complete':response.status==='paused'?'paused':response.status==='waiting_model'?'waiting_model':response.status==='stale'||response.status==='cancelled'?'stale':'error',message:response.error,request:snapshot});
        }catch(error){
          if(targetMatches(request)&&activeRequest.current?.revision===revision){activeRequest.current=null;setSuggestion({kind:'error',message:error instanceof Error?error.message:String(error)});}
        }
      })();
    },900);
    return()=>window.clearTimeout(timer);
  },[typingSequence,identity,eligible,transport,targetMatches,cancelRequest,retrySequence,workContext.sourceRevision]);

  const currentRequest=suggestion?.request&&targetMatches(suggestion.request)?suggestion.request:null;
  const displayedAssets=currentRequest?.assets.filter(asset=>!ignoredAssets[asset.id])||[];
  const currentMaterial=material&&currentRequest&&material.request.identity===identity&&material.request.draft===draft&&material.request.caret===caret&&material.request.sourceRevision===sourceRevision.current?material:null;
  const blockedVisible=focused&&!!draft.trim()&&!!(privateReason||draft.length>MAX_DRAFT||!transport||workContext.ready&&!workContext.hasSources||workContext.ready&&!workContext.enabled);
  const visible=focused||!!currentRequest||!!currentMaterial||blockedVisible;
  const insertText=useCallback((request:RequestSnapshot,text:string,feedback:()=>void)=>{
    if(!targetMatches(request)||!text.trim())return false;
    const el=inputRef.current;
    if(!el||el.selectionStart!==request.caret||el.selectionEnd!==request.caret)return false;
    setDraft(request.draft.slice(0,request.caret)+text+request.draft.slice(request.caret));
    feedback();
    requestAnimationFrame(()=>{const input=inputRef.current;if(input){const next=request.caret+text.length;input.focus();input.setSelectionRange(next,next);}});
    activeRequest.current=null;previewSequence.current++;setSuggestion(null);setMaterial(null);return true;
  },[targetMatches,inputRef,setDraft]);
  const acceptCompletion=(request:RequestSnapshot,completion:WorkGuidanceCompletion)=>{
    if(insertText(request,completion.text,()=>sendFeedback(request,'accepted',completion.id)))return;
    setSuggestion({kind:'stale',message:'草稿或光标已变化，请继续输入后重新获取建议。'});
  };
  const ignoreCompletion=(request:RequestSnapshot,completion:WorkGuidanceCompletion)=>{
    setIgnored(previous=>({...previous,[completion.id]:true}));sendFeedback(request,'ignored',completion.id);
  };
  const previewAsset=async(request:RequestSnapshot,asset:WorkGuidanceAsset)=>{
    if(!transport||!targetMatches(request))return;
    const previewId=++previewSequence.current;
    setMaterial({kind:'loading',request,asset});
    try{
      const result=await transport('material',{root:request.root,...(request.hostId?{hostId:request.hostId}:{}),sessionKey:request.sessionKey,requestId:request.requestId,assetId:asset.id});
      if(previewSequence.current!==previewId||!targetMatches(request)||!isMaterial(result)||result.root!==request.root||(result.hostId||'')!==(request.hostId||'')||result.sessionKey!==request.sessionKey||result.requestId!==request.requestId||result.assetId!==asset.id||(asset.version!==undefined&&result.version!==asset.version))return;
      setMaterial({kind:'ready',request,asset,material:result});
    }catch(error){
      if(previewSequence.current===previewId&&targetMatches(request))setMaterial({kind:'error',request,asset,message:error instanceof Error?error.message:String(error)});
    }
  };
  const readSelectedText=()=>{
    const selected=window.getSelection(),node=selected?.anchorNode,focusNode=selected?.focusNode;
    const text=selected&&node&&focusNode&&previewBody.current?.contains(node)&&previewBody.current.contains(focusNode)?selected.toString():'';
    setMaterial(previous=>previous?.kind==='ready'?{...previous,selectedText:text}:previous);
  };
  const insertAsset=(state:MaterialState,sourceOnly:boolean)=>{
    if(state.kind!=='ready'||!state.material||!targetMatches(state.request))return;
    const item=state.material,excerpt=sourceOnly?{text:'',truncated:false}:safeExcerpt(state.selectedText||'');
    if(!sourceOnly&&!excerpt.text)return;
    const note=excerpt.truncated?'\n（摘录仅加入前 6,000 个字符，原文可在资料来源中查看。）':item.truncated?'\n（资料快照预览已截短，未显示的内容未加入草稿。）':'';
    const label=`\n\n【${sourceOnly?'资料来源':'资料摘录'}｜${item.title}】`;
    const body=sourceOnly?'':`\n${excerpt.text}${note}`;
    const source=`\n\n来源：${item.origin} · ${item.path} · Work ${state.request.root}${state.request.hostId?` · 主机 ${state.request.hostId}`:''}${item.snapshotVersion?` · 快照 ${item.snapshotVersion}`:''}${item.sourceHash?` · SHA-256 ${item.sourceHash}`:''}`;
    const inserted=`${label}${body}${source}`;
    const ok=insertText(state.request,inserted,()=>sendFeedback(state.request,'asset_used',undefined,state.asset.id));
    if(!ok){setMaterial({kind:'error',request:state.request,asset:state.asset,message:'草稿或光标已变化，请返回输入框重新选择插入位置。'});return;}
  };
  const ignoreAsset=(request:RequestSnapshot,asset:WorkGuidanceAsset)=>{
    sendFeedback(request,'asset_ignored',undefined,asset.id);setIgnoredAssets(previous=>({...previous,[asset.id]:true}));previewSequence.current++;setMaterial(null);
  };

  if(!visible||(!suggestion&&!material&&!blockedVisible))return null;
  return <section className="draft-assistance" aria-label="Work 提示与资料建议" onMouseDown={event=>{if((event.target as HTMLElement).closest('button'))event.preventDefault();}}>
    <div className="draft-assistance-head">
      <span><Sparkles size={14}/> Work 建议</span>
      {suggestion?.kind==='loading'&&<span className="draft-assistance-progress" role="status"><LoaderCircle size={13} className="draft-assistance-spin"/>正在参考已整理的会话…</span>}
      {suggestion?.kind==='complete'&&suggestion.request&&<span className="draft-assistance-progress"><Clock3 size={12}/>参考当前 Work 对话</span>}
      <button type="button" aria-label="关闭 Work 建议" className="draft-assistance-close" onClick={()=>{if(activeRequest.current)cancelRequest(activeRequest.current);activeRequest.current=null;previewSequence.current++;setSuggestion(null);setMaterial(null);}}><X size={14}/></button>
    </div>
    {!transport&&<p className="draft-assistance-note">当前客户端尚未接入 Work 提示服务。</p>}
    {workContext.ready&&!workContext.hasSources&&<p className="draft-assistance-note">此 Work 还没有可引用的会话资料。先打开或导入会话，再获取提示。</p>}
    {workContext.ready&&!workContext.enabled&&workContext.hasSources&&<p className="draft-assistance-note">Work 助手已暂停，恢复后可继续获取提示。</p>}
    {privateReason&&<p className="draft-assistance-note"><AlertCircle size={14}/>草稿可能包含凭据，已跳过提示请求。</p>}
    {draft.length>MAX_DRAFT&&<p className="draft-assistance-note">草稿超过 6,000 字符，暂不生成提示。</p>}
    {suggestion?.kind==='paused'&&<p className="draft-assistance-note">Work 助手已暂停，恢复后可继续获取提示。</p>}
    {suggestion?.kind==='waiting_model'&&<p className="draft-assistance-note">尚未配置可用的辅助模型。{suggestion.message||'配置后即可生成提示。'}</p>}
    {suggestion?.kind==='stale'&&<p className="draft-assistance-note">{suggestion.message||'资料或草稿已变化，已丢弃旧建议。'}</p>}
    {suggestion?.kind==='error'&&<p className="draft-assistance-error" role="alert"><AlertCircle size={14}/>{suggestion.message||'Work 提示暂不可用。'}<Button compact variant="secondary" tone="quiet" onClick={()=>setRetrySequence(value=>value+1)}>重试</Button></p>}
    {suggestion?.kind==='complete'&&currentRequest&&<>
      {!currentRequest.completions.some(item=>!ignored[item.id])&&!displayedAssets.length&&<p className="draft-assistance-note">没有可用的提示或资料建议。继续输入可重新查询。</p>}
      {currentRequest.completions.filter(item=>!ignored[item.id]).map(item=><article className="draft-assistance-completion" key={item.id}>
        <div className="draft-assistance-copy"><p>{item.text}</p><span>{item.reason}{item.basis==='inferred'?' · 根据对话推断':' · 摘自对话'}</span></div>
        {!!item.sources.length&&<details className="draft-assistance-sources"><summary><ChevronRight size={13}/>对话出处 · {item.sources.length}</summary>{item.sources.map((source,index)=><blockquote key={`${source.sessionId}-${source.messageId}-${index}`}><strong title={source.sessionId}>{workContext.sessionTitles[source.sessionId]||'会话来源'} · {roleLabel(source.role)}</strong><span>{source.quote}</span></blockquote>)}</details>}
        <div className="draft-assistance-actions"><Button compact variant="secondary" onClick={()=>acceptCompletion(currentRequest,item)}><Check size={13}/>加入当前草稿</Button><Button compact variant="secondary" tone="quiet" onClick={()=>ignoreCompletion(currentRequest,item)}>忽略</Button></div>
      </article>)}
      {!!currentRequest.coverage?.assetsNotice&&<p className="draft-assistance-note">{currentRequest.coverage.assetsNotice}</p>}
      {currentRequest.coverage?.assetsAvailable===false&&!currentRequest.coverage.assetsNotice&&<p className="draft-assistance-note">当前未能读取此 Work 的资料目录，资料建议可能不完整。</p>}
      {!!displayedAssets.length&&<div className="draft-assistance-assets"><h4><BookOpen size={14}/>可复用资料</h4><p className="draft-assistance-note">按资料名称与 Work 上下文推荐；选择后才读取资料快照。</p>{displayedAssets.map(asset=><article className="draft-assistance-asset" key={asset.id}>
        <div><strong>{asset.title}</strong><p>{asset.reason}</p><small title={asset.path}>{asset.path}</small></div>
        <div className="draft-assistance-actions"><Button compact variant="secondary" disabled={material?.kind==='loading'} onClick={()=>void previewAsset(currentRequest,asset)}><FileText size={13}/>{material?.kind==='loading'&&material.asset.id===asset.id?'正在读取…':'预览资料'}</Button><Button compact variant="secondary" tone="quiet" onClick={()=>ignoreAsset(currentRequest,asset)}>忽略</Button></div>
      </article>)}</div>}
    </>}
    {material?.kind==='loading'&&<p className="draft-assistance-note" role="status"><LoaderCircle size={13} className="draft-assistance-spin"/>正在读取所选资料快照…</p>}
    {material?.kind==='error'&&<p className="draft-assistance-error" role="alert"><AlertCircle size={14}/>{material.message||'资料读取失败，请刷新建议后重试。'}</p>}
    {currentMaterial?.kind==='ready'&&currentMaterial.material&&<div className="draft-assistance-preview" ref={previewRef}>
      <div className="draft-assistance-preview-head"><div><strong>{currentMaterial.material.title}</strong><p title={currentMaterial.material.path}>{assetOriginLabel(currentMaterial.material.origin)} · {currentMaterial.material.path}{currentMaterial.material.snapshotVersion?` · 快照 ${currentMaterial.material.snapshotVersion}`:''}</p></div><button type="button" aria-label="关闭资料预览" onClick={()=>{previewSequence.current++;setMaterial(null);}}><X size={14}/></button></div>
      {currentMaterial.material.sourceHash&&<p className="draft-assistance-note" title={currentMaterial.material.sourceHash}>资料校验值：{currentMaterial.material.sourceHash.slice(0,12)}…（加入草稿时保留完整值）</p>}
      {currentMaterial.material.snapshot&&currentMaterial.material.content?<><p className="draft-assistance-select-hint">可在正文中选中一段，再加入草稿。</p>
        <div className="draft-assistance-preview-body" ref={previewBody} role="region" aria-label="资料正文" tabIndex={0} onMouseUp={readSelectedText} onKeyUp={readSelectedText}>
          {/\.(?:md|markdown|mdown)$/i.test(currentMaterial.material.path)
            ?<Document content={currentMaterial.material.content} onError={error=>setMaterial(previous=>previous&&previous.material===currentMaterial.material?{...previous,message:errorText(error)}:previous)}/>
            :<pre>{currentMaterial.material.content}</pre>}
        </div>
        {currentMaterial.message&&<p className="draft-assistance-error" role="alert">{currentMaterial.message}</p>}
        {currentMaterial.material.truncated&&<p className="draft-assistance-note">资料预览受长度限制；此处显示的正文已截短。</p>}</>:<p className="draft-assistance-note">此资料只提供来源引用，没有可预览的快照正文。</p>}
      <div className="draft-assistance-actions"><Button compact variant="secondary" disabled={!currentMaterial.selectedText?.trim()} onClick={()=>insertAsset(currentMaterial,false)}><Check size={13}/>加入所选片段</Button><Button compact variant="secondary" tone="quiet" onClick={()=>insertAsset(currentMaterial,true)}>仅加入来源</Button></div>
    </div>}
    {suggestion?.kind==='complete'&&currentRequest&&<p className="draft-assistance-footnote">只修改当前草稿；不会发送消息或启动 OMP。</p>}
  </section>;
}
