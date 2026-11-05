import {lazy,Suspense,useEffect,useId,useMemo,useRef,useState} from 'react';
import {ArrowLeft,FileText,GitBranch,GitCommitHorizontal,GitFork,History,MessageSquare,PanelLeftOpen,RefreshCw,Search} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {Input} from '@cindy/components/ui/input';
import {Spinner} from '@cindy/components/ui/spinner';
import {api} from '../api';
import type {FilePreview,Work} from '../types';
import type {GitCommit,GitReadOptions,WorkDetail} from '../work-detail-data';
import {useWorkspaceGitRead} from '../useWorkspaceGitRead';
import type {ReaderPosition} from '../reader-position';
import {FileBrowser} from './FileBrowser';
import {DocumentReader} from './ToolPanels';
import {WorkspaceGit} from './WorkspaceGit';
import '../workspace-files.css';

const DiffView=lazy(()=>import('./WorkspaceDiff'));
export type FilesView='browse'|'changes'|'history'|'branches'|'worktrees';
export type GitLocation={member:string;view:FilesView;scope?:string;revision:number};
const views=[['browse','浏览',FileText],['changes','改动',GitBranch],['history','历史',History],['branches','分支',GitBranch],['worktrees','Worktree',GitFork]] as const;
const short=(value?:string)=>value?.slice(0,10)||'—';
const stamp=(value?:string)=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';

