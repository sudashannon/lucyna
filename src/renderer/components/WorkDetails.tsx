import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowUpRight,BookOpen,Copy,FileText,Folder,GitBranch,RefreshCw} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {Input} from '@cindy/components/ui/input';
import {Spinner} from '@cindy/components/ui/spinner';
import {api} from '../api';
import type {FilePreview,HistoryEntry,Work} from '../types';
import {groupRepositories,relatedHistory,workRecord,type GitInspection,type WorkAsset,type WorkDetail,type WorkMember} from '../work-detail-data';
import {plainText} from '../panel-data';
import {Document} from './Document';
import {FileBrowser} from './FileBrowser';
import {WorkRuns} from './WorkRuns';
import {Modal} from './Modal';
import '../work-details.css';

const time=(value?:string)=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'未记录';
const short=(value?:string)=>value?.slice(0,10)||'—';
const assetLabels={note:'共享笔记 · L1',log:'会话日志 · L2',script:'可复用脚本',evidence:'引用证据'};
const states:Record<string,string>={active:'进行中',paused:'已暂停',delivered:'已交付',merged:'已合并',archived:'已归档',abandoned:'已放弃'};
type Props={work:Work;active:boolean;connections?:number;onConnections?:()=>void;history:HistoryEntry[];onOpen:(file:FilePreview)=>void;onResume:(entry:HistoryEntry)=>void;onCommand:(command:string)=>void;onMemory:(query:string)=>void;onError:(error:unknown)=>void};

