import {useEffect,useRef,useState} from 'react';
import {Bot,ChevronDown,ChevronRight,RefreshCw,Square,Terminal} from 'lucide-react';
import {taskActive,taskCounts,type SessionTask} from '../session-tasks';
import '../session-tasks.css';

const labels={running:'运行中',stopping:'正在停止',completed:'已完成',failed:'失败',aborted:'已停止',unknown:'状态待确认'};
const duration=(ms:number)=>{const s=Math.max(0,Math.floor(ms/1000));return s<60?`${s} 秒`:`${Math.floor(s/60)} 分 ${s%60} 秒`;};
export function SessionTaskCard({task,onExpand,onCancel,now}:{task:SessionTask;onExpand:(key:string)=>void;onCancel:(key:string)=>void;now:number}){
  const output=useRef<HTMLPreElement>(null),[follow,setFollow]=useState(true);
  useEffect(()=>{if(follow&&output.current)output.current.scrollTop=output.current.scrollHeight;},[task.output,task.history,task.expanded,follow]);
  const active=taskActive(task),text=task.expanded&&task.kind==='agent'?task.history||task.output:task.output;
  const end=task.endedAt??(active&&!task.stale?now:undefined);
  const elapsed=task.durationMs??(task.startedAt!==undefined&&end!==undefined?end-task.startedAt:undefined);
  return <article className="session-task" data-task={task.key} data-status={task.status}>
    <header><button className="session-task-title" aria-expanded={!!task.expanded} onClick={()=>onExpand(task.key)}>{task.expanded?<ChevronDown size={14}/>:<ChevronRight size={14}/ >}{task.kind==='agent'?<Bot size={16}/>:<Terminal size={16}/>}<span>{task.title}</span></button><span className="session-task-kind">{task.kind==='agent'?'子代理':task.kind==='daemon'?'后台服务':'后台任务'}</span></header>
    {task.detail&&<p className="session-task-detail">{task.detail}</p>}
    {task.command&&<pre className="session-task-command">{task.command}</pre>}
    {(text||task.expanded)&&<div className="session-task-output"><pre ref={output} tabIndex={0} aria-label={`${task.title}的输出`} onScroll={()=>{const el=output.current;if(el)setFollow(el.scrollHeight-el.scrollTop-el.clientHeight<32);}}>{text||'暂未收到输出'}</pre>{!follow&&<button onClick={()=>{setFollow(true);if(output.current)output.current.scrollTop=output.current.scrollHeight;}}>跟随最新输出</button>}</div>}
    <footer><span className="session-task-state"><i aria-hidden="true"/>{task.stale&&active?'连接中断或状态待核对':labels[task.status]||task.status}</span>{elapsed!==undefined&&<time>{duration(elapsed)}</time>}{task.exitCode!==undefined&&<span>退出码 {task.exitCode}</span>}{active&&<button className="session-task-stop" disabled={!task.cancellable||task.stale||task.status==='stopping'} onClick={()=>onCancel(task.key)} aria-label={`停止 ${task.title}`}><Square size={11}/>{task.status==='stopping'?'等待结束确认':'停止'}</button>}</footer>
    {task.expanded&&task.cwd&&<p className="session-task-path">{task.cwd}</p>}
    {task.error&&<p className="session-task-error" role="status">{task.error}</p>}
    {task.status==='stopping'&&<p className="session-task-detail">正在等待 OMP 确认退出；其他任务继续运行。</p>}
  </article>;
}
export function SessionTasksPanel({tasks,capability,error,onRefresh,onExpand,onCancel}:{tasks:SessionTask[];capability:string;error:string;onRefresh:()=>void;onExpand:(key:string)=>void;onCancel:(key:string)=>void}){
  const [now,setNow]=useState(Date.now),[history,setHistory]=useState(false);
  const active=tasks.filter(taskActive),done=tasks.filter(t=>!taskActive(t)),counts=taskCounts(tasks);
  useEffect(()=>{if(!active.length)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[active.length]);
  if(!tasks.length&&!error&&capability!=='unsupported')return null;
  return <section className="session-tasks" aria-label="子代理与后台任务"><div className="session-tasks-heading"><strong>子代理与后台任务</strong>{counts.running>0&&<span>{counts.running} 个运行中</span>}{counts.unknown>0&&<span>{counts.unknown} 个待核对</span>}<button onClick={onRefresh} aria-label="刷新任务状态"><RefreshCw size={13}/></button></div>
    {active.map(task=><SessionTaskCard key={task.key} task={task} now={now} onExpand={onExpand} onCancel={onCancel}/>)}
    {!!done.length&&<details open={history} onToggle={e=>setHistory(e.currentTarget.open)}><summary>已结束的任务 · {done.length}</summary>{history&&done.map(task=><SessionTaskCard key={task.key} task={task} now={now} onExpand={onExpand} onCancel={onCancel}/>)}</details>}
    {error&&<p className="session-task-error" role="status">任务状态更新失败：{error}</p>}
    {capability==='unsupported'&&<p className="session-task-detail">此 OMP 版本支持子代理进度；后台命令监控需要 Lucyna 任务接口。</p>}
  </section>;
}
