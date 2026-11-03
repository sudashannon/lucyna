import {useEffect,useRef,useState} from 'react';
import {ArrowDown,ArrowUp,Check,GitCommitHorizontal,RefreshCw} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {Input} from '@cindy/components/ui/input';
import {Spinner} from '@cindy/components/ui/spinner';
import {api} from '../api';
import type {Work} from '../types';
import type {FilesView} from './WorkspaceFiles';

type Snapshot={token:string;head:string;ref:string;counts:{staged:number;conflicts:number};busy:string[];lfsMode?:'normal'|'review'};
type Operation={operationId:string;action?:string;status:string;result?:{message?:string;progress?:string;commit?:string;member?:string;removed?:boolean;before?:{head:string;ref:string;index:string}}};
type Patch={id:string;header:string;lines:{id:string;text:string;kind:string}[]};
const labels:Record<string,string>={stage:'暂存文件',unstage:'取消暂存','stage-selection':'暂存选中行','unstage-selection':'取消选中行暂存',commit:'提交',fetch:'获取',push:'推送','branch-create':'创建分支','branch-switch':'切换分支','branch-merge':'快进合并','worktree-create':'创建工作树','worktree-move':'移动成员','worktree-remove':'移除成员工作树'};
const terminal=new Set(['completed','failed','reviewed']);
const statusLabels:Record<string,string>={queued:'排队中',running:'执行中',completed:'完成',failed:'失败',uncertain:'结果待核对',reviewed:'已核对','not-found':'服务未记录'};

export function WorkspaceGit({work,member,view,path,scope,compare,active,revision,onChanged}:{work:Work;member:string;view:FilesView;path:string;scope:string;compare:string;active:boolean;revision:number;onChanged:(member?:string,action?:string)=>void}){
  const key=JSON.stringify([work.hostId||'local',work.root,member]);
  return <GitControls key={key} {...{work,member,view,path,scope,compare,active,revision,onChanged}} storageKey={'lucyna.git.'+key}/>;
}

