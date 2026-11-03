import { memo, useEffect, useState, type ReactNode } from 'react';
import { Brain, Check, ChevronRight, CircleAlert, Clock3, Code2, Square } from 'lucide-react';
import { Spinner } from '@cindy/components/ui/spinner';
import { answerContent, hasVisibleAnswer, phaseLabels, textContent, thinkingContent, toolSummary, type Message, type Run } from '../session-view';
import { Document, MessageContent, type DocumentMedia } from './Document';
import { CopyButton } from './CopyButton';
import {messageDomId} from '../conversation-timeline';
import { BrandAvatar } from './BrandVisuals';
import {SessionTaskCard} from './SessionTasks';
import {taskActive,type SessionTask} from '../session-tasks';

const duration = (ms: number) => {const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;};
function useClock(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {if (!active) return; setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id);}, [active]);
  return now;
}
export function RunActivity({run, waitingInput, onEvents}: {run: Run | null; waitingInput: boolean; onEvents: () => void}) {
  const now = useClock(!!run?.active);
  if (!run) return null;
  const label = waitingInput ? '等待你回复' : phaseLabels[run.phase] || 'OMP 正在运行';
  const silence = now - run.updatedAt;
  const waitingMs=(run.waitingMs||0)+(run.waitingSince?now-run.waitingSince:0);
  return <div id="run-status" data-outcome={run.outcome} className={`run-activity ${run.active ? 'working-status' : 'finished'} ${run.outcome === 'error' ? 'failed' : ''}`}>
    <div className="run-heading"><span className="run-label" role="status">{run.active ? <span className="run-mascot"><BrandAvatar kind="cat" size={22}/><Spinner size={12}/></span> : run.outcome === 'completed' ? <Check size={14}/> : run.outcome === 'aborted' ? <Square size={12}/> : <CircleAlert size={14}/>} {label}</span><time>{duration((run.endedAt || now) - run.startedAt)}</time><button type="button" onClick={onEvents}>查看事件</button></div>
    {waitingMs>1000&&<div className="run-detail">总历时中，等待你确认 {duration(waitingMs)}</div>}
    {run.active && run.detail && <div className="run-detail" title={run.detail}>{run.detail}</div>}
    {run.active && !waitingInput && silence >= 20000 && <div className="run-hint">{Math.floor(silence / 1000)} 秒未收到新输出。可继续等待，或停止后重试。</div>}
  </div>;
}
type RenderProps = DocumentMedia & {jumpTarget?:string;onError: (e: unknown) => void; onImage: (url: string) => void;tasks?:SessionTask[];onExpandTask?:(key:string)=>void;onCancelTask?:(key:string)=>void};
const ToolRow = memo(function ToolRow({message, onError, onImage,resolveImage,onNavigate,jumpTarget,tasks,onExpandTask,onCancelTask}: RenderProps & {message: Message}) {
  const [open, setOpen] = useState(false), active = message.status === '执行中';
  const now=useClock(active||!!tasks?.some(t=>taskActive(t)&&t.parentToolCallId===message.id));
  if(message.title==='bash'&&(active||open))return <div id={messageDomId(message.id)} className="session-task" data-status={active?'running':message.status==='失败'?'failed':'completed'}><header><button className="session-task-title" aria-expanded={open} onClick={()=>setOpen(v=>!v)}><Code2 size={15}/><span>{message.intent||'Bash 命令'}</span><ChevronRight size={13} className={open?'expanded':''}/></button></header><pre className="session-task-command">{message.args?.command||message.args?.cmd||''}</pre>{message.content&&<div className="session-task-output"><pre tabIndex={0} aria-label="Bash 输出">{textContent(message.content).slice(-65536)||'等待工具输出…'}</pre></div>}<footer><span className="session-task-state"><i/>{message.status}</span>{message.startedAt&&<time>{duration((message.endedAt||now)-message.startedAt)}</time>}</footer></div>;
  return <div id={messageDomId(message.id)} className={`tool-row ${jumpTarget===message.id?'timeline-target':''} ${message.status === '失败' ? 'failed' : ''}`}>
    <button className="activity-row" type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      {active ? <Spinner size={13}/> : message.status === '失败' ? <CircleAlert size={13}/> : <Code2 size={13}/>}
      <span title={toolSummary(message)}>{toolSummary(message)}</span><small>{message.status || '历史记录'}{message.startedAt && message.endedAt ? ` · ${duration(message.endedAt - message.startedAt)}` : ''}</small><ChevronRight size={13} className={open ? 'expanded' : ''}/>
    </button>
    {open && <div className="activity-body"><span className="tool-name">{message.title}</span>{message.args && <details className="tool-arguments"><summary>调用参数</summary><pre>{JSON.stringify(message.args, null, 2)}</pre></details>}{message.content ? <MessageContent content={message.content} onError={onError} onImage={onImage} resolveImage={resolveImage} onNavigate={onNavigate}/> : <p className="muted">等待工具输出…</p>}</div>}
    {tasks?.filter(t=>taskActive(t)&&t.parentToolCallId===message.id).map(task=><SessionTaskCard key={task.key} task={task} now={now} onExpand={onExpandTask!} onCancel={onCancelTask!}/>)}
  </div>;
});
const ThinkingRow = memo(function ThinkingRow({message, onError, onImage, resolveImage, onNavigate}: RenderProps & {message: Message}) {
  const [open, setOpen] = useState(false), text = thinkingContent(message.content);
  if (!text) return null;
  return <div className="thinking-row"><button className="activity-row" type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}><Brain size={13}/><span>{message.thinkingActive ? '正在思考' : '思考过程'}</span><ChevronRight size={13} className={open ? 'expanded' : ''}/></button>{open && <div className="activity-body thinking-body"><Document content={text} onError={onError} onImage={onImage} resolveImage={resolveImage} onNavigate={onNavigate}/></div>}</div>;
});
function ActivityGroup({items, active, ...render}: RenderProps & {items: Message[]; active: boolean}) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const tools = items.filter(x => x.role === 'tool'), failures = tools.filter(x => x.status === '失败').length;
  const thinking = items.filter(x => x.role !== 'tool').length;
  const targeted=items.some(item=>item.id===render.jumpTarget);
  useEffect(()=>{if(targeted)setExpanded(true);},[targeted]);
  const open = targeted||expanded===true||(expanded===null&&active);
  return <section className="activity-group">
    <button className="activity-group-heading" type="button" aria-expanded={open} onClick={() => setExpanded(!open)}><ChevronRight size={14} className={open ? 'expanded' : ''}/><span>{active ? '处理过程' : '查看处理过程'}</span><small>{tools.length ? `${tools.length} 次工具调用` : `${thinking} 次思考`}{failures > 0 ? ` · ${failures} 次失败` : ''}</small></button>
    {open && <div className="activity-rows">{items.map(message => message.role === 'tool' ? <ToolRow key={message.id} message={message} {...render}/> : <ThinkingRow key={message.id} message={message} {...render}/>)}</div>}
  </section>;
}
const TextMessage = memo(function TextMessage({message, ...render}: RenderProps & {message: Message}) {
  // Capture at mount, never restart on a token update or animate restored history.
  const [enter]=useState(()=>!!message.optimistic||!!message.streaming);
  const content = message.role === 'assistant' ? answerContent(message.content) : message.content;
  return <article data-enter={enter} id={messageDomId(message.id)} className={`message ${message.role} ${render.jumpTarget===message.id?'timeline-target':''}`}><div className="message-author">{message.role === 'user' ? '你' : <><BrandAvatar size={24}/>OMP</>}{message.skill && <span className="skill-callout" title={message.skill.path}>技能 · {message.skill.name}</span>}{textContent(content) && <CopyButton label={message.role === 'user' ? '复制消息' : '复制回答'} text={() => textContent(content)} onError={render.onError}/>}</div><MessageContent content={content} streaming={!!message.streaming} {...render}/></article>;
});
export const SessionTranscript = memo(function SessionTranscript({messages, busy, ...render}: RenderProps & {messages: Message[]; busy: boolean}) {
  const nodes: ReactNode[] = []; let activities: Message[] = [];
  const lastUser = [...messages].reverse().find(x => x.role === 'user');
  const currentMessages = new Set(messages.slice(lastUser ? messages.indexOf(lastUser) + 1 : messages.length).map(x => x.id));
  const flush = () => {
    if (!activities.length) return;
    const items = activities; activities = [];
    nodes.push(<ActivityGroup key={`activity-${items[0].id}`} items={items} active={busy && items.some(m => currentMessages.has(m.id))||!!render.tasks?.some(t=>taskActive(t)&&items.some(m=>m.id===t.parentToolCallId))} {...render}/>);
  };
  for (const message of messages) {
    if (message.role === 'tool') {activities.push(message); continue;}
    if (message.role === 'assistant' && thinkingContent(message.content)) activities.push(message);
    const visible = hasVisibleAnswer(message);
    if (visible) {flush(); nodes.push(<TextMessage key={message.id} message={message} {...render}/>);}
  }
  flush(); return <>{nodes}</>;
});

