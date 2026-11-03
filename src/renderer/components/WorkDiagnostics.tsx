import { CircleCheck, CircleX, Info, RefreshCw, TriangleAlert } from 'lucide-react';
import type { Work, WorkIssue } from '../types';
import { Modal } from './Modal';
import {canAccessWorkRoot} from '../../work-access.cjs';

export const workIssues = (work: Work): WorkIssue[] => work.issues?.length ? work.issues : work.kind === 'invalid' ? [{code: 'invalid', severity: 'error', message: work.error || '工作区校验失败'}] : [];

export function WorkHealthNotice({work, onOpen}: {work: Work | null; onOpen: () => void}) {
  if(work?.kind==='invalid'){
    const members=[...new Set(workIssues(work).filter(issue=>issue.severity==='error'&&issue.member).map(issue=>issue.member))];
    return canAccessWorkRoot(work)
      ? <div className="work-health-notice" role="status"><TriangleAlert size={16}/><span>工作区检查发现问题{members.length>0&&`（${members.join('、')}）`}，会话仍可读取和继续；相关 Git 操作需先修复。</span><button onClick={onOpen}>查看工作区检查</button></div>
      : <div className="notice" role="alert"><CircleX size={16}/><span>工作目录暂不可用，请刷新工作区重试。会话记录与草稿已保留。</span><button className="text-action" onClick={onOpen}>查看工作区检查</button></div>;
  }
  const warnings = work ? workIssues(work).filter(issue => issue.severity === 'warning') : [];
  if (!warnings.length) return null;
  return <div className="work-health-notice" role="status"><TriangleAlert size={16}/><span>工作区有 {warnings.length} 项登记提醒，历史、文件和终端可正常使用。</span><button onClick={onOpen}>查看详情</button></div>;
}

export function WorkDiagnostics({works, open, onClose, loading, onRefresh}: {works: Work[]; open: boolean; onClose: () => void; loading: boolean; onRefresh: () => void}) {
  const affected = works.map(work => ({work, issues: workIssues(work)})).filter(row => row.issues.length);
  const all = affected.flatMap(row => row.issues), errors = all.filter(i => i.severity === 'error').length, warnings = all.filter(i => i.severity === 'warning').length, compatible = all.filter(i => i.severity === 'info').length;
  return <Modal open={open} onClose={onClose} title="工作区检查" description="汇总所有成员的检查结果。检查只读，不切换分支、不修改 work 登记。" className="work-diagnostics-modal">
    <div className="work-check-summary"><span>{works.length} 个工作区 · {errors} 项需修复 · {warnings} 项提醒 · {compatible} 项兼容记录</span><button className="icon-button" aria-label="重新检查工作区" disabled={loading} onClick={onRefresh}><RefreshCw size={15}/></button></div>
    <div className="work-check-list">{affected.map(({work, issues}) => <section className="work-check-group" key={work.root}>
      <h3>{work.name}</h3><p className="work-check-path">{work.root}</p>
      <ul>{issues.map((issue, index) => <li key={`${issue.code}-${issue.member}-${index}`} data-severity={issue.severity}>
        {issue.severity === 'error' ? <CircleX size={16}/> : issue.severity === 'warning' ? <TriangleAlert size={16}/> : <Info size={16}/>}
        <div><div className="work-check-label"><strong>{issue.member || '工作根'}</strong><span>{issue.severity === 'error' ? '需修复' : issue.severity === 'warning' ? '登记提醒' : '已兼容'}</span></div><p>{issue.message}</p>
          {(issue.actual !== undefined || issue.expected !== undefined) && <dl>{issue.actual !== undefined && <><dt>{issue.code === 'mr_numeric' ? 'MR' : '当前'}</dt><dd>{issue.actual}</dd></>}{issue.expected !== undefined && <><dt>登记</dt><dd>{issue.expected}</dd></>}</dl>}
        </div>
      </li>)}</ul>
    </section>)}{!affected.length && <p className="work-check-empty"><CircleCheck size={20}/>{loading?'正在检查工作区…':'本次本地检查未发现问题。'}</p>}</div>
    <p className="work-check-footnote">Git 与登记问题不影响会话读取和续聊；相关 Git 操作仍需通过仓库检查。工作目录不可访问时需要先恢复目录。远端 MR 和 CI 状态不在本次检查范围。</p>
  </Modal>;
}