export function WorkDetails({work,active,connections,onConnections,history,onOpen,onResume,onCommand,onMemory,onError}:Props){
  const [cache,setCache]=useState<Record<string,WorkDetail>>({}),[tabs,setTabs]=useState<Record<string,string>>({}),[queries,setQueries]=useState<Record<string,string>>({});
  const [loading,setLoading]=useState(''),[error,setError]=useState(''),[revision,setRevision]=useState(0),[expanded,setExpanded]=useState<Record<string,boolean>>({});
  const [inspect,setInspect]=useState<{root:string;member:WorkMember;action:string;scope:string}|null>(null),[directory,setDirectory]=useState(''),[opening,setOpening]=useState('');
  const generation=useRef(0),rootNow=useRef(work.root);rootNow.current=work.root;
  const detail=cache[work.root],tab=tabs[work.root]||'overview',query=queries[work.root]||'';
  useEffect(()=>{if(!active)return;let live=true;setError('');setLoading(work.root);const id=++generation.current;
    void api.workDetails(work.root).then(value=>{if(live&&id===generation.current)setCache(previous=>({...previous,[work.root]:value}));}).catch(e=>{if(live)setError(String(e));}).finally(()=>{if(live)setLoading('');});
    return()=>{live=false;};
  },[work.root,active,revision]);
  useEffect(()=>{setInspect(null);setDirectory('');setOpening('');setError('');},[work.root]);
  useEffect(()=>{if(!active)return;const timer=window.setInterval(()=>{if(document.visibilityState==='visible'&&!loading)setRevision(v=>v+1);},60000);return()=>window.clearInterval(timer);},[active,loading]);
  const record=useMemo(()=>workRecord(detail?.content||''),[detail?.content]);
  const groups=useMemo(()=>groupRepositories(detail?.members||[]),[detail?.members]);
  const source=(anchor?:string)=>{if(detail)onOpen({name:'SESSION.md',path:'SESSION.md',kind:'markdown',content:detail.content,anchor});};
  const navigate=async(href:string)=>{const root=work.root;try{const [reference,anchor]=href.split('#');const file=await api.readPreview(root,decodeURIComponent(reference),'SESSION.md');if(rootNow.current===root)onOpen({...file,anchor:anchor?decodeURIComponent(anchor):undefined});}catch(e){onError(e);}};
  const openAsset=async(asset:WorkAsset)=>{if(asset.directory){setDirectory(asset.path);return;}const root=work.root;setOpening(asset.path);try{const file=await api.readPreview(root,asset.path);if(rootNow.current===root)onOpen(file);}catch(e){onError(e);}finally{if(rootNow.current===root)setOpening('');}};
  const show=(member:WorkMember,action:string,scope='unstaged')=>setInspect({root:work.root,member,action,scope});
  const toggle=(name:string,value:boolean)=>setExpanded(previous=>({...previous,[work.root+'|'+name]:value}));
  const isOpen=(name:string)=>!!expanded[work.root+'|'+name];
  const unindexed=(detail?.assets||[]).filter(a=>!a.indexed&&['note','log'].includes(a.kind)).length;
  return <div className="work-details">
    <div className="panel-title"><h2>工作详情</h2><button className="icon-button" aria-label="刷新工作详情" disabled={loading===work.root} onClick={()=>setRevision(v=>v+1)}>{loading===work.root?<Spinner size={14}/>:<RefreshCw size={14}/>}</button></div>
    <div className="wd-identity"><strong>{work.name}</strong><span className="wd-badge">{states[record.state]||record.state||'未登记状态'}</span></div>
    <button className="wd-path" title="复制工作根路径" onClick={()=>void api.copyText(work.root).catch(onError)}><span>{work.root}</span><Copy size={12}/></button>
    <nav className="wd-tabs" aria-label="工作详情视图">{[['overview','进展'],['code','仓库与 Worktree'],['assets','资产'],['runs','后台任务']].map(([key,label])=><button key={key} aria-pressed={tab===key} onClick={()=>setTabs(v=>({...v,[work.root]:key}))}>{label}{key==='code'&&detail&&<small>{detail.members.length}</small>}</button>)}</nav>
    <WorkRuns key={work.root} root={work.root} active={active&&tab==='runs'} connections={connections} onConnections={onConnections}/>
    {error&&<p role="alert" className="error-text">{error}</p>}
    {!detail&&loading===work.root&&<div className="inline-loading"><Spinner size={14}/>读取当前工作记录与 Git 状态…</div>}
    {detail&&<><p className="wd-caption">{loading===work.root?'正在刷新，暂显示上次结果':`读取于 ${time(detail.fetchedAt)}`}</p>
      {tab==='overview'&&<div className="wd-overview">
        {record.goal&&<p className="wd-goal">{record.goal.text}</p>}
        <div className="wd-provenance"><span>文件修改 {time(detail.modifiedAt)}</span><span>文档登记 {record.recorded||'未填写'}</span></div>
        <p className="wd-caption">以下是文档记录；运行中的会话请在「活跃会话」查看。</p>
        {record.current&&<section className="wd-section"><div className="wd-heading"><h3>当前进展</h3><button onClick={()=>source(record.current?.anchor)}>来源 <ArrowUpRight size={12}/></button></div><p>{record.current.text}</p></section>}
        {!!record.pending.length&&<section className="wd-section wd-attention"><h3>未决与下一步</h3>{record.pending.map((f,i)=><div key={i}><span className="wd-caption">{f.label} · {f.section}</span><p>{f.text}</p><button className="text-action" onClick={()=>source(f.anchor)}>查看来源 <ArrowUpRight size={12}/></button></div>)}</section>}
        {!!record.tasks.length&&<section className="wd-section"><h3>文档待办 · {record.tasks.length}</h3><ul>{record.tasks.map((task,i)=><li key={i}>{task}</li>)}</ul></section>}
        <p className="wd-caption">{record.completed} 项已勾选 · {record.tasks.length} 项未勾选；勾选数不代表工作已验收。</p>
        {!!record.latest.length&&<section className="wd-section"><h3>最近记录</h3>{record.latest.slice(0,3).map((s,i)=><details className="wd-record" key={s.title} open={isOpen(s.title)} onToggle={e=>toggle(s.title,e.currentTarget.open)}><summary>{s.title}<span>{i===0?'最新':''}</span></summary><Document content={s.content} onError={onError} onNavigate={href=>void navigate(href)}/><button className="text-action" onClick={()=>source(s.anchor)}>在 SESSION.md 中查看 <ArrowUpRight size={12}/></button></details>)}</section>}
        {!!record.checks.length&&<details className="wd-record" open={isOpen('checks')} onToggle={e=>toggle('checks',e.currentTarget.open)}><summary>验收与范围 <span>文档记录</span></summary>{record.checks.map((f,i)=><div key={i}><h4>{f.label}</h4><p>{f.text}</p></div>)}</details>}
        {!record.current&&!record.goal&&record.sections.length>0&&<section className="wd-section"><h3>{record.sections[0].title}</h3><p>{plainText(record.sections[0].content).slice(0,1000)}</p></section>}
        <div className="wd-actions"><Button variant="secondary" compact onClick={()=>source()}><FileText size={13}/>完整记录</Button><Button variant="secondary" compact onClick={()=>onCommand('/work-continue')}>继续工作</Button><Button variant="secondary" compact onClick={()=>onCommand('/work-review')}>检查工作</Button></div>
      </div>}
      {tab==='code'&&<div className="wd-code"><p className="wd-caption">{groups.length} 个仓库 · {detail.members.length} 个登记 Worktree。远端分支基于本机缓存，未执行 fetch。</p>
        {!groups.length&&<p className="empty-line">此工作尚未登记 Git 成员。可继续查看工作记录与文件资产。</p>}
        {groups.map(group=><section className="wd-repository" key={group.repo}><header><GitBranch size={15}/><strong>{group.repo.split('/').filter(Boolean).at(-1)?.replace(/\.git$/,'')}</strong><span>{group.members.length} Worktree</span></header><p className="wd-caption wd-wrap">{group.repo}</p>
          {group.members.map(member=><article className="wd-member" key={member.name}>
            <h3>{member.name}</h3><button className="wd-path" title="复制 Worktree 路径" onClick={()=>void api.copyText(member.path).catch(onError)}><span>{member.path}</span><Copy size={12}/></button>
            <p className="wd-branch"><GitBranch size={13}/><strong>{member.branch}</strong><code title={member.head}>{short(member.head)}</code></p>
            {member.branch!==member.registeredBranch&&<p className="wd-warning">登记分支：{member.registeredBranch}。与当前分支不同。</p>}
            {member.detailError?<p className="error-text">{member.detailError}</p>:<>
              <dl className="wd-facts"><dt>登记基线</dt><dd>{member.base&&member.base!==member.baseSha&&<span>{member.base} </span>}<code title={member.baseSha}>{short(member.baseSha)}</code></dd><dt>相对基线</dt><dd>{member.baseAhead==null?'无法比较':`当前分支独有 ${member.baseAhead} · 基线独有 ${member.baseBehind}`}</dd><dt>上游缓存</dt><dd>{member.upstream?`${member.upstream} · ${member.ahead==null?'无法比较':`领先 ${member.ahead} / 落后 ${member.behind}`}`:'未跟踪上游'}</dd><dt>MR 登记</dt><dd>{member.mr?<button className="text-action" onClick={()=>show(member,'mr')}>{/^https:/.test(member.mr)?'!'+member.mr.split('/').filter(Boolean).at(-1):'!'+member.mr} · 查询远端状态</button>:'未登记'}</dd></dl>
              {member.counts&&<button className={`wd-change-counts ${member.counts.conflicts?'wd-warning':''}`} onClick={()=>show(member,'changes')} aria-label={`查看 ${member.name} 改动`}><span>{member.counts.staged} 暂存</span><span>{member.counts.unstaged} 未暂存</span><span>{member.counts.untracked} 未跟踪</span><span>{member.counts.conflicts} 冲突</span></button>}
              {member.statusTruncated&&<p className="wd-warning">文件数量较多，以上为已读取部分。</p>}
              <div className="wd-actions"><button onClick={()=>show(member,'diff','baseline')}>基线差异</button><button onClick={()=>show(member,'commits')}>提交记录</button><button onClick={()=>show(member,'branches')}>分支列表</button><button onClick={()=>show(member,'worktrees')}>同仓 Worktree</button><button onClick={()=>setDirectory('repos/'+member.name)}>浏览文件</button></div>
            </>}
          </article>)}
        </section>)}
        {!!detail.issues.length&&<details className="wd-record"><summary>登记检查 <span>{detail.issues.length} 项</span></summary>{detail.issues.map((issue,i)=><p key={i} className={issue.severity==='error'?'error-text':issue.severity==='warning'?'wd-warning':'wd-caption'}>{issue.member&&`${issue.member}：`}{issue.message}</p>)}</details>}
      </div>}
      {tab==='assets'&&<div className="wd-assets"><Input aria-label="搜索工作资产" placeholder="搜索笔记、会话日志、脚本或证据…" value={query} onChange={value=>setQueries(p=>({...p,[work.root]:value}))}/><p className="wd-caption">从实际目录读取 · {unindexed?`${unindexed} 项未列入 L0 索引`:'L0 索引已覆盖当前笔记和日志'}</p>
        {(Object.keys(assetLabels) as WorkAsset['kind'][]).map(kind=>{const all=detail.assets.filter(a=>a.kind===kind),rows=all.filter(a=>(a.path+' '+a.title).toLowerCase().includes(query.toLowerCase())).sort((a,b)=>(b.modifiedAt||'').localeCompare(a.modifiedAt||''));return <section className="wd-section" key={kind}><h3>{assetLabels[kind]} <span className="wd-caption">{rows.length}{query?` / ${all.length}`:''}</span></h3>{rows.map(asset=>{const related=kind==='log'?relatedHistory(asset,history):null;return <div className="wd-asset" key={asset.path}><button disabled={!!asset.unavailable||!!opening} onClick={()=>void openAsset(asset)} title={asset.unavailable||asset.path}>{opening===asset.path?<Spinner size={14}/>:asset.directory?<Folder size={14}/>:<FileText size={14}/>}<span><strong>{asset.title||asset.name}</strong><small>{asset.path}</small></span><ArrowUpRight size={12}/></button><div className="wd-asset-meta"><span>{asset.unavailable||time(asset.modifiedAt)}</span>{!asset.indexed&&kind!=='evidence'&&<span>未列入索引</span>}{related&&<button onClick={()=>onResume(related)}>继续原会话</button>}</div></div>;})}{!rows.length&&<p className="wd-caption">{query?'没有匹配项。':kind==='script'?'尚无可复用脚本。':kind==='evidence'?'SESSION.md 尚未引用 .agent-tmp 证据。':'此目录暂无记录。'}</p>}</section>;})}
        <div className="wd-actions"><Button variant="secondary" compact onClick={()=>onMemory(record.goal?.text||work.name)}><BookOpen size={13}/>检索 Stele · L3</Button><button onClick={()=>setDirectory('.')}>浏览工作根</button></div><p className="wd-caption">L2 日志与 OMP 历史并非一一对应；仅在 ID 唯一匹配时提供续聊。临时证据只列文档引用，未扫描整个临时目录。</p>
      </div>}
      {detail.warnings.map((warning,i)=><p className="wd-warning" key={i}>{warning}</p>)}
    </>}
    <Modal open={active&&!!directory} onClose={()=>setDirectory('')} title="工作文件" description={directory==='.'?work.root:work.root+'/'+directory} className="wd-file-modal"><FileBrowser key={work.root+'|'+directory} root={work.root} active={active&&!!directory} initialDirectory={directory==='.'?'':directory} onOpen={file=>{onOpen(file);setDirectory('');}} onError={onError}/></Modal>
    <GitInspector key={inspect?inspect.root+'|'+inspect.member.name:'none'} target={inspect} open={active&&!!inspect} close={()=>setInspect(null)} onError={onError} onOpen={onOpen}/>
  </div>;
}