export function WorkspaceFiles({work,active,selected,target,onError,onDiscuss,onImage}:{work:Work;active:boolean;selected:FilePreview|null;target?:GitLocation;onError:(error:unknown)=>void;onDiscuss:(text:string)=>void;onImage:(url:string)=>void}){
  const [view,setView]=useState<FilesView>('browse'),[detail,setDetail]=useState<WorkDetail>(),[detailError,setDetailError]=useState('');
  const [member,setMember]=useState(''),[revision,setRevision]=useState(0),[listOpen,setListOpen]=useState(false);
  const [browserRevision,setBrowserRevision]=useState(0);
  const [files,setFiles]=useState<FilePreview[]>([]),[current,setCurrent]=useState(''),[scope,setScope]=useState('unstaged'),[path,setPath]=useState('');
  const [query,setQuery]=useState(''),[cursor,setCursor]=useState(''),[pages,setPages]=useState<GitCommit[]>([]),[commit,setCommit]=useState<GitCommit>();
  const [compare,setCompare]=useState(''),[split,setSplit]=useState(false),[width,setWidth]=useState(0);
  const host=useRef<HTMLDivElement>(null),listTrigger=useRef<HTMLButtonElement>(null),positions=useRef(new Map<string,ReaderPosition>()),id=useId();
  const file=files.find(f=>(f.path||f.name)===current),currentMember=detail?.members.find(m=>m.name===member);
  const add=(next:FilePreview)=>{setFiles(old=>[...old.filter(f=>(f.path||f.name)!==(next.path||next.name)),next].slice(-8));setCurrent(next.path||next.name);setListOpen(false);};
  useEffect(()=>{if(selected){add(selected);setView('browse');}},[selected]);
  useEffect(()=>{if(target){setMember(target.member);setView(target.view);setScope(target.scope||'unstaged');setPath('');setCompare('');setCommit(undefined);setCursor('');setPages([]);}},[target]);
  useEffect(()=>{if(!active)return;let live=true;setDetailError('');void api.workDetails(work.root,work.hostId).then(next=>{if(live)setDetail(next);}).catch(error=>{if(live)setDetailError(String(error));});return()=>{live=false;};},[active,revision,work.root,work.hostId]);
  const chooseMember=(next:string)=>{setMember(next);setCursor('');setPages([]);setCommit(undefined);setCompare('');setPath('');};
  useEffect(()=>{if(detail&&!detail.members.some(m=>m.name===member)){chooseMember(detail.members.find(m=>!m.detailError)?.name||detail.members[0]?.name||'');}},[detail]);
  useEffect(()=>{const element=host.current;if(!element)return;const observer=new ResizeObserver(([entry])=>setWidth(entry.contentRect.width));observer.observe(element);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(!active)return;const timer=window.setInterval(()=>{if(document.visibilityState==='visible')setRevision(v=>v+1);},60000);return()=>clearInterval(timer);},[active]);
  useEffect(()=>{setCursor('');setPages([]);setCommit(undefined);},[revision]);
  useEffect(()=>{if(!active)setListOpen(false);},[active]);
  useEffect(()=>{if(!listOpen)return;const close=(e:KeyboardEvent)=>{if(e.key==='Escape'){setListOpen(false);listTrigger.current?.focus();}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[listOpen]);
  const listing=useWorkspaceGitRead(work,member,view==='changes'?'changes':view==='history'?'history':view==='branches'?'refs':view==='worktrees'?'worktrees':'',view==='history'?{query,cursor}:{},active,revision);
  useEffect(()=>{if(listing.data?.kind==='history')setPages(old=>cursor?[...old.filter(c=>!listing.data!.commits?.some(n=>n.oid===c.oid)),...(listing.data!.commits||[])]:listing.data!.commits||[]);},[listing.data]);
  const diffAction=view==='changes'?'diff':view==='history'&&commit?'commit':view==='branches'&&compare?'compare':'';
  const diffOptions:GitReadOptions=view==='changes'?{scope,file:path}:view==='history'?{commit:commit?.oid}:{base:compare,target:'HEAD'};
  const diff=useWorkspaceGitRead(work,member,diffAction,diffOptions,active&&(view!=='changes'||!!path||scope==='baseline'),revision);
  const changed=listing.data?.files||[];
  const count=listing.data?.kind==='changes'?new Set(changed.map(f=>f.path)).size:currentMember?.changedFiles;
  const memberForFile=detail?.members.find(m=>file?.path?.startsWith('repos/'+m.name+'/'));
  const discuss=()=>{const selection=window.getSelection();const picked=selection&&host.current?.contains(selection.anchorNode)&&host.current?.contains(selection.focusNode)?selection.toString():'';
    const content=picked||(view==='browse'?file?.content:diff.data?.text)||'';
    const reference=view==='browse'?file?.path||file?.name:path||commit?.oid||compare;
    if(!reference)return;
    onDiscuss(`请讨论以下工作区内容：\nWork：${work.root}\n${work.hostId?'主机：'+work.hostName+'\n':''}文件/范围：${reference}\n${view!=='browse'?'成员：'+member+' · '+scope+'\n读取于：'+(diff.data?.checkedAt||'')+'\n':''}\n${content.slice(0,12000)}${content.length>12000?'\n[片段已截断，仅包含前 12000 字符]':''}`);
  };
  const changeView=(next:FilesView)=>{setView(next);setListOpen(false);};
  const navigateDiff=(next:string)=>{setPath(next);setListOpen(false);};
  const browseDiff=()=>{if(!file?.path||!memberForFile)return;chooseMember(memberForFile.name);setPath(file.path.slice(('repos/'+memberForFile.name+'/').length));setScope('unstaged');setView('changes');};
  const changedRepo=(next?:string,action?:string)=>{
    if(action?.startsWith('worktree-')){
      setBrowserRevision(v=>v+1);
      const prefix='repos/'+member+'/',replacement='repos/'+next+'/';
      if(action==='worktree-move'&&next){setFiles(old=>old.map(f=>f.path?.startsWith(prefix)?{...f,path:replacement+f.path.slice(prefix.length)}:f));setCurrent(old=>old.startsWith(prefix)?replacement+old.slice(prefix.length):old);}
      if(action==='worktree-remove'){setFiles(old=>old.filter(f=>!f.path?.startsWith(prefix)));setCurrent('');setPath('');}
    }
    if(next)chooseMember(next);setRevision(v=>v+1);
  };
  const title=view==='browse'?file?.path||'选择文件开始阅读':view==='changes'?scope==='baseline'?'登记基线 → HEAD':path||'选择文件审查差异':view==='history'?commit?.subject||'选择提交查看差异':view==='branches'?compare?compare+' → HEAD':'选择分支查看详情':'同仓 Worktree';
  const bodyText=diff.data?.text||'';
  return <div className="workspace-files" ref={host} hidden={!active}>
    <div className="wf-toolbar"><div role="tablist" aria-label="工作区文件视图" className="wf-views">{views.map(([key,label,Icon],index)=><button key={key} id={id+'-'+key} role="tab" aria-selected={view===key} aria-controls={id+'-content'} tabIndex={view===key?0:-1} onClick={()=>changeView(key)} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const n=e.key==='Home'?0:e.key==='End'?views.length-1:(index+(e.key==='ArrowLeft'?-1:1)+views.length)%views.length;changeView(views[n][0]);(e.currentTarget.parentElement?.children[n] as HTMLElement)?.focus();}}><Icon size={14}/>{label}{key==='changes'&&count!=null&&<span>{count}</span>}</button>)}</div>
      <div className="wf-repo-controls">{detail?.members.length?<label><span className="sr-only">选择 Git 成员仓库</span><select aria-label="选择 Git 成员仓库" value={member} onChange={e=>chooseMember(e.target.value)}>{detail.members.map(m=><option key={m.name} value={m.name}>{m.name}{m.detailError?' · 登记异常':''}</option>)}</select></label>:<span className="wf-caption">{work.hostId?'SSH 工作区':'Work 文件'}</span>}
        {currentMember&&<span className="wf-branch" title={currentMember.branch}><GitBranch size={13}/>{currentMember.branch}</span>}
        <button className="icon-button" aria-label="刷新工作区文件与 Git" onClick={()=>setRevision(v=>v+1)}><RefreshCw size={15}/></button></div></div>
    <>
      {detailError&&<p className="wf-notice" role="alert">{detail?'当前显示上次读取的内容。':''}{detailError}<button onClick={()=>setRevision(v=>v+1)}>重试</button></p>}
      {currentMember?.detailError&&view!=='browse'&&<p className="wf-notice" role="alert">{currentMember.detailError}</p>}
      {view!=='browse'&&!member?<div className="wf-empty"><GitBranch size={28}/><h2>{detail?'当前 Work 尚未登记 Git 仓库':'正在读取仓库信息…'}</h2><p>你仍可在「浏览」中阅读工作区文件。</p><Button variant="secondary" compact onClick={()=>changeView('browse')}>浏览文件</Button></div>:<>
      {view!=='worktrees'&&<div className="wf-mobile-controls"><button ref={listTrigger} aria-expanded={listOpen} aria-controls={id+'-list'} onClick={()=>setListOpen(v=>!v)}><PanelLeftOpen size={15}/>{view==='browse'?'文件列表':view==='history'?'提交列表':view==='branches'?'分支列表':'改动列表'}</button>{listOpen&&<button onClick={()=>{setListOpen(false);listTrigger.current?.focus();}}><ArrowLeft size={14}/>返回内容</button>}</div>}
      <div className={'wf-body '+(listOpen?'wf-list-open':'')+(view==='worktrees'?' wf-wide':'')} id={id+'-content'} role="tabpanel" aria-labelledby={id+'-'+view}>
        <aside className="wf-list" id={id+'-list'} aria-label={view==='browse'?'工作区文件列表':view==='history'?'提交列表':'仓库列表'}>
          <div hidden={view!=='browse'}><FileBrowser key={browserRevision} root={work.root} hostId={work.hostId} active={active&&view==='browse'} selected={file?.path} onOpen={add} onError={onError}/></div>{view!=='browse'&&<>
          {listing.busy&&<div className="wf-loading" role="status"><Spinner size={14}/>读取 Git…</div>}
          {listing.error&&<p className="wf-notice" role="alert">{listing.error}<button onClick={()=>setRevision(v=>v+1)}>重试</button></p>}
          {view==='changes'&&<><div className="wf-scope" aria-label="差异范围">{[['unstaged','未暂存'],['staged','已暂存'],['baseline','登记基线']].map(([key,label])=><button key={key} aria-pressed={scope===key} onClick={()=>{setScope(key);if(key==='baseline')setPath('');}}>{label}</button>)}</div>
            {scope==='baseline'?<p className="wf-caption wf-inset">登记基线 → HEAD · {short(currentMember?.baseSha)}</p>:<>
              {([['冲突',changed.filter(f=>f.conflict)],['已暂存',changed.filter(f=>f.staged)],['未暂存',changed.filter(f=>f.unstaged&&!f.conflict)],['未跟踪',changed.filter(f=>f.untracked)]] as const).map(([label,rows])=>rows.length>0&&<section className="wf-change-group" key={label}><h3>{label}<span>{rows.length}</span></h3>{rows.map(f=><button className="wf-file-row" aria-current={path===f.path&&(label==='已暂存'?scope==='staged':scope==='unstaged')?'true':undefined} key={f.path} title={f.path} onClick={()=>{setScope(label==='已暂存'?'staged':'unstaged');navigateDiff(f.path);}}><code>{f.code.trim()||'M'}</code><span>{f.path}</span>{f.oldPath&&<small title={'原路径：'+f.oldPath}>重命名</small>}</button>)}</section>)}
              {!listing.busy&&listing.data&&!changed.length&&<p className="wf-empty">当前仓库没有未提交改动。</p>}
            </>}
            <p className="wf-readonly"><GitBranch size={14}/>先审查差异，再在下方暂存与提交。冲突需先处理。</p></>}
          {view==='history'&&<><div className="wf-search"><Search size={14}/><Input aria-label="搜索 Git 提交消息" placeholder="搜索提交消息…" value={query} onChange={value=>{setQuery(value);setCursor('');setPages([]);setCommit(undefined);}}/></div>{pages.map(c=><button className="wf-commit-row" key={c.oid} aria-current={commit?.oid===c.oid?'true':undefined} onClick={()=>{setCommit(c);setListOpen(false);}}><GitCommitHorizontal size={15}/><span><strong>{c.subject}</strong><small>{c.author} · {stamp(c.date)} · {short(c.oid)}</small></span></button>)}{!listing.busy&&listing.data&&!pages.length&&<p className="wf-empty">没有匹配的提交。</p>}{listing.data?.nextCursor&&<button className="text-action wf-inset" onClick={()=>setCursor(listing.data!.nextCursor!)}>加载更多提交</button>}</>}
          {view==='branches'&&<>{[false,true].map(remote=><section className="wf-change-group" key={String(remote)}><h3>{remote?'远端引用 · 本机缓存':'本地分支'}</h3>{listing.data?.branches?.filter(b=>b.remote===remote).map(b=><button className="wf-commit-row" key={b.ref} aria-current={compare===b.ref?'true':undefined} onClick={()=>{setCompare(b.ref);setListOpen(false);}}><GitBranch size={14}/><span><strong>{b.name}{b.current?' · 当前':''}</strong><small>{short(b.oid)}{b.upstream?' · '+b.upstream:''}</small></span></button>)}</section>)}<p className="wf-readonly">选择分支仅比较它与 HEAD 的差异，不切换分支。</p></>}
          {listing.data?.truncated&&<p className="wf-notice">列表超过读取上限，当前仅显示部分结果。</p>}
          </>}
        </aside>
        <section className="wf-reader" aria-label="文件与差异阅读区">
          {view==='worktrees'?<><div className="wf-reader-heading"><h2>同仓 Worktree</h2><span className="wf-caption">管理操作见下方</span></div>{listing.busy&&<div className="wf-loading"><Spinner size={14}/>读取工作树…</div>}{listing.error&&<p className="wf-notice" role="alert">{listing.error}</p>}<div className="wf-worktrees">{listing.data?.worktrees?.map(tree=><article key={tree.path}><GitFork size={18}/><div><h3>{tree.branch?.replace('refs/heads/','')||(tree.detached?'分离 HEAD':tree.bare?'裸仓库':'未命名')}</h3><p>{tree.path}</p><small>{short(tree.head)}{tree.path===currentMember?.path?' · 当前 Work 成员':''}{tree.locked?' · 已锁定':''}{tree.prunable?' · 可清理标记':''}</small></div><button className="icon-button" aria-label={'复制工作树路径 '+tree.path} onClick={()=>void api.copyText(tree.path).catch(onError)}><FileText size={15}/></button></article>)}</div><p className="wf-readonly">创建、移动与移除会协调 Work 登记，并检查活动会话。请在下方管理当前成员。</p></>:<>
            {view==='browse'&&files.length>0&&<div className="wf-open-files" aria-label="已打开的工作区文件">{files.map(f=><button key={f.path||f.name} aria-pressed={current===(f.path||f.name)} title={f.path||f.name} onClick={()=>setCurrent(f.path||f.name)}>{f.name}</button>)}</div>}
            <div className="wf-reader-heading"><span title={title}>{title}</span><div>{view==='browse'&&memberForFile&&<button onClick={browseDiff}>查看差异</button>}{view!=='browse'&&diff.data?.text&&<div className="wf-scope"><button aria-pressed={!split||width<1120} onClick={()=>setSplit(false)}>统一</button><button aria-pressed={split&&width>=1120} disabled={width<1120} title={width<1120?'阅读区较窄，使用统一视图':'并排显示'} onClick={()=>setSplit(true)}>并排</button></div>}<button disabled={view==='browse'?!file:!bodyText} onClick={discuss}><MessageSquare size={14}/>在对话中讨论</button></div></div>
            {view==='browse'?file?file.kind==='image'?<button className="wf-image" aria-label="放大工作区图片" onClick={()=>onImage(file.dataUrl!)}><img src={file.dataUrl} alt={file.name}/></button>:<DocumentReader key={current} file={file} root={work.root} hostId={work.hostId} onError={onError} onNavigate={add} positions={positions.current} active={active&&view==='browse'}/>:<div className="wf-empty"><FileText size={30}/><h2>阅读当前工作区的文件</h2><p>从文件列表选择 Markdown、代码、配置或图片。</p></div>:<>
              {commit&&view==='history'&&<div className="wf-commit-info"><strong>{commit.subject}</strong><span>{commit.author} · {stamp(commit.date)}</span><code>{commit.oid}</code></div>}
              {diff.busy?<div className="wf-loading" role="status"><Spinner size={14}/>读取差异…</div>:diff.error?<p className="wf-notice" role="alert">{diff.error}<button onClick={()=>setRevision(v=>v+1)}>重试</button></p>:diff.data?<Suspense fallback={<div className="wf-loading">载入差异阅读器…</div>}><DiffView text={bodyText} split={split&&width>=1120}/></Suspense>:<div className="wf-empty"><GitBranch size={30}/><h2>{title}</h2><p>阅读不会修改仓库、分支或暂存区。</p></div>}
              {diff.data?.truncated&&<p className="wf-notice">差异超过显示上限，当前内容已截断。</p>}
            </>}
          </>}
        </section>
      </div></>}
      <WorkspaceGit work={work} member={member} view={view} path={path} scope={scope} compare={compare} active={active} revision={revision} onChanged={changedRepo}/>
      <footer className="wf-status"><span>{currentMember?'当前仓库 '+currentMember.name:'工作区文件'}{currentMember?.head?' · '+short(currentMember.head):''}</span><span>{work.hostId?'SSH · '+work.hostName:'WSL'} · {listing.data?.checkedAt?'读取于 '+stamp(listing.data.checkedAt):'文件浏览'}</span></footer>
    </>
  </div>;
}
