import {lazy, Suspense, useEffect, useRef, useState} from 'react';
import {ArrowUpRight, GitBranch, MessageSquare, RefreshCw} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {Spinner} from '@cindy/components/ui/spinner';
import {api} from '../api';
import {errorText} from '../errors';
import {CodeReviewPanel} from './CodeReviewPanel';
import type {Work} from '../types';
import type {CodeReviewSource} from '../code-review-types';
import {useWorkspaceGitRead} from '../useWorkspaceGitRead';
import type {GitFile, WorkDetail} from '../work-detail-data';

const DiffView = lazy(() => import('./WorkspaceDiff'));

export function diffQuote(reader: HTMLElement | null, patch: string, context: string[], truncated = false) {
  const selected = window.getSelection();
  const excerpt = selected && reader?.contains(selected.anchorNode)
    && reader.contains(selected.focusNode) ? selected.toString().trim() : '';
  const content = excerpt || patch;
  return context.join('\n') + '\n\n' + content.slice(0, 12000)
    + (content.length > 12000 || (!excerpt && truncated) ? '\n[差异已截断]' : '');
}

function reviewEntries(files: GitFile[]) {
  return files.flatMap(file => {
    const entries: {file: string; scope: 'staged' | 'unstaged'; label: string}[] = [];
    if (file.conflict) entries.push({file: file.path, scope: 'unstaged', label: '冲突'});
    else {
      if (file.staged) entries.push({file: file.path, scope: 'staged', label: '已暂存'});
      if (file.unstaged || file.untracked) entries.push({
        file: file.path, scope: 'unstaged', label: file.untracked ? '未跟踪' : '未暂存',
      });
    }
    return entries.map(entry => ({...entry, key: JSON.stringify([entry.scope, entry.file])}));
  });
}

export function WorkspaceChanges({work, active, canQuote, onDiscuss, onOpenFiles}: {
  work: Work;
  active: boolean;
  canQuote: boolean;
  onDiscuss: (text: string) => void;
  onOpenFiles: (member: string) => void;
}) {
  const [detail, setDetail] = useState<WorkDetail>();
  const [detailError, setDetailError] = useState('');
  const [memberName, setMemberName] = useState('');
  const [selection, setSelection] = useState('');
  const [revision, setRevision] = useState(0);
  const reader = useRef<HTMLDivElement>(null);
  const root = work.root;
  const hostId = work.hostId;

  useEffect(() => {
    if (!active) return;
    let live = true;
    setDetailError('');
    void api.workDetails(root, hostId).then(next => {
      if (live) setDetail(next);
    }).catch(error => {
      if (live) {
        setDetail(undefined);
        setDetailError(errorText(error));
      }
    });
    return () => {live = false;};
  }, [active, root, hostId, revision]);

  const members = detail?.members || [];
  const member = members.find(item => item.name === memberName)
    || members.find(item => !item.detailError)
    || members[0];
  const name = member?.name || '';
  const canRead = active && !!member && !member.detailError && !detailError;
  const listing = useWorkspaceGitRead(work, name, 'changes', {}, canRead, revision);
  const files = listing.data?.files || [];
  const entries = reviewEntries(files);
  const entry = entries.find(item => item.key === selection) || entries[0];
  const diff = useWorkspaceGitRead(work, name, 'diff', {file: entry?.file, scope: entry?.scope},
    canRead && !!entry, revision);
  const patch = diff.data?.text || '';
  const reviewDisabledReason = work.hostId ? '首批代码审查仅支持本机 WSL Work。'
    : !canRead ? detailError || member?.detailError || '读取本机仓库后即可审查。'
      : listing.busy ? '正在读取当前仓库状态…'
        : !entries.length ? '当前仓库没有可审查的改动。' : undefined;
  const reviewSource: CodeReviewSource | null = !work.hostId && member && root
    ? {kind: 'workspace', root, member: name, scope: 'all'} : null;
  const currentReviewDisabledReason = work.hostId ? reviewDisabledReason
    : !active ? '打开工作区改动后即可开始审查。' : reviewDisabledReason;
  const refresh = () => setRevision(value => value + 1);
  const failure = detailError || member?.detailError || listing.error || diff.error;
  const pending = !failure && (!detail || listing.busy || diff.busy);

  function discuss() {
    if (!entry || !patch || !canQuote) return;
    const context = [
      '请核对以下工作区改动：',
      'Work：' + work.name,
      ...(work.hostName ? ['主机：' + work.hostName] : []),
      '仓库：' + name,
      '文件：' + entry.file,
      '范围：' + entry.label,
    ];
    onDiscuss(diffQuote(reader.current, patch, context, diff.data?.truncated));
  }

  return <div className="workspace-files workspace-changes">
    <div className="panel-title">
      <h2>工作区改动</h2>
      <button type="button" className="icon-button" aria-label="刷新改动" onClick={refresh}><RefreshCw size={15}/></button>
    </div>
    <p className="panel-intro">当前工作区 · 只读差异</p>
    {member && <div className="changes-repository">
      {members.length > 1
        ? <select aria-label="审阅成员仓库" value={name} onChange={event => {
          setMemberName(event.target.value);
          setSelection('');
        }}>{members.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select>
        : <span title={name}>{name}</span>}
      {member.branch && <span title={member.branch}><GitBranch size={13}/>{member.branch}</span>}
    </div>}
    {entry && <label className="changes-file-picker">
      <span>改动文件 · {new Set(files.map(file => file.path)).size}</span>
      <select aria-label="选择改动文件" value={entry.key} onChange={event => setSelection(event.target.value)}>
        {entries.map(item => <option value={item.key} key={item.key}>{item.label} · {item.file}</option>)}
      </select>
    </label>}
    {failure && <div className="changes-feedback" role="alert">
      <p>{failure}</p><Button compact variant="secondary" onClick={refresh}>重试</Button>
    </div>}
    {pending && <div className="inline-loading" role="status"><Spinner size={14}/>读取工作区改动…</div>}
    {detail && !member && !failure && <p className="empty-line">此 Work 没有已登记的 Git 仓库。</p>}
    {listing.data && !entries.length && !failure && <p className="empty-line">当前没有未提交的改动。</p>}
    {listing.data?.truncated && <p className="helper-text">只显示读取上限内的文件。</p>}
    {entry && diff.data && !failure && <div className="changes-reader" ref={reader}>
      <Suspense fallback={<div className="inline-loading"><Spinner size={14}/>载入差异阅读器…</div>}>
        <DiffView text={patch} split={false}/>
      </Suspense>
    </div>}
    {diff.data?.truncated && <p className="helper-text">差异超过读取上限，当前内容已截断。</p>}
    {!!name && <div className="changes-actions">
      {patch && canQuote && <Button compact variant="secondary" onClick={discuss}><MessageSquare size={14}/>加入对话草稿</Button>}
      <button type="button" className="text-action" onClick={() => onOpenFiles(name)}>在工作区文件中打开<ArrowUpRight size={13}/></button>
    </div>}
    <CodeReviewPanel source={reviewSource} disabledReason={currentReviewDisabledReason} canQuote={canQuote} onDiscuss={onDiscuss}/>
  </div>;
}
