import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from '../api';
import {EvolutionView,FileChanges,RunStages,type Evolution,type FileDelta} from './WorkRunVisuals';
import {Modal} from './Modal';
import '../work-runs.css';

type Run={id:string;root:string;objective:string;acceptance:string;state:string;reason:string;createdAt:number;updatedAt:number;tokenBudget:number;usedTokens:number|null;elapsedSeconds:number;wallSeconds:number;attemptStartedAt?:number;sessionId?:string;effectiveModel?:{id?:string;name?:string;provider?:string};model:string;result:string;question?:{key:string;text:string};verification?:{passed:boolean|null;output:string};mode?:string;phase?:string;evolution?:Evolution;changes?:FileDelta[];automatic?:{trigger:string}};
type Check={argv:string[];cwd:string;files:string[]};
type AutoProfile={objective:string;acceptance:string;model:string;tokenBudget:number;wallSeconds:number;evolution:{targets:string[];iterations:number;training:Check;validation:Check}};
type Automation={enabled:boolean;status:string;label:string;message:string;profile:AutoProfile|null;nextAt?:number;lastRunId?:string;runsToday:number;dailyLimit:number;idleSeconds:number;cooldownSeconds:number};
type Event={seq:number;time:number;type:string;message:string;path?:string;paths?:string[];output?:string};
const states:Record<string,string>={queued:'排队中',starting:'正在启动',running:'执行中',waiting_user:'等待答复',stopping:'正在停止',verifying:'正在验收',completed:'已完成',waiting_review:'待人工验收',paused:'已暂停',interrupted:'执行中断',failed:'失败',cancelled:'已取消'};
const reasons:Record<string,string>={service_restarted:'服务重启，已有改动保留；检查 Work 后可恢复。',execution_error:'执行发生异常，详情见事件记录。',wall_budget:'执行时间预算已用完。',verification_failed:'固定检查未通过，可根据结果继续修复。',native_goal_stopped:'原生目标已停止推进，请检查进度与预算。'};
const terminal=new Set(['completed','failed','cancelled']);
const date=(value:number)=>new Date(value*1000).toLocaleString('zh-CN');