function GitInspector({target,open,close,onError,onOpen}:{target:{root:string;member:WorkMember;action:string;scope:string}|null;open:boolean;close:()=>void;onError:(error:unknown)=>void;onOpen:(file:FilePreview)=>void}){
  const [action,setAction]=useState(target?.action||'changes'),[scope,setScope]=useState(target?.scope||'unstaged'),[data,setData]=useState<GitInspection|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{if(target){setAction(target.action);setScope(target.scope);}},[target]);
  useEffect(()=>{if(!open||!target)return;let live=true;setBusy(true);setError('');setData(null);void api.workGit(target.root,target.member.name,action,{scope}).then(value=>{if(live)setData(value);}).catch(e=>{if(live)setError(String(e));}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[target?.root,target?.member.name,action,scope,open,revision]);
  const read=async(path:string)=>{if(!target)return;try{onOpen(await api.readPreview(target.root,'repos/'+target.member.name+'/'+path));close();}catch(e){onError(e);}};
  return <Modal open={open} onClose={close} title={target?.member.name||'Git'} description="只读检查 · 不切换分支、不修改 work 登记" className="wd-git-modal"><nav className="wd-tabs" aria-label="Git 查看方式">{[['changes','工作区改动'],['diff','差异'],['commits','提交'],['branches','分支'],['worktrees','Worktree'],...(target?.member.mr?[['mr','MR']]:[])].map(([key,label])=><button key={key} aria-pressed={action===key} onClick={()=>setAction(key)}>{label}</button>)}</nav>
    {action==='diff'&&<nav className="wd-tabs" aria-label="差异范围">{[['unstaged','未暂存'],['staged','已暂存'],['baseline','登记基线 → HEAD']].map(([key,label])=><button key={key} aria-pressed={scope===key} onClick={()=>setScope(key)}>{label}</button>)}</nav>}
    {busy&&<div role="status" className="inline-loading"><Spinner size={14}/>{action==='mr'?'正在查询 MR 与流水线…':'正在读取 Git…'}</div>}{error&&<p role="alert" className="error-text">{error}</p>}
    {data&&<div className="wd-git-result">
      {data.kind==='changes'&&<><p className="wd-caption">{data.files?.length||0} 个文件 · 点击文件预览；暂存及未暂存差异在「差异」中分开查看。</p>{data.files?.map(file=><button className="wd-git-file" key={file.path} onClick={()=>void read(file.path)} disabled={file.code.includes('D')}><code>{file.code}</code><span>{file.oldPath&&`${file.oldPath} → `}{file.path}</span><small>{file.conflict?'冲突':file.untracked?'未跟踪':'预览'}</small></button>)}</>}
      {data.text!==undefined&&(data.text?<pre className="wd-git-text">{data.text}</pre>:<p className="empty-line">当前比较范围内没有差异。</p>)}
      {data.worktrees?.map(tree=><article className="wd-tree" key={tree.path}><strong>{tree.branch?.replace('refs/heads/','')||(tree.detached?'detached HEAD':tree.bare?'裸仓库':'未命名')}</strong><code>{short(tree.head)}</code><p>{tree.path}</p><small>{tree.path===target?.member.path?'当前成员': '同仓工作树'}{tree.locked?' · 已锁定':''}{tree.prunable?' · 可清理标记':''}</small><button className="icon-button" aria-label={`复制 ${tree.path}`} onClick={()=>void api.copyText(tree.path).catch(onError)}><Copy size={13}/></button></article>)}
      {data.kind==='mr'&&<><h3>{data.draft?'草稿 · ':''}{data.state}</h3><dl className="wd-facts"><dt>来源</dt><dd>{data.sourceBranch}</dd><dt>目标</dt><dd>{data.targetBranch}</dd><dt>MR HEAD</dt><dd><code>{data.sha}</code></dd><dt>流水线</dt><dd>{data.pipelineStatus||'未返回流水线'}{data.pipelineSha&&` · ${short(data.pipelineSha)}`}</dd></dl>{data.pipelineSha&&!data.pipelineMatchesHead&&<p className="wd-warning">流水线 SHA 与 MR HEAD 不同，不能视为当前版本验证结果。</p>}{data.sha&&data.sha!==target?.member.head&&<p className="wd-warning">远端 MR HEAD 与本地 HEAD 不同。</p>}{data.url&&<button className="text-action" onClick={()=>void api.openExternal(data.url!).catch(onError)}>在浏览器查看 MR <ArrowUpRight size={12}/></button>}</>}
      {data.truncated&&<p className="wd-warning">结果超过显示上限，仅展示前一部分。</p>}
    </div>}
    <div className="wd-inspector-footer"><span className="wd-caption">{data?.checkedAt?`读取于 ${time(data.checkedAt)}`:action==='branches'?'远端引用为本机缓存':' '}</span><Button variant="secondary" compact disabled={busy} onClick={()=>setRevision(v=>v+1)}><RefreshCw size={13}/>重新读取</Button></div>
  </Modal>;
}
