import {useState} from 'react';

export type FileDelta={path:string;beforeSha:string;afterSha:string;diff:string;added:number;removed:number;truncated?:boolean};
type Candidate={id:string;generation:number;state:string;training:number|null;validation:number|null;trainingOutput?:string;validationOutput?:string;error?:string;lastTool?:string;changes:FileDelta[]};
export type Evolution={agent?:string;framework:string;phase:string;iteration?:number;iterations?:number;baseline?:number;bestScore?:number;bestCandidate?:string;eligible?:boolean;promotion?:string;candidates:Candidate[];changes?:FileDelta[];history?:number[];usageEstimated?:boolean};
const pct=(n:number|null|undefined)=>n==null?'未评估':`${Math.round(n*100)}%`;
const candidateStates:Record<string,string>={evaluating:'评估中',proposing:'生成中',proposed:'待评估',pending:'已评估',evolving:'继续优化',unavailable:'未入选',failed:'未完成'};

export function FileChanges({changes}:{changes:FileDelta[]}){
  if(!changes.length)return null;
  return <div className="wr-diffs">{changes.map(delta=><details key={delta.path}>
    <summary><span>{delta.path}</span><span className="wr-added">+{delta.added}</span><span className="wr-removed">−{delta.removed}</span></summary>
    <pre aria-label={`${delta.path} 文件差异`}>{delta.diff.split('\n').map((line,index)=><span key={index} className={line.startsWith('+')?'wr-diff-add':line.startsWith('-')?'wr-diff-remove':''}>{line}{'\n'}</span>)}</pre>
    {delta.truncated&&<p className="wd-caption">差异已截断，采纳前请检查完整文件。</p>}
  </details>)}</div>;
}

export function RunStages({state,phase,evolution}:{state:string;phase?:string;evolution:boolean}){
  const labels=evolution?['准备快照','评估基线','迭代 Work','独立检查','查看与采纳']:['准备','执行任务','检查结果','完成'];
  const stage=evolution?({baseline:1,proposing:2,evaluating:3,review:4,applied:4,rolled_back:4}[phase||'']??0):({queued:0,starting:0,running:1,waiting_user:1,paused:1,interrupted:1,verifying:2,waiting_review:2,completed:3}[state]??0);
  const halted=['paused','interrupted','cancelled','failed','waiting_user','waiting_review'].includes(state);
  return <ol className="wr-stages" aria-label="执行阶段">{labels.map((label,index)=><li key={label} className={index===stage?`current ${halted?'halted':''}`:index<stage?'done':''} aria-current={index===stage?'step':undefined}><i>{index<stage?'✓':index+1}</i><span>{label}</span></li>)}</ol>;
}

export function EvolutionView({value}:{value:Evolution}){
  const [selected,setSelected]=useState('');
  const candidate=value.candidates.find(c=>c.id===selected)||value.candidates.find(c=>c.id===value.bestCandidate)||value.candidates.at(-1);
  const series=value.candidates.filter(c=>c.validation!=null);
  const label=(c:Candidate)=>c.generation===0?'基线':`候选 ${value.candidates.indexOf(c)}`;
  const position=(i:number)=>36+(i/Math.max(1,series.length-1))*264;
  const promotion:Record<string,string>={pending:'候选尚未写入 Work',applied:'已采纳 · 可回退',rolled_back:'已回退到采纳前',unchanged:'保留原方案'};
  return <section className="wr-evolution" aria-label="AntOmniEvo 实验结果">
    <div className="wr-section-title"><strong>AntOmniEvo</strong><span>{value.iteration??0} / {value.iterations??'—'} 轮</span></div>
    <div className="wr-scorecards"><div><span>基线 · 留出检查</span><strong>{pct(value.baseline??value.candidates.find(c=>c.generation===0)?.validation)}</strong></div><div><span>最佳 · 留出检查</span><strong>{pct(value.bestScore??(series.length?Math.max(...series.map(c=>c.validation!)):null))}</strong></div></div>
    {series.length>0&&<figure className="wr-chart"><svg viewBox="0 0 330 128" role="img" aria-label="各候选的独立留出检查得分，范围零到百分之百">
      {[0,0.5,1].map(t=><g key={t}><line x1="36" x2="312" y1={102-t*80} y2={102-t*80} className="wr-gridline"/><text x="0" y={106-t*80}>{t*100}%</text></g>)}
      <polyline points={series.map((c,i)=>`${position(i)},${102-c.validation!*80}`).join(' ')} className="wr-scoreline"/>
      {series.map((c,i)=><g key={c.id}><circle cx={position(i)} cy={102-c.validation!*80} r="4"/><text x={position(i)} y="122" textAnchor="middle">{label(c)}</text></g>)}
    </svg><figcaption>只绘制实际完成的留出检查；未评估的候选不补分。</figcaption></figure>}
    <p className="wr-promotion" role="status">{promotion[value.promotion||'']||'实验在副本中进行，原 Work 保持不变'}</p>
    <div className="wr-candidates" role="list" aria-label="选择候选查看证据">{value.candidates.map(c=><button type="button" role="listitem" key={c.id} aria-pressed={candidate?.id===c.id} onClick={()=>setSelected(c.id)}>
      <span><strong>{label(c)}</strong><small>{c.generation===0?'对照基线':candidateStates[c.state]||c.state}</small></span>
      <span>训练 <b>{pct(c.training)}</b></span><span>留出 <b>{pct(c.validation)}</b></span>
    </button>)}</div>
    {candidate&&<div className="wr-candidate-detail"><p className="wd-caption">{label(candidate)} · {candidate.id.slice(0,12)}{candidate.lastTool?` · ${candidate.lastTool}`:''}</p>
      {candidate.error&&<p className="wd-warning">{candidate.error}</p>}
      <FileChanges changes={candidate.changes||[]}/>
      {(['training','validation'] as const).map(split=>candidate[split+'Output' as 'trainingOutput'|'validationOutput']&&<details key={split}><summary>{split==='training'?'训练':'留出'}检查证据 · {pct(candidate[split])}</summary><pre>{candidate[split+'Output' as 'trainingOutput'|'validationOutput']}</pre></details>)}
    </div>}
  </section>;
}