export function WorkRuns({root,active,connections=0,onConnections}:{root:string;active:boolean;connections?:number;onConnections?:()=>void}){
  const [runs,setRuns]=useState<Run[]>([]),[selected,setSelected]=useState(''),[events,setEvents]=useState<Event[]>([]);
  const [error,setError]=useState(''),[busy,setBusy]=useState(''),[loaded,setLoaded]=useState(false);
  const [objective,setObjective]=useState(''),[acceptance,setAcceptance]=useState(''),[model,setModel]=useState('');
  const [tokens,setTokens]=useState('100000'),[minutes,setMinutes]=useState('30'),[command,setCommand]=useState(''),[cwd,setCwd]=useState('.'),[files,setFiles]=useState('');
  const [answer,setAnswer]=useState(''),[showForm,setShowForm]=useState(false);
  const [mode,setMode]=useState<'task'|'evolution'>('task'),[targets,setTargets]=useState(''),[iterations,setIterations]=useState('2');
  const [validationCommand,setValidationCommand]=useState(''),[validationFiles,setValidationFiles]=useState(''),[validationCwd,setValidationCwd]=useState('.');
  const [expanded,setExpanded]=useState(false);
  const [automatic,setAutomatic]=useState<Automation|null>(null),[autoError,setAutoError]=useState(''),[configureAuto,setConfigureAuto]=useState(false);
  const cursor=useRef(0),requestKey=useRef(''),selection=useRef(''),alive=useRef(true),refreshing=useRef(false);
  const current=runs.find(r=>r.id===selected),occupied=runs.some(r=>!terminal.has(r.state));
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{requestKey.current='';},[objective,acceptance,model,tokens,minutes,command,cwd,files,mode,targets,iterations,validationCommand,validationFiles,validationCwd]);
  const choose=(id:string)=>{selection.current=id;cursor.current=0;setEvents([]);setSelected(id);setAnswer('');};
  const refresh=useCallback(async()=>{
    if(refreshing.current)return;refreshing.current=true;
    try{
      const items:Run[]=await api.workRun('list',{root});if(!alive.current)return;
      setRuns(previous=>items.map(item=>{const old=previous.find(r=>r.id===item.id);return old&&item.id===selection.current?{...item,evolution:old.evolution||item.evolution,changes:old.changes}:item;}));setLoaded(true);
      let id=selection.current;
      if(!items.some(r=>r.id===id)){id=items[0]?.id||'';choose(id);}
      if(id){
        const snapshot=await api.workRun('get',{runId:id,after:cursor.current});
        if(!alive.current||selection.current!==id)return;
        setRuns(previous=>previous.map(r=>r.id===id?snapshot.run:r));
        if(snapshot.events.length){cursor.current=snapshot.events.at(-1).seq;setEvents(previous=>[...previous,...snapshot.events].slice(-100));}
      }
      setError('');
    }catch(e){if(alive.current)setError(String(e));}finally{
      try{if(alive.current){const value=await api.workRun('automatic-status',{root});if(alive.current){setAutomatic(value);setAutoError('');}}}catch(e){if(alive.current)setAutoError(String(e));}
      refreshing.current=false;
    }
  },[root]);
  useEffect(()=>{if(!active)return;void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},3000);return()=>window.clearInterval(timer);},[active,refresh]);
  useEffect(()=>{if(active)void refresh();},[selected,active,refresh]);
  const act=async(op:string,data:Record<string,unknown>={})=>{
    setBusy(op);setError('');try{await api.workRun(op,{runId:selected,...data});await refresh();return true;}catch(e){setError(String(e));return false;}finally{if(alive.current)setBusy('');}
  };
  const create=async()=>{
    if((!configureAuto&&(connections||occupied))||!loaded||busy){setError('请先处理连接冲突，并等待读取任务状态完成。');return;}
    setBusy('create');setError('');try{
      let verification=null;
      if(command.trim()){const argv=JSON.parse(command);if(!Array.isArray(argv))throw Error('验收命令须为 JSON 参数数组');verification={argv,cwd:cwd.trim()||'.',files:files.split('\n').map(s=>s.trim()).filter(Boolean)};}
      const evolution=mode==='evolution'?{targets:targets.split('\n').map(s=>s.trim()).filter(Boolean),iterations:Number(iterations),training:verification,
        validation:{argv:JSON.parse(validationCommand),cwd:validationCwd.trim()||'.',files:validationFiles.split('\n').map(s=>s.trim()).filter(Boolean)}}:undefined;
      if(configureAuto){
        setAutomatic(await api.workRun('automatic-configure',{root,enabled:true,profile:{objective,acceptance,model:model.trim(),tokenBudget:Number(tokens),wallSeconds:Number(minutes)*60,evolution}}));
        setShowForm(false);setConfigureAuto(false);await refresh();return;
      }
      requestKey.current||=crypto.randomUUID();
      const run:Run=await api.workRun('create',{root,requestKey:requestKey.current,objective,acceptance,model:model.trim(),tokenBudget:Number(tokens),wallSeconds:Number(minutes)*60,verification:mode==='task'?verification:null,mode,...(evolution?{evolution}:{})});
      choose(run.id);setShowForm(false);setObjective('');setAcceptance('');await refresh();
    }catch(e){setError(String(e));}finally{if(alive.current)setBusy('');}
  };
  const setupAutomatic=()=>{
    const p=automatic?.profile;
    setObjective(p?.objective||'改进当前 Work 的局部执行流程，提高独立检查通过率');setAcceptance(p?.acceptance||'留出检查全部通过且优于基线，保存候选与证据，等待人工采纳');
    setModel(p?.model||'');setTokens(String(p?.tokenBudget||100000));setMinutes(String((p?.wallSeconds||1800)/60));
    setTargets(p?.evolution.targets.join('\n')||'');setIterations(String(p?.evolution.iterations||2));
    setCommand(p?JSON.stringify(p.evolution.training.argv):'');setFiles(p?.evolution.training.files.join('\n')||'');setCwd(p?.evolution.training.cwd||'.');
    setValidationCommand(p?JSON.stringify(p.evolution.validation.argv):'');setValidationFiles(p?.evolution.validation.files.join('\n')||'');setValidationCwd(p?.evolution.validation.cwd||'.');
    setConfigureAuto(true);setMode('evolution');setShowForm(true);setError('');
  };
  const toggleAutomatic=async()=>{setBusy('automatic');try{setAutomatic(await api.workRun('automatic-configure',{root,enabled:!automatic?.enabled}));setAutoError('');}catch(e){setAutoError(String(e));}finally{setBusy('');}};
  const content=<section className="work-runs" hidden={!active} aria-label="Work 后台任务">
    {!showForm&&<><section className={`wr-automatic wr-auto-${automatic?.status||'loading'}`} aria-label="自动进化" aria-live="polite">
      <div className="wr-section-title"><strong><span className="wr-auto-dot"/>自动进化</strong><span>{automatic?.enabled?'已开启':automatic?'已暂停':'正在连接'}</span></div>
      <h3>{automatic?.label||'正在读取自动调度状态…'}</h3><p>{automatic?.message||'有新变化且空闲时自动比较候选，采纳由你确认。'}</p>
      <ol className="wr-auto-flow" aria-label="自动进化流程"><li>检测变化</li><li>空闲评估</li><li>比较候选</li><li>你来采纳</li></ol>
      {automatic&&<p className="wd-caption">空闲 {automatic.idleSeconds} 秒 · 间隔至少 {automatic.cooldownSeconds/60} 分钟 · 近 24 小时 {automatic.runsToday} / {automatic.dailyLimit} 次{automatic.nextAt&&automatic.nextAt>Date.now()/1000?<> · 最早 {date(automatic.nextAt)}</>:null}</p>}
      {automatic?.profile&&<p className="wr-auto-targets">优化对象：{automatic.profile.evolution.targets.join('、')}</p>}
      {autoError&&<p role="alert" className="error-text">自动调度未就绪：{autoError}</p>}
      <div className="wr-actions"><button disabled={!!busy||!loaded} onClick={setupAutomatic}>{automatic?.profile?'调整评测配置':'配置一次评测'}</button>{automatic&&<button disabled={!!busy} onClick={()=>void toggleAutomatic()}>{automatic.enabled?'暂停后续实验':'开启自动进化'}</button>}{automatic?.lastRunId&&runs.some(r=>r.id===automatic.lastRunId)&&<button onClick={()=>{choose(automatic.lastRunId!);setExpanded(true);}}>查看最近结果</button>}</div>
    </section><p className="wd-caption">进化实验在副本中自动运行，不中断普通会话，也不会自动采纳。关闭客户端后服务继续检查已配置的 Work。</p>
    <div className="wr-capabilities"><span>Work 内迭代</span><span>技能 / L3 只读</span><span>候选可回退</span></div>
    {!expanded&&<button className="wr-expand" onClick={()=>setExpanded(true)}>放大查看任务与实验</button>}</>}
    {!configureAuto&&<div className="wr-readiness" role="status"><strong>{connections?'普通后台任务：此 Work 有 '+connections+' 个会话连接':occupied?'此 Work 已有未结束的后台任务':!loaded?'正在检查已有任务…':'可以配置后台任务'}</strong><p>{connections?'普通后台任务与采纳需要先结束连接；自动实验会等待本轮会话空闲。':'后台任务独立运行，关闭客户端后仍会继续。启动时将再次检查可用状态。'}</p>{connections>0&&onConnections&&<button type="button" onClick={()=>{setShowForm(false);setExpanded(false);onConnections();}}>查看会话连接</button>}</div>}
    <p className="wd-caption">首次启动会安装并启用 Lucyna 用户级后台服务。模型请求在途时可能略超 Token 预算。</p>
    {!showForm&&<div className="wr-actions"><button disabled={!!busy||occupied||!loaded} onClick={()=>{setConfigureAuto(false);setMode('task');setShowForm(true);}}>新建后台任务</button><button disabled={!!busy} onClick={()=>void refresh()}>刷新状态</button></div>}
    {error&&<p role="alert" className="error-text">{error}</p>}
    {showForm&&<form onSubmit={e=>{e.preventDefault();void create();}} className="wr-form">
      <div className="wr-section-title"><strong>{configureAuto?'自动进化 · 一次配置，持续复用':mode==='evolution'?'进化实验 · AntOmniEvo':'后台任务 · OMP'}</strong></div>
      <fieldset disabled={!!busy}><label>目标<textarea required maxLength={16000} value={objective} onChange={e=>setObjective(e.target.value)} placeholder="当前 Work 需要完成什么"/></label>
      <label>验收标准<textarea required maxLength={8000} value={acceptance} onChange={e=>setAcceptance(e.target.value)} placeholder="满足哪些条件才算完成"/></label>
      <label>模型<input value={model} onChange={e=>setModel(e.target.value)} placeholder="留空使用 WSL OMP 默认模型"/></label>
      <div className="wr-budget"><label>Token 预算<input type="number" min="1000" max="200000" step="1000" required value={tokens} onChange={e=>setTokens(e.target.value)}/></label><label>时间上限（分钟）<input type="number" min="1" max="720" required value={minutes} onChange={e=>setMinutes(e.target.value)}/></label></div>
      {mode==='evolution'&&<><p className="wd-caption">仅优化选定文件。训练与留出检查分别冻结；评分器最后一行须输出 JSON：score（0–1），或 passed / total。留出检查通过且优于基线，才提供采纳入口。</p><label>优化对象（每行一个现有文件）<textarea required value={targets} onChange={e=>setTargets(e.target.value)} placeholder={'scripts/workflow.py\nnotes/verification.md'}/></label><label>最多生成轮数<input type="number" min="1" max="5" required value={iterations} onChange={e=>setIterations(e.target.value)}/></label></>}
      <details open={mode==='evolution'||undefined}><summary>{mode==='evolution'?'训练检查（必填）':'自动验收（可选）'}</summary><p className="wd-caption">检查在无网络的隔离环境中运行，Work 源文件只读，临时文件可写入 /tmp。普通任务未设置检查时，结束后等待你验收。</p>
        <label>命令参数数组<textarea required={mode==='evolution'} value={command} onChange={e=>setCommand(e.target.value)} placeholder={'["/usr/bin/python3", "tests/check.py"]'}/></label>
        <label>运行目录（相对 Work）<input value={cwd} onChange={e=>setCwd(e.target.value)}/></label>
        <label>冻结的验收文件（每行一个相对路径）<textarea required={mode==='evolution'} value={files} onChange={e=>setFiles(e.target.value)} placeholder="tests/check.py"/></label>
      </details>
      {mode==='evolution'&&<details open><summary>独立留出检查（必填）</summary><label>命令参数数组<textarea required value={validationCommand} onChange={e=>setValidationCommand(e.target.value)} placeholder={'["/usr/bin/python3", "tests/holdout.py"]'}/></label><label>留出检查运行目录<input value={validationCwd} onChange={e=>setValidationCwd(e.target.value)}/></label><label>冻结文件（模型不可读取，每行一个）<textarea required value={validationFiles} onChange={e=>setValidationFiles(e.target.value)} placeholder="tests/holdout.py"/></label><p className="wd-caption">首次实验会下载固定版本 AntOmniEvo 并安装独立 Python 环境，可能需要几分钟。候选均在副本中执行。</p></details>}
      </fieldset>
      <div className="wr-actions wr-form-actions"><span>{configureAuto?'每次预算 '+Number(tokens).toLocaleString()+' Token · 结果由你采纳':connections?'请先结束普通会话连接':'预算 '+Number(tokens).toLocaleString()+' Token · 上限 '+minutes+' 分钟'}</span><button type="submit" disabled={!!busy||(!configureAuto&&(!!connections||occupied))||!loaded}>{busy==='create'?'正在保存…':configureAuto?'保存并自动运行':'开始执行'}</button><button type="button" disabled={!!busy} onClick={()=>{setShowForm(false);setConfigureAuto(false);}}>取消</button></div>
    </form>}
    {loaded&&!runs.length&&!showForm&&<p className="empty-line">此 Work 尚无后台任务。</p>}
    {!!runs.length&&<label className="wr-picker">任务<select value={selected} onChange={e=>choose(e.target.value)}>{runs.map(run=><option key={run.id} value={run.id}>{states[run.state]||run.state} · {run.objective.slice(0,45)}</option>)}</select></label>}
    {current&&<article className="wr-run">
      <div className={`wr-heading wr-state-${current.state}`} role="status" aria-live="polite"><strong>{current.mode==='evolution'&&current.state==='waiting_review'?'候选待采纳':states[current.state]||current.state}</strong><span>WSL · {current.effectiveModel?.name||current.effectiveModel?.id||current.model||'默认模型'}</span></div>
      <RunStages state={current.state} phase={current.phase} evolution={current.mode==='evolution'}/>
      {current.automatic&&<p className="wr-auto-origin">自动触发 · Work 有新变化且已空闲 · 候选等待你确认采纳</p>}
      <h3>{current.objective}</h3><p className="wd-caption">{current.acceptance}</p>
      <p className="wd-caption">Token {current.usedTokens??'未知'} / {current.tokenBudget} · 已执行 {Math.round(current.elapsedSeconds+(current.attemptStartedAt?Math.max(0,Date.now()/1000-current.attemptStartedAt):0))} 秒 / {current.wallSeconds} 秒<br/>更新于 {date(current.updatedAt)}</p>
      <label className="wr-meter">Token 预算用量 <progress max={current.tokenBudget} value={current.usedTokens??0}/></label>
      {current.evolution?.usageEstimated&&<p className="wd-caption">含中断调用的预留预算：缺失最终用量时按该次上限计入，不是精确账单。</p>}
      {reasons[current.reason]&&<p className="wd-warning">{reasons[current.reason]}</p>}
      {current.state==='interrupted'&&<p className="wd-caption">{current.mode==='evolution'?'恢复会读取已保存的候选与评估记录；未完成的候选保留作诊断，重新提出候选可能消耗额外预算。':'恢复会复用原会话。请先检查 Work 中已发生的修改；未落盘的工具结果不会自动重放。'}</p>}
      <div className="wr-actions">
        {['queued','starting','running','waiting_user','verifying'].includes(current.state)&&<button disabled={!!busy} onClick={()=>void act('pause')}>暂停</button>}
        {['paused','interrupted'].includes(current.state)&&<button disabled={!!busy} onClick={()=>void act('resume')}>恢复执行</button>}
        {current.state==='waiting_review'&&<button disabled={!!busy} onClick={()=>void act(current.mode==='evolution'?'adopt':'accept')}>{current.mode==='evolution'?'采纳最佳候选到 Work':'已检查结果，验收通过'}</button>}
        {current.evolution?.promotion==='applied'&&<button disabled={!!busy} onClick={()=>void act('rollback')}>回退本次采纳</button>}
        {!terminal.has(current.state)&&<button disabled={!!busy} onClick={()=>void act('cancel')}>取消任务并保留改动</button>}
      </div>
      {current.evolution&&<EvolutionView key={current.id} value={current.evolution}/>}
      {current.changes&&current.changes.length>0&&<details><summary>最近文件修改 · {current.changes.length}</summary><FileChanges changes={current.changes}/></details>}
      {current.question&&<form className="wr-question" onSubmit={e=>{e.preventDefault();void act('answer',{answerKey:current.question!.key,answer}).then(ok=>{if(ok)setAnswer('');});}}><p>{current.question.text}</p><label>你的答复<textarea required maxLength={8000} value={answer} onChange={e=>setAnswer(e.target.value)}/></label><button disabled={!!busy}>发送答复</button></form>}
      {current.verification&&<details open={current.verification.passed===false}><summary>检查结果 · {current.verification.passed===true?'通过':current.verification.passed===false?'未通过':'待人工验收'}</summary><pre>{current.verification.output||'未配置自动检查。'}</pre></details>}
      {current.result&&<details open><summary>最近结果</summary><p className="wr-result">{current.result}</p></details>}
      <details open><summary>执行时间线 · 最近 {events.length} 条</summary><ol className="wr-events">{events.map(event=><li key={event.seq}><time>{new Date(event.time*1000).toLocaleTimeString('zh-CN')}</time><span>{event.message||event.type}{event.path?' · '+event.path:''}{event.paths?.length?` · ${event.paths.join('、')}`:''}{event.output&&<details><summary>命令输出</summary><pre>{event.output}</pre></details>}</span></li>)}</ol></details>
      {terminal.has(current.state)&&<p className="wd-caption">本次任务已结束；Work 的整体交付、合并与归档状态由现有工作流管理。</p>}
    </article>}
  </section>;
  return expanded||showForm?<Modal open={active} onClose={()=>{if(!busy){setExpanded(false);setShowForm(false);setConfigureAuto(false);}}} title={showForm?(configureAuto?'配置自动进化':mode==='evolution'?'新建进化实验':'新建后台任务'):'Work 后台任务与进化实验'} description={showForm?(configureAuto?'保存一次评测配置，之后在 Work 有变化且空闲时自动运行。':'设定目标、验收标准和预算。启动后可在这里跟踪进度。'):'查看执行阶段、独立检查、候选差异与采纳记录。'} className="wr-dashboard-modal">{content}</Modal>:content;
}