function GitControls({work,member,view,path,scope,compare,active,revision,onChanged,storageKey}:{work:Work;member:string;view:FilesView;path:string;scope:string;compare:string;active:boolean;revision:number;onChanged:(member?:string,action?:string)=>void;storageKey:string}){
  const call=(action:string,options:Record<string,unknown>={})=>api.gitWorkspace!(work.root,member,action,options,work.hostId);
  const [snap,setSnap]=useState<Snapshot>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[op,setOp]=useState<Operation>();
  const [loading,setLoading]=useState(false);
  const [lfsMode,setLfsMode]=useState<'normal'|'review'>('normal');
  const [fileToken,setFileToken]=useState('');
  const [operations,setOperations]=useState<Operation[]>([]),[patches,setPatches]=useState<Patch[]>([]),[selection,setSelection]=useState<string[]>([]),[patchToken,setPatchToken]=useState(''),[patchReason,setPatchReason]=useState('');
  const [message,setMessage]=useState(()=>localStorage.getItem(storageKey+'.message')||''),[branch,setBranch]=useState(''),[name,setName]=useState('');
  const [remotes,setRemotes]=useState<string[]>([]),[remote,setRemote]=useState(''),[target,setTarget]=useState(''),[confirm,setConfirm]=useState(false);
  const alive=useRef(true),request=useRef(0),changes=useRef(onChanged);changes.current=onChanged;
  const inFlight=useRef(''),polling=useRef(false),settled=useRef(new Set<string>());
  const defaultTarget=useRef('');
  const pending=!!op&&!terminal.has(op.status),blocked=busy||pending||!snap;
  const load=async()=>{
    const id=++request.current;
    setSnap(undefined);setFileToken('');setLoading(true);
    try{
      const [snapshot,network,history,fileSnapshot]=await Promise.all([call('snapshot'),call('network'),call('operations'),path?call('snapshot',{file:path}):Promise.resolve(null)]);
      if(!alive.current||id!==request.current)return;
      setSnap(snapshot);setFileToken(fileSnapshot?.token||'');setRemotes(network.remotes.map((r:{name:string})=>r.name));setRemote(old=>network.remotes.some((r:{name:string})=>r.name===old)?old:network.remotes[0]?.name||'');
      const currentBranch=snapshot.ref.replace(/^refs\/heads\//,''),previousDefault=defaultTarget.current;defaultTarget.current=currentBranch;
      setTarget(old=>!old||old===previousDefault?currentBranch:old);setOperations(history.operations);
      const outstanding=history.operations.find((r:Operation)=>!terminal.has(r.status));if(outstanding)setOp(outstanding);
      setError('');
    }catch(e){if(alive.current&&id===request.current)setError(String(e));}
    finally{if(alive.current&&id===request.current)setLoading(false);}
  };
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current++;};},[]);
  useEffect(()=>{if(active&&member&&api.gitWorkspace)void load();},[active,member,path,revision]);
  useEffect(()=>{setSelection([]);setPatches([]);setPatchToken('');setPatchReason('');setConfirm(false);},[path,scope,revision,view]);
  useEffect(()=>{localStorage.setItem(storageKey+'.message',message);},[message,storageKey]);
  const accept=(next:Operation)=>{
    if(!alive.current||settled.current.has(next.operationId))return;
    setOp(next);
    if(terminal.has(next.status)){
      settled.current.add(next.operationId);
      localStorage.removeItem(storageKey+'.pending');
      if(next.status==='completed'){
        if(next.action==='commit')setMessage('');
        setConfirm(false);changes.current(next.result?.member,next.action);
      }
    }
  };
  const reconcile=async(id=op?.operationId||localStorage.getItem(storageKey+'.pending')||'')=>{
    if(!id||polling.current||settled.current.has(id))return;
    polling.current=true;
    try{
      const next=await call('operation',{operationId:id});
      if(!alive.current||settled.current.has(id))return;
      if(next.status==='not-found'){
        if(inFlight.current===id)return;
        setError('服务未记录此操作。请核对仓库状态；不会自动重发。');
        setOp({operationId:id,status:'not-found'});
        return;
      }
      accept(next);
    }catch(e){if(alive.current&&!settled.current.has(id))setError(String(e));}
    finally{polling.current=false;}
  };
  useEffect(()=>{
    if(!active||!api.gitWorkspace)return;
    const id=op?.operationId||localStorage.getItem(storageKey+'.pending');
    if(!id||op&&(terminal.has(op.status)||op.status==='uncertain'||op.status==='not-found'))return;
    void reconcile(id);const timer=setInterval(()=>void reconcile(id),1500);return()=>clearInterval(timer);
  },[active,op?.operationId,op?.status]);
  const run=async(action:string,extra:Record<string,unknown>={})=>{
    if(blocked)return;setBusy(true);setError('');
    const operationId=crypto.randomUUID();inFlight.current=operationId;localStorage.setItem(storageKey+'.pending',operationId);
    setOp({operationId,action,status:'queued'});
    try{
      // The reviewed snapshot comes from the rendered surface. A stale token
      // is refused server-side, rather than silently reviewing a newer index.
      const next=await call(action,{operationId,expected:action.endsWith('-selection')?patchToken:extra.file?fileToken:snap!.token,...extra});
      accept({...next,action:next.action||action});
    }catch(e){if(alive.current&&!settled.current.has(operationId)){setError(String(e));setOp({operationId,action,status:'uncertain',result:{message:'操作结果尚未确认，请核对后再继续。'}});}}
    finally{inFlight.current='';if(alive.current)setBusy(false);}
  };
  const partial=async()=>{
    try{const value=await call('patches',{file:path,scope});if(!alive.current)return;setPatches(value.hunks);setPatchReason(value.reason||'');setPatchToken(value.snapshot.token);setSelection([]);}catch(e){setError(String(e));}
  };
  if(!member||!api.gitWorkspace)return null;
  return <section className="wf-git-controls" aria-label="Git 操作" aria-busy={busy||loading||op?.status==='queued'||op?.status==='running'}>
    <div className="wf-write-toolbar"><span>{work.hostId?'SSH · '+work.hostName:'WSL Git'} · {member}{snap?.ref?' · '+snap.ref.replace('refs/heads/',''):''}{snap?.lfsMode==='review'?' · LFS 审阅':''}</span>
      <details className="wf-sync"><summary>同步</summary><form onSubmit={e=>{e.preventDefault();void run('push',{remote,branch:target});}}>
        <label>远端<select aria-label="Git 同步远端" value={remote} onChange={e=>setRemote(e.target.value)}>{remotes.map(r=><option key={r}>{r}</option>)}</select></label>
        <Button compact variant="secondary" disabled={blocked||!remote} onClick={()=>void run('fetch',{remote})}><ArrowDown size={14}/>获取</Button>
        <Input aria-label="推送目标分支" placeholder="目标分支" value={target} onChange={setTarget}/><Button compact disabled={blocked||!remote||!target||!snap?.ref} type="submit"><ArrowUp size={14}/>推送</Button>
        <p>推送当前 HEAD 到所选远端分支。拒绝覆盖远端已有的新提交。</p>
      </form></details>
      <button className="icon-button" aria-label="刷新 Git 操作状态" disabled={busy} onClick={()=>void load()}><RefreshCw size={14}/></button>
    </div>
    {error&&<p className="wf-notice" role="alert">{error}<button onClick={()=>void load()}>刷新状态</button></p>}
    {op&&<div className={'wf-operation '+(op.status==='failed'||op.status==='uncertain'?'wf-operation-error':'')} role="status">
      {pending&&op.status!=='uncertain'?<Spinner size={14}/>:op.status==='completed'?<Check size={14}/>:null}
      <span>{labels[op.action||'']||'Git 操作'} · {statusLabels[op.status]||'状态未知'}{op.result?.message?'：'+op.result.message:''}{op.result?.commit?' · '+op.result.commit.slice(0,10):''}{op.result?.progress&&<pre className="wf-progress">{op.result.progress}</pre>}</span>
      {pending&&<button onClick={()=>void reconcile()}>核对结果</button>}
      {op.status==='uncertain'&&<button onClick={()=>void call('acknowledge',{operationId:op.operationId}).then(accept).then(()=>load()).catch(e=>setError(String(e)))}>我已核对仓库，解除限制</button>}
      {op.status==='not-found'&&<button onClick={()=>{localStorage.removeItem(storageKey+'.pending');setOp(undefined);void load();}}>已核对未执行，清除此请求</button>}
    </div>}
    {view==='changes'&&<details className="wf-write-section" open><summary>暂存与提交</summary>
      <div className="wf-file-actions"><span title={path}>{path||'选择文件后暂存；提交只包含暂存区内容。'}</span>
        {path&&scope!=='baseline'&&<><Button compact variant="secondary" disabled={blocked} onClick={()=>void run(scope==='staged'?'unstage':'stage',{file:path})}>{scope==='staged'?'取消文件暂存':'暂存整个文件'}</Button><button disabled={blocked} onClick={()=>void partial()}>选择块或行</button></>}
      </div>
      {(patches.length>0||patchReason)&&<div className="wf-patch-selection" aria-label="差异选区">{patchReason&&<p>{patchReason}</p>}{patches.map(h=><fieldset key={h.id}><legend><label><input type="checkbox" checked={h.lines.every(l=>selection.includes(l.id))} onChange={e=>setSelection(old=>e.target.checked?[...new Set([...old,...h.lines.map(l=>l.id)])]:old.filter(id=>!h.lines.some(l=>l.id===id)))}/>{h.header}</label></legend>{h.lines.map(l=><label className={'wf-patch-line wf-patch-'+l.kind} key={l.id}><input type="checkbox" checked={selection.includes(l.id)} onChange={e=>setSelection(old=>e.target.checked?[...old,l.id]:old.filter(id=>id!==l.id))}/><code>{l.text}</code></label>)}</fieldset>)}{patches.length>0&&<Button compact disabled={blocked||!selection.length} onClick={()=>void run(scope==='staged'?'unstage-selection':'stage-selection',{file:path,selection})}>{scope==='staged'?'取消选中行暂存':'暂存选中行'} · {selection.length}</Button>}</div>}
      <form className="wf-commit-form" onSubmit={e=>{e.preventDefault();void run('commit',{message});}}><label htmlFor={storageKey+'.commit'}>提交信息 · {snap?.counts.staged||0} 个已暂存文件</label><textarea id={storageKey+'.commit'} aria-label="Git 提交信息" value={message} onChange={e=>setMessage(e.target.value)} placeholder="简要说明这次修改，空行后可补充详情…" maxLength={20000}/><Button compact type="submit" disabled={blocked||!message.trim()||!snap?.counts.staged||!!snap?.counts.conflicts||!!snap?.busy.length}><GitCommitHorizontal size={14}/>提交暂存内容</Button></form>
    </details>}
    {view==='branches'&&<details className="wf-write-section"><summary>管理分支</summary><div className="wf-management-form"><Input aria-label="新分支名称" value={branch} onChange={setBranch} placeholder="新分支名称"/><Button compact variant="secondary" disabled={blocked||!branch} onClick={()=>void run('branch-create',{branch})}>从 HEAD 创建</Button>{compare.startsWith('refs/heads/')&&<><span>已选 {compare.replace('refs/heads/','')}</span><Button compact variant="secondary" disabled={blocked} onClick={()=>void run('branch-switch',{branch:compare.replace('refs/heads/','')})}>切换并更新 Work 登记</Button><Button compact variant="secondary" disabled={blocked} onClick={()=>void run('branch-merge',{branch:compare.replace('refs/heads/','')})}>快进合并到当前分支</Button></>}</div><p>要求工作树干净且没有活动会话；出现分叉时保留现状，在终端处理合并。</p></details>}
    {view==='worktrees'&&<>
      <details className="wf-write-section">
        <summary>管理当前 Work 的成员工作树</summary>
        <div className="wf-management-form">
          <Input aria-label="工作树成员名称" value={name} onChange={setName} placeholder="新成员名称"/>
          <Input aria-label="工作树新分支" value={branch} onChange={setBranch} placeholder="新工作树分支"/>
          {!work.hostId&&<label>LFS 文件
            <select value={lfsMode} onChange={e=>setLfsMode(e.target.value==='review'?'review':'normal')}>
              <option value="normal">按仓库设置检出</option>
              <option value="review">审阅时仅检出指针</option>
            </select>
          </label>}
          <Button compact variant="secondary" disabled={blocked||!name||!branch} onClick={()=>void run('worktree-create',lfsMode==='review'?{name,branch,lfsMode}:{name,branch})}>创建并登记</Button>
          <Button compact variant="secondary" disabled={blocked||!name} onClick={()=>void run('worktree-move',{name})}>当前成员改名并移动</Button>
          <button disabled={blocked} onClick={()=>setConfirm(v=>!v)}>移除当前成员…</button>
        </div>
        {lfsMode==='review'&&<p>大文件先保留为 LFS 指针。构建前需补齐所需资产。</p>}
        {confirm&&<div className="wf-remove-confirm"><p>将移除「{member}」的工作目录及 Work 登记，保留其 Git 分支。含改动、未跟踪或忽略的文件、锁定或活动会话时会拒绝操作。</p><Button compact disabled={blocked} onClick={()=>void run('worktree-remove')}>确认移除 {member}</Button></div>}
        <p>仅管理当前 Work 登记的成员，不修改其他 Work 或裸仓库。</p>
      </details>
      {!work.hostId&&<WorkspaceDiskUsage key={revision} read={()=>call('disk')}/>}
    </>}
    <details className="wf-operation-history"><summary>最近操作{operations.length?' · '+operations.length:''}</summary>{operations.map(r=><div key={r.operationId}><strong>{labels[r.action||'']||'Git 操作'}</strong><span>{statusLabels[r.status]||'状态未知'} · {r.result?.message||'等待结果'}</span></div>)}{!operations.length&&<p>此仓库暂无操作记录。</p>}</details>
  </section>;
}

