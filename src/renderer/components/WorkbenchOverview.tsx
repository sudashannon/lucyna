import {ArrowUpRight, GitPullRequest} from 'lucide-react';
import {useMemo} from 'react';
import {workRecord} from '../work-detail-data';
import type {TurnChangeSummary, Work} from '../types';
import {Document, type DocumentMedia} from './Document';

export function WorkbenchOverview({work, document, summary, review, waiting, onReview, onSession, onDetails, ...media}: DocumentMedia & {
  work: Work | null;
  document: string;
  summary?: string;
  review?: TurnChangeSummary;
  waiting: {id: string; title: string}[];
  onReview: (id: string) => void;
  onSession: (id: string) => void;
  onDetails: () => void;
  onError: (error: unknown) => void;
}) {
  const record=useMemo(()=>workRecord(document),[document]);
  if (!work) return <p className="empty-line">选择 Work 后查看目标与进展。</p>;
  return <div className="workbench-overview">
    <section>
      <h3>当前目标</h3>
      {record.goal?<Document content={record.goal.markdown} {...media}/>:<p>尚未登记目标。</p>}
    </section>
    <section>
      <h3>最近进展</h3>
      <div className="workbench-progress-document" tabIndex={0} role="region" aria-label="最近进展正文">
        <Document content={summary || record.current?.markdown || record.latest[0]?.title || '暂无进展记录。'} {...media}/>
      </div>
      {review&&<button className="overview-link" onClick={()=>onReview(review.messageId)}>
        <GitPullRequest size={15}/>查看本轮改动{review.files>0&&` · ${review.files} 个文件`}
      </button>}
    </section>
    {(waiting.length>0||record.pending.length>0)&&<section>
      <h3>需要你处理</h3>
      {waiting.map(session=><button key={session.id} className="overview-link" onClick={()=>onSession(session.id)}>
        <span className="overview-attention" aria-hidden="true"/>{session.title}
      </button>)}
      {record.pending.slice(0,3).map((item,index)=><Document key={index} content={item.markdown} {...media}/>)}
    </section>}
    <button className="overview-link" onClick={onDetails}>打开完整工作详情<ArrowUpRight size={13}/></button>
  </div>;
}
