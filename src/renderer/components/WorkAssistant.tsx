import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {AlertCircle,BookOpen,Check,ChevronRight,Clock3,FileText,History,Pause,Play,RefreshCw,Sparkles,X} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {Spinner} from '@cindy/components/ui/spinner';
import {api} from '../api';
import type {Work} from '../types';
import type {WorkAssistantCitation,WorkAssistantItem,WorkAssistantOperation,WorkAssistantSnapshot} from '../work-assistant-types';
import type {WorkWorkflowAction,WorkWorkflowReminder,WorkWorkflowSnapshot} from '../work-workflow-types';
import '../work-assistant.css';

type Props={work:Work;active:boolean;onCommand:(command:string)=>void;onError:(error:unknown)=>void;draftTargetKey?:string};
const identityOf=(work:Work)=>`${work.hostId||'local'}\0${work.root}`;
const statusLabels={collecting:'收集会话',summarizing:'整理中',waiting_model:'等待辅助模型',error:'暂不可用'};
const sectionLabels=[['goals','当前目标'],['decisions','决定与方向'],['progress','进展记录'],['openQuestions','未决问题'],['nextSteps','建议下一步']] as const;
const sessionLabel=(item:WorkAssistantSnapshot['sessions'][number])=>item.title||item.sessionId;
const roleLabel=(role:WorkAssistantCitation['role'])=>role==='user'?'你':'OMP';
const citationKey=(citation:WorkAssistantCitation)=>`${citation.sessionId}\0${citation.messageId}`;
const displayTime=(value?:number)=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'时间未记录';
const reminderKinds:Record<WorkWorkflowReminder['kind'],string>={handover:'会话交接',record_update:'维护 SESSION.md',repeated_blocker:'重复阻塞',result_reuse:'复用工作成果'};
const reminderStates:Record<WorkWorkflowReminder['state'],string>={new:'新提醒',viewed:'已查看',done:'已完成',snoozed:'稍后提醒',dismissed:'已忽略'};

