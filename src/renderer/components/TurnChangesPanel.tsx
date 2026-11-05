import {lazy, Suspense, useEffect, useRef, useState} from 'react';
import {ArrowUpRight, MessageSquare} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {Spinner} from '@cindy/components/ui/spinner';
import {api} from '../api';
import {errorText} from '../errors';
import type {TurnChanges} from '../types';
import {diffQuote} from './WorkspaceChanges';

const DiffView = lazy(() => import('./WorkspaceDiff'));
const time = new Intl.DateTimeFormat('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'});

export function TurnChangesPanel({sessionId, messageId, workName, canQuote, onDiscuss, onCurrent}: {
  sessionId: string;
  messageId: string;
  workName: string;
  canQuote: boolean;
  onDiscuss: (text: string) => void;
  onCurrent: () => void;
}) {
  const [snapshot, setSnapshot] = useState<TurnChanges | null>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [index, setIndex] = useState(0);
  const reader = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setSnapshot(undefined);
    setError('');
    void (api.readTurnChanges?.(sessionId, messageId) ?? Promise.resolve(null)).then(value => {
      if (live) setSnapshot(value);
    }).catch(reason => {if (live) setError(errorText(reason));});
    return () => {live = false;};
  }, [sessionId, messageId, revision]);
  const file = snapshot?.files[index];

  function discuss() {
    if (!file?.patch || !snapshot) return;
    const heading = [
      '请核对这一轮记录的改动：',
      'Work：' + workName,
      '记录时间：' + time.formatRange(snapshot.startedAt, snapshot.finishedAt),
      '仓库：' + file.member,
      '文件：' + file.path,
    ];
    onDiscuss(diffQuote(reader.current, file.patch, heading));
  }

  return <div className="workspace-files workspace-changes turn-changes">
    <div className="panel-title">
      <h2>本轮改动</h2>
      <button type="button" className="text-action" onClick={onCurrent}>当前工作区<ArrowUpRight size={13}/></button>
    </div>
    {snapshot && <p className="panel-intro">
      只读记录 · {time.formatRange(snapshot.startedAt, snapshot.finishedAt)}
    </p>}
    {error ? <div className="changes-feedback" role="alert"><p>{error}</p>
      <Button compact variant="secondary" onClick={() => setRevision(value => value + 1)}>重试</Button>
    </div> : snapshot === undefined
      ? <div className="inline-loading" role="status"><Spinner size={14}/>读取本轮改动…</div>
      : !snapshot && <p className="empty-line">这一轮的改动记录已不可用。</p>}
    {snapshot && <p className="helper-text">记录消息发送前到本轮结束时的工作树差异，可能包含同期其他操作的改动。</p>}
    {snapshot?.warnings.map(warning => <p className="helper-text" key={warning}>{warning}</p>)}
    {snapshot && snapshot.files.length > 0 && <label className="changes-file-picker">
      <span>改动文件 · {snapshot.files.length}</span>
      <select aria-label="选择本轮改动文件" value={index} onChange={event => setIndex(Number(event.target.value))}>
        {snapshot.files.map((item, position) => <option value={position} key={JSON.stringify([item.member, item.path])}>
          {item.member} / {item.path}
        </option>)}
      </select>
    </label>}
    {file?.omitted && <p className="empty-line">此文件有改动，差异正文超过记录上限或无法读取。</p>}
    {file?.patch && <div className="changes-reader" ref={reader}>
      <Suspense fallback={<div className="inline-loading"><Spinner size={14}/>载入差异阅读器…</div>}>
        <DiffView key={index} text={file.patch} split={false}/>
      </Suspense>
    </div>}
    {file?.patch && canQuote && <div className="changes-actions">
      <Button compact variant="secondary" onClick={discuss}><MessageSquare size={14}/>加入对话草稿</Button>
    </div>}
  </div>;
}