type DiskUsage={
  memberBytes:number;
  sharedBytes:number;
  members:{name:string;bytes:number;trackedBytes:number;lfsBytes:number|null;ignoredBytes:number;untrackedBytes:number}[];
};

function diskSize(bytes:number){
  return bytes>=1024**3?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(bytes/1024**3)+' GiB'
    :new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(bytes/1024**2)+' MiB';
}

function WorkspaceDiskUsage({read}:{read:()=>Promise<DiskUsage>}){
  const [usage,setUsage]=useState<DiskUsage>(),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const refresh=async()=>{
    setLoading(true);setError('');
    try{setUsage(await read());}
    catch(e){setUsage(undefined);setError(String(e));}
    finally{setLoading(false);}
  };
  return <details className="wf-write-section">
    <summary>磁盘占用</summary>
    <div className="wf-management-form">
      <Button compact variant="secondary" disabled={loading} onClick={()=>void refresh()}>{usage?'重新统计':'统计成员占用'}</Button>
      {loading&&<span role="status"><Spinner size={14}/>正在统计…</span>}
    </div>
    {error&&<p role="alert">{error}</p>}
    {usage&&<>
      <p>成员合计 {diskSize(usage.memberBytes)}，已按硬链接去重。共享 Git 与 LFS 对象库 {diskSize(usage.sharedBytes)}，单独计量。</p>
      <ul className="wf-disk-members">{usage.members.map(member=><li key={member.name}>
        <strong>{member.name}</strong> · {diskSize(member.bytes)} · 跟踪文件 {diskSize(member.trackedBytes)}（LFS {member.lfsBytes===null?'未能识别':diskSize(member.lfsBytes)}）
        {' · 忽略文件 '}{diskSize(member.ignoredBytes)}{' · 未跟踪 '}{diskSize(member.untrackedBytes)}
      </li>)}</ul>
      <p>目录占用包含与其他 Work 共享的文件，实际可回收量取决于剩余硬链接。</p>
    </>}
  </details>;
}