function WorkWorkflowReminders({work,active,draftTargetKey,onCommand,sessionById}:Pick<Props,'work'|'active'|'draftTargetKey'|'onCommand'>&{sessionById:ReadonlyMap<string,WorkAssistantSnapshot['sessions'][number]>}){
  const identity=identityOf(work),epoch=useRef({identity,value:0});
  if(epoch.current.identity!==identity)epoch.current={identity,value:epoch.current.value+1};
  const requestEpoch=epoch.current.value;
  const [snapshots,setSnapshots]=useState<Record<string,WorkWorkflowSnapshot>>({}),[busy,setBusy]=useState<Record<string,string>>({}),[errors,setErrors]=useState<Record<string,string>>({});
  const latest=useRef<Record<string,WorkWorkflowSnapshot>>({}),runs=useRef<Record<string,number>>({}),orders=useRef<Record<string,number>>({}),targetRef=useRef(draftTargetKey),commandRef=useRef(onCommand);
  targetRef.current=draftTargetKey;commandRef.current=onCommand;
  const snapshot=snapshots[identity],args={root:work.root,...(work.hostId?{hostId:work.hostId}:{})},currentBusy=busy[identity]||'';
  const begin=(key:string)=>{orders.current[key]=(orders.current[key]||0)+1;return orders.current[key];};
  const accept=(key:string,runEpoch:number,order:number,value:WorkWorkflowSnapshot)=>{
    if(epoch.current.identity!==key||epoch.current.value!==runEpoch||value.root!==work.root||(value.hostId||'')!==(work.hostId||'')||orders.current[key]!==order)return false;
    const prior=latest.current[key];
    if(prior){
      if(value.sourceRevision<prior.sourceRevision)return false;
      if(value.sourceRevision===prior.sourceRevision&&value.stateRevision<prior.stateRevision)return false;
      if(value.sourceRevision===prior.sourceRevision&&value.stateRevision===prior.stateRevision&&(value.updatedAt||0)<(prior.updatedAt||0))return false;
    }
    latest.current[key]=value;setSnapshots(previous=>({...previous,[key]:value}));setErrors(previous=>({...previous,[key]:''}));return true;
  };
  const refreshAnalysis=async()=>{
    const key=identity;if(!api.workWorkflow||runs.current[key])return;
    const runEpoch=requestEpoch,run=(runs.current[key]||0)+1;runs.current[key]=run;const order=begin(key);
    setBusy(previous=>({...previous,[key]:'refresh'}));setErrors(previous=>({...previous,[key]:''}));
    try{const result=await api.workWorkflow('refresh',args);accept(key,runEpoch,order,result.snapshot);}
    catch(error){if(epoch.current.identity===key&&epoch.current.value===runEpoch)setErrors(previous=>({...previous,[key]:error instanceof Error?error.message:String(error)}));}
    finally{if(runs.current[key]===run){delete runs.current[key];setBusy(previous=>({...previous,[key]:''}));}}
  };
  useEffect(()=>{
    if(!active||!api.workWorkflow)return;
    const key=identity,runEpoch=requestEpoch;let live=true,inflight=false;
    const receive=(value:WorkWorkflowSnapshot)=>{if(live&&value.root===work.root&&(value.hostId||'')===(work.hostId||''))accept(key,runEpoch,begin(key),value);};
    const unsubscribe=api.onWorkWorkflow?.(receive);
    const refresh=()=>{if(inflight||runs.current[key]||document.visibilityState!=='visible')return;inflight=true;const order=begin(key);void api.workWorkflow!('status',args).then(result=>{if(live)accept(key,runEpoch,order,result.snapshot);}).catch(error=>{if(live&&orders.current[key]===order)setErrors(previous=>({...previous,[key]:error instanceof Error?error.message:String(error)}));}).finally(()=>{inflight=false;});};
    refresh();const timer=window.setInterval(refresh,15000);
    return()=>{live=false;clearInterval(timer);unsubscribe?.();};
  },[active,identity,requestEpoch,work.root,work.hostId]);
  const perform=async(reminder:WorkWorkflowReminder,action:WorkWorkflowAction)=>{
    const key=identity;if(!snapshot||!api.workWorkflow||reminder.stale||!reminder.active||runs.current[key])return;
    const runEpoch=requestEpoch,requestedTarget=draftTargetKey,context=snapshot.contextFingerprint,source=snapshot.sourceRevision;
    const run=(runs.current[key]||0)+1;runs.current[key]=run;const order=begin(key);setBusy(previous=>({...previous,[key]:reminder.id}));setErrors(previous=>({...previous,[key]:''}));
    try{
      const result=await api.workWorkflow('action',{...args,id:reminder.id,revision:snapshot.stateRevision,action});
      const sameWork=epoch.current.identity===key&&epoch.current.value===runEpoch&&result.snapshot.root===work.root&&(result.snapshot.hostId||'')===(work.hostId||'');
      if(!sameWork)return;
      accept(key,runEpoch,order,result.snapshot);
      if(action==='draft'){
        const updated=result.snapshot.reminders.find(item=>item.id===reminder.id);
        const latestSnapshot=latest.current[key],latestReminder=latestSnapshot?.reminders.find(item=>item.id===reminder.id);
        if(!result.draftText||result.snapshot.contextFingerprint!==context||latestSnapshot?.contextFingerprint!==context||source!==result.snapshot.sourceRevision||latestSnapshot?.sourceRevision!==result.snapshot.sourceRevision||!updated||updated.stale||!updated.active||!latestReminder||latestReminder.stale||!latestReminder.active){
          setErrors(previous=>({...previous,[key]:'这条提醒的对话或 SESSION.md 已更新，已阻止把过期内容加入草稿。请刷新提醒后重试。'}));return;
        }
        if(targetRef.current!==requestedTarget||!requestedTarget){
          setErrors(previous=>({...previous,[key]:'当前 OMP 会话已切换，提醒没有加入其他会话的草稿。请在目标会话中重新操作。'}));return;
        }
        commandRef.current(result.draftText);
      }
    }catch(error){if(epoch.current.identity===key&&epoch.current.value===runEpoch)setErrors(previous=>({...previous,[key]:error instanceof Error?error.message:String(error)}));}
    finally{if(runs.current[key]===run){delete runs.current[key];setBusy(previous=>({...previous,[key]:''}));}}
  };
  const visible=snapshot?.reminders.filter(item=>item.active&&['new','viewed'].includes(item.state))||[];
  const staleCount=visible.filter(item=>item.stale).length;
  const hasConversationSources=!!snapshot&&snapshot.sourceRevision>0&&(snapshot.coverage?.visibleMessages||0)>0;
  const succeededForCurrentSource=!!snapshot&&snapshot.lastSuccessAt>0&&snapshot.currentAnalysis===true;
  const awaitingCurrentSource=hasConversationSources&&!succeededForCurrentSource&&snapshot.status!=='analyzing'&&snapshot.status!=='error';
  const analyzeLabel=snapshot?.lastAttemptAt?'重新分析':'开始分析';
  if(!api.workWorkflow)return <div className="work-workflow-state">此客户端尚未接入 Work 流程提醒。</div>;
  return <section className="work-workflow" aria-label="Work 流程提醒">
    <header className="work-workflow-heading"><div><h4>工作流程提醒</h4><p>根据跨会话对话与 SESSION.md 提示可复用的工作做法。</p></div><Button compact variant="secondary" disabled={!!currentBusy||!hasConversationSources} onClick={()=>void refreshAnalysis()}><RefreshCw size={13}/>{currentBusy==='refresh'?'正在分析…':analyzeLabel}</Button></header>
    {!snapshot&&active&&<p className="work-workflow-state"><Spinner size={13}/>正在读取流程提醒…</p>}
    {snapshot?.status==='analyzing'&&<p className="work-workflow-state"><Spinner size={13}/>正在整理跨会话流程线索…</p>}
    {snapshot?.status==='error'&&<p className="work-workflow-warning" role="alert">{snapshot.error||'流程提醒暂不可用，请修复设置或连接后重新分析。'}</p>}
    {!snapshot?.recordAvailable&&snapshot&&<p className="work-workflow-warning">当前未能读取 SESSION.md；本次提醒没有使用其中的流程记录。{snapshot.recordWarning?` ${snapshot.recordWarning}`:''}</p>}
    {snapshot?.recordWarning&&snapshot.recordAvailable&&<p className="work-workflow-warning">SESSION.md 读取提示：{snapshot.recordWarning}</p>}
    {staleCount>0&&<p className="work-workflow-warning" role="status">对话或 SESSION.md 已变化，{staleCount} 条提醒暂不可操作。重新分析后再使用。</p>}
    {errors[identity]&&<p className="work-workflow-warning" role="alert">{errors[identity]}</p>}
    {snapshot&&!errors[identity]&&visible.length===0&&snapshot.status!=='analyzing'&&snapshot.status!=='error'&&(
      !hasConversationSources
        ?<p className="work-workflow-empty" role="status">还没有可分析的跨会话对话。</p>
        :succeededForCurrentSource
          ?<p className="work-workflow-empty" role="status">已检查当前对话，暂未发现需要处理的流程提醒。</p>
          :<p className="work-workflow-empty is-unchecked" role="status">{awaitingCurrentSource?'当前 Work 资料尚未完成分析。':'这些对话尚未分析。'}分析完成后会显示检查结果；也可点击“{analyzeLabel}”立即运行。</p>
    )}
    {visible.map(reminder=><article className={`work-workflow-reminder${reminder.stale?' is-stale':''}`} key={reminder.id}>
      <div className="work-workflow-reminder-heading"><span className="work-workflow-kind">{reminderKinds[reminder.kind]||'工作流程'}</span><span className="work-workflow-state-label">{reminder.stale?'资料已变化':reminderStates[reminder.state]}</span></div>
      <h5>{reminder.title}</h5><p className="work-workflow-reason">{reminder.reason}</p>
      {!!reminder.sources.length&&<details className="work-workflow-sources"><summary><ChevronRight size={13}/>依据 · {reminder.sources.length}</summary>{reminder.sources.map((source,index)=>{const session=source.type==='conversation'?sessionById.get(source.sessionId):undefined;return <blockquote key={`${source.type}-${index}`}><strong title={source.type==='conversation'?source.sessionId:undefined}>{source.type==='record'?'SESSION.md':`${session?.title||'会话来源'} · ${source.role==='user'?'用户':'OMP'}`}</strong><span>{source.quote}</span></blockquote>;})}</details>}
      {reminder.snoozedUntil&&<p className="work-workflow-meta">稍后提醒于 {displayTime(reminder.snoozedUntil)}</p>}
      <div className="work-workflow-actions">
        <Button compact variant="secondary" disabled={!!currentBusy||reminder.stale} onClick={()=>void perform(reminder,'draft')}><FileText size={13}/>加入草稿</Button>
        {reminder.state==='new'&&<Button compact variant="secondary" tone="quiet" disabled={!!currentBusy||reminder.stale} onClick={()=>void perform(reminder,'view')}><BookOpen size={13}/>标记已查看</Button>}
        <Button compact variant="secondary" tone="quiet" disabled={!!currentBusy||reminder.stale} onClick={()=>void perform(reminder,'done')}><Check size={13}/>完成</Button>
        <Button compact variant="secondary" tone="quiet" disabled={!!currentBusy||reminder.stale} onClick={()=>void perform(reminder,'snooze')}><Clock3 size={13}/>稍后</Button>
        <Button compact variant="secondary" tone="quiet" disabled={!!currentBusy||reminder.stale} onClick={()=>void perform(reminder,'dismiss')} aria-label={`忽略提醒：${reminder.title}`}><X size={13}/>忽略</Button>
      </div>
      {currentBusy===reminder.id&&<p className="work-workflow-state"><Spinner size={12}/>正在更新提醒…</p>}
    </article>)}
    {snapshot&&<p className="work-workflow-meta" aria-label="流程提醒分析记录">
      {snapshot.lastAttemptAt>0?<span>最近尝试 {displayTime(snapshot.lastAttemptAt)}</span>:<span>尚未开始分析</span>}
      {succeededForCurrentSource?<span>最近成功 {displayTime(snapshot.lastSuccessAt)}</span>:snapshot.lastSuccessAt>0?<span>最近成功 {displayTime(snapshot.lastSuccessAt)} · 当前 Work 资料待分析</span>:<span>尚无成功分析记录</span>}
      {typeof snapshot.coverage?.visibleMessages==='number'&&<span>参考 {snapshot.coverage.visibleMessages} 条对话</span>}
    </p>}
  </section>;
}

function continuePrompt(snapshot:WorkAssistantSnapshot,work:Work){
  const summary=snapshot.summary;
  if(!summary)return '';
  const lines=[`继续 Work「${work.name.slice(0,120)}」的当前工作。`,''];
  let used=lines.join('\n').length,omitted=false;
  const addBlock=(block:string[])=>{const size=block.join('\n').length+1;if(used+size>7800){omitted=true;return false;}lines.push(...block);used+=size;return true;};
  if(summary.overview.text)addBlock(['## 工作概况',summary.overview.text,'']);
  const unique=new Map<string,WorkAssistantCitation>();
  const all=[summary.overview,...sectionLabels.flatMap(([key])=>summary[key])];
  for(const item of all)for(const citation of item.sources||[]){
    const key=citationKey(citation);if(!unique.has(key))unique.set(key,citation);
  }
  if(unique.size>5)omitted=true;
  if(unique.size){
    const block=['## 对话出处'];
    for(const citation of [...unique.values()].slice(0,5)){
      const session=snapshot.sessions.find(item=>item.sessionId===citation.sessionId);
      if(citation.quote.length>220)omitted=true;
      block.push(`- ${(session?sessionLabel(session):citation.sessionId).slice(0,100)} · ${roleLabel(citation.role)} · ${citation.quote.slice(0,220)}`);
    }
    addBlock([...block,'']);
  }
  let stopped=false;
  for(const [key,label] of sectionLabels){
    const items=summary[key];if(!items.length)continue;
    if(items.length>2||items.some(item=>item.text.length>360))omitted=true;
    const block=[`## ${label}`,...items.slice(0,2).map(item=>`- ${item.text.slice(0,360)}`),''];
    if(!addBlock(block)){stopped=true;break;}
  }
  if(stopped)omitted=true;
  if(omitted)lines.push('部分条目或出处因草稿长度限制未加入；请在 Work 助手查看完整摘要与来源。');
  return lines.join('\n');
}

export function WorkAssistant({work,active,onCommand,onError,draftTargetKey}:Props){
  const identity=identityOf(work),lifecycle=useRef({identity,epoch:0});
  if(lifecycle.current.identity!==identity)lifecycle.current={identity,epoch:lifecycle.current.epoch+1};
  const epoch=lifecycle.current.epoch;
  const [snapshots,setSnapshots]=useState<Record<string,WorkAssistantSnapshot>>({});
  const [actionKeys,setActionKeys]=useState<Record<string,string>>({});
  const [actionErrors,setActionErrors]=useState<Record<string,string>>({});
  const [expandedSources,setExpandedSources]=useState<Record<string,boolean>>({});
  const generations=useRef(0),actionRuns=useRef<Record<string,number>>({}),updateOrder=useRef<Record<string,number>>({}),snapshotCache=useRef<Record<string,WorkAssistantSnapshot>>({});
  const snapshot=snapshots[identity],action=actionKeys[identity],actionError=actionErrors[identity];
  const sessionById=useMemo(()=>new Map((snapshot?.sessions||[]).map(item=>[item.sessionId,item])),[snapshot?.sessions]);
  const sourceById=useMemo(()=>new Map((snapshot?.sources||[]).map(item=>[citationKey(item),item])),[snapshot?.sources]);
  const args={root:work.root,...(work.hostId?{hostId:work.hostId}:{})};

  const beginUpdate=useCallback((key:string)=>{const next=(updateOrder.current[key]||0)+1;updateOrder.current[key]=next;return next;},[]);
  const accept=useCallback((key:string,requestEpoch:number,order:number,result:WorkAssistantSnapshot)=>{
    if(lifecycle.current.identity!==key||lifecycle.current.epoch!==requestEpoch||result.root!==work.root||(result.hostId||'')!==(work.hostId||''))return;
    if(updateOrder.current[key]!==order)return;
    const prior=snapshotCache.current[key];
    if(prior){
      const priorSource=prior.sourceRevision??prior.coverage.sourceRevision??0,nextSource=result.sourceRevision??result.coverage.sourceRevision??0;
      const priorSummary=prior.summaryRevision??prior.coverage.summaryRevision??0,nextSummary=result.summaryRevision??result.coverage.summaryRevision??0;
      if(nextSource<priorSource||nextSource===priorSource&&nextSummary<priorSummary)return;
      if(nextSource===priorSource&&nextSummary===priorSummary&&(result.updatedAt||0)<(prior.updatedAt||0))return;
    }
    snapshotCache.current[key]=result;
    setSnapshots(previous=>({...previous,[key]:result}));setActionErrors(previous=>({...previous,[key]:''}));
  },[work.root,work.hostId]);

  const perform=useCallback(async(operation:WorkAssistantOperation,extra:{enabled?:boolean}={})=>{
    const key=identity,requestEpoch=epoch;
    if(lifecycle.current.identity!==key||lifecycle.current.epoch!==requestEpoch||!api.workAssistant)return;
    const run=(actionRuns.current[key]||0)+1;actionRuns.current[key]=run;const order=beginUpdate(key);
    setActionKeys(previous=>({...previous,[key]:operation}));setActionErrors(previous=>({...previous,[key]:''}));
    try{accept(key,requestEpoch,order,await api.workAssistant(operation,{...args,...extra}));}
    catch(error){
      if(lifecycle.current.identity===key&&lifecycle.current.epoch===requestEpoch&&updateOrder.current[key]===order){
        setActionErrors(previous=>({...previous,[key]:error instanceof Error?error.message:String(error)}));
        onError(error);
      }
    }finally{
      if(actionRuns.current[key]===run){delete actionRuns.current[key];setActionKeys(previous=>({...previous,[key]:''}));}
    }
  },[identity,epoch,work.root,work.hostId,onError,accept,beginUpdate]);

  useEffect(()=>{
    if(!active)return;
    const key=identity,requestEpoch=epoch,requestGeneration=++generations.current;
    let live=true;
    const receive=(value:WorkAssistantSnapshot)=>{if(live&&generations.current===requestGeneration&&value.root===work.root&&(value.hostId||'')===(work.hostId||''))accept(key,requestEpoch,beginUpdate(key),value);};
    if(!api.workAssistant){setActionErrors(previous=>({...previous,[key]:'当前客户端尚未接入 Work 助手服务。'}));return()=>{live=false;};}
    const refresh=()=>{
      if(actionRuns.current[key])return;
      const order=beginUpdate(key);
      void api.workAssistant!('status',args).then(value=>{if(live&&generations.current===requestGeneration)accept(key,requestEpoch,order,value);}).catch(error=>{
        if(live&&lifecycle.current.identity===key&&lifecycle.current.epoch===requestEpoch&&updateOrder.current[key]===order)setActionErrors(previous=>({...previous,[key]:error instanceof Error?error.message:String(error)}));
      });
    };
    const unsubscribe=api.onWorkAssistant?.(receive);
    refresh();
    const timer=window.setInterval(()=>{if(document.visibilityState==='visible')refresh();},5000);
    return()=>{live=false;generations.current++;clearInterval(timer);unsubscribe?.();};
  },[active,identity,epoch,work.root,work.hostId,accept,beginUpdate]);

  const renderCitation=(citation:WorkAssistantCitation,index:number)=>{
    const key=citationKey(citation),source=sourceById.get(key),session=sessionById.get(citation.sessionId);
    const opened=expandedSources[key]===true;
    return <details key={key+index} className="work-assistant-citation" open={opened} onToggle={event=>{const isOpen=(event.currentTarget as HTMLDetailsElement).open;setExpandedSources(previous=>({...previous,[key]:isOpen}));}}>
      <summary>{session?sessionLabel(session):'会话来源'} · {roleLabel(citation.role)} · {source?.at?displayTime(source.at):'查看摘录'}</summary>
      <blockquote>{source?.text||citation.quote||'此条摘要暂未提供原文摘录。'}</blockquote>
      {source&&citation.quote&&source.text!==citation.quote&&<p className="work-assistant-quote"><strong>本条引用</strong>{citation.quote}</p>}
    </details>;
  };

  const renderItems=(items:WorkAssistantItem[])=>items.map((item,index)=><article className="work-assistant-item" key={`${item.text}-${index}`}>
    <p>{item.text}</p>
    {!!item.sources.length&&<div className="work-assistant-citations" aria-label="对话出处">{item.sources.slice(0,4).map(renderCitation)}{item.sources.length>4&&<span className="wd-caption">另有 {item.sources.length-4} 条出处</span>}</div>}
  </article>);

  const current=snapshot?continuePrompt(snapshot,work):'';
  const historyCoverage=snapshot?.historyCoverage;
  const busy=!!action;
  const status=snapshot?.status||'collecting';
  const sourceRevision=snapshot?.sourceRevision??snapshot?.coverage.sourceRevision;
  const summaryRevision=snapshot?.summaryRevision??snapshot?.coverage.summaryRevision;
  const summaryStale=!!snapshot?.summary&&sourceRevision!==undefined&&summaryRevision!==undefined&&sourceRevision!==summaryRevision;
  const statusLabel=snapshot?.status==='error'?statusLabels.error:snapshot?.status==='collecting'||snapshot?.status==='summarizing'||snapshot?.status==='waiting_model'?statusLabels[snapshot.status]:summaryStale?'摘要待更新':snapshot?.summary?'已更新':snapshot?.coverage.sessions?'待整理':'等待资料';

  return <section className="work-assistant" aria-label="Work 助手">
    <div className="work-assistant-heading">
      <div><h3>Work 协作摘要</h3><p className="wd-caption">汇总此 Work 的多会话目标、决定与未决问题。每条结论都可展开查看原话。</p></div>
      {snapshot&&<span className={`work-assistant-status is-${status}`} role="status">{['collecting','summarizing'].includes(status)&&<Spinner size={12}/>} {statusLabel}</span>}
    </div>
    {!snapshot&&active&&<div className="work-assistant-state"><Spinner size={14}/>正在读取此 Work 的协作状态…</div>}
    {actionError&&<div className="work-assistant-error" role="alert"><AlertCircle size={15}/><span>{actionError}</span><Button compact variant="secondary" disabled={busy} onClick={()=>void perform('status')}>重试</Button></div>}
    {!api.workAssistant&&<div className="work-assistant-state">此客户端还没有加载 Work 助手能力，请重新打开 Lucyna。</div>}
    <WorkWorkflowReminders work={work} active={active} draftTargetKey={draftTargetKey} onCommand={onCommand} sessionById={sessionById}/>
    {snapshot&&<>
      <div className="work-assistant-controls">
        <Button compact variant="secondary" disabled={busy||!snapshot.enabled||!snapshot.coverage.sessions} onClick={()=>void perform('refresh')}><RefreshCw size={13}/>{action==='refresh'?'正在整理…':'更新摘要'}</Button>
        <Button compact variant="secondary" disabled={busy} onClick={()=>void perform('configure',{enabled:!snapshot.enabled})}>
          {snapshot.enabled?<Pause size={13}/>:<Play size={13}/>} {snapshot.enabled?'暂停自动整理':'恢复自动整理'}
        </Button>
        {!work.hostId&&<Button compact variant="secondary" disabled={busy} onClick={()=>void perform('history')}><History size={13}/>{action==='history'?'正在补齐…':'补齐本机历史'}</Button>}
      </div>
      {work.hostId&&<p className="work-assistant-notice">远端摘要目前纳入已接入的会话事件与已加载消息；远端历史补齐暂未接入。</p>}
      {!snapshot.enabled&&!!snapshot.coverage.sessions&&<p className="work-assistant-notice">自动整理已暂停；恢复后可整理新增会话并更新摘要。</p>}
      {snapshot.status==='waiting_model'&&<p className="work-assistant-notice"><Sparkles size={14}/>{snapshot.error||'配置辅助模型后，Work 助手会继续整理已加载的会话。'}</p>}
      {snapshot.status==='error'&&snapshot.error&&<p className="work-assistant-warning" role="alert">{snapshot.error}</p>}
      {summaryStale&&<p className="work-assistant-warning" role="status">新会话内容已纳入资料，但还没有进入当前摘要。下面仍是上一版摘要；更新完成前，不能把旧摘要加入继续工作草稿。</p>}
      {historyCoverage&&<div className="work-assistant-coverage">
        <span><strong>{snapshot.coverage.sessions}</strong> 条会话已纳入资料</span>
        <span><strong>{snapshot.coverage.visibleMessages}</strong> / {snapshot.coverage.totalMessages} 条对话已载入</span>
        {!work.hostId&&<span><strong>{historyCoverage.loaded} / {historyCoverage.available}</strong> 条本机历史已读取</span>}
        {!work.hostId&&<span className="wd-caption">{(historyCoverage.checkedAt||0)>0?`覆盖范围检查于 ${displayTime(historyCoverage.checkedAt)}`:'本机历史尚未检查'}</span>}
        {!!snapshot.coverage.contextMessages&&<span><strong>{snapshot.coverage.contextMessages}</strong> 条消息进入本次摘要上下文</span>}
        {!!snapshot.coverage.omittedMessages&&<span><strong>{snapshot.coverage.omittedMessages}</strong> 条消息因容量限制未进入上下文</span>}
      </div>}
      {snapshot.coverage.truncated&&<p className="work-assistant-warning">部分会话较长或历史记录被裁剪，摘要覆盖范围有限。可补齐本机历史，或直接在 OMP 打开目标会话。</p>}
      {historyCoverage?.limited&&<p className="work-assistant-warning">本机历史扫描已达到范围限制；结果不代表完整历史。</p>}
      {!!historyCoverage?.skipped&&<p className="work-assistant-warning">{historyCoverage.skipped} 条本机历史未能读取，摘要不会引用这些记录。</p>}
      {!!historyCoverage?.warnings.length&&<details className="work-assistant-coverage-details"><summary>历史来源说明 · {historyCoverage.warnings.length}</summary>{historyCoverage.warnings.map((note,index)=><p key={index}>{note}</p>)}</details>}
      {snapshot.summary?.overview?.text?<>
        <section className="work-assistant-overview"><h4>{summaryStale?'上次工作概况':'当前工作概况'}</h4><p>{snapshot.summary.overview.text}</p>
          {!!snapshot.summary.overview.sources.length&&<div className="work-assistant-citations">{snapshot.summary.overview.sources.slice(0,6).map(renderCitation)}</div>}
        </section>
        {sectionLabels.map(([key,label])=>{const items=snapshot.summary?.[key]||[];return items.length?<section className="work-assistant-group" key={key}><h4>{label}<span>{items.length}</span></h4>{renderItems(items)}</section>:null;})}
        <div className="work-assistant-continue"><Button variant="cta" compact disabled={!current||busy||summaryStale} onClick={()=>onCommand(current)}><BookOpen size={14}/>继续当前工作到草稿</Button><p className="wd-caption">只加入当前 OMP 输入框草稿，不会自动发送。</p></div>
      </>:snapshot.coverage.sessions===0?<div className="work-assistant-empty"><Clock3 size={17}/><div><strong>还没有可整理的会话</strong><p>可以先打开本机历史会话，让 Work 助手将它们纳入这个 Work 的上下文。</p></div></div>:<div className="work-assistant-empty"><Clock3 size={17}/><div><strong>{snapshot.status==='error'?'摘要未生成':snapshot.enabled?'会话已收集，摘要尚未生成':'自动整理已暂停'}</strong><p>{snapshot.status==='error'?'请查看上方错误信息，修复设置或连接后重试。':snapshot.enabled?'更新摘要可立即整理当前 Work 的会话。':'恢复自动整理后，会从最新对话继续维护摘要。'}</p></div></div>}
      {snapshot.sessions.length>0&&<details className="work-assistant-sessions"><summary>已纳入资料的会话 · {snapshot.sessions.length}</summary>
        {snapshot.sessions.map(session=><div key={session.sessionId}><span>{sessionLabel(session)}</span><small>{session.messageCount} 条对话 · {displayTime(session.lastActivityAt)}</small></div>)}
      </details>}
      <p className="work-assistant-updated">
        {snapshot.updatedAt?<><Clock3 size={12}/> 上次成功整理 {displayTime(snapshot.updatedAt)}</>:snapshot.lastAttemptAt?<><Clock3 size={12}/> 最近尝试 {displayTime(snapshot.lastAttemptAt)} · 尚无成功摘要</>:<>尚未生成摘要</>}
        {(snapshot.lastAttemptAt||0)>0&&(snapshot.updatedAt||0)>0&&(snapshot.lastAttemptAt||0)>(snapshot.updatedAt||0)&&<> · 最近尝试 {displayTime(snapshot.lastAttemptAt||0)}</>}
        {snapshot.usedTokens>0&&<> · 已知用量 {snapshot.usedTokens.toLocaleString()} Token{snapshot.usageUnknown?'，起始请求用量不完整':''}</>}
      </p>
    </>}
  </section>;
}
