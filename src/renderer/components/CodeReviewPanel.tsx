import {lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, Bot, Check, ChevronDown, Clock3, Code2, FileCode2, LoaderCircle, MessageSquare, RotateCcw, ShieldAlert, Sparkles, Square} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {Spinner} from '@cindy/components/ui/spinner';
import {api} from '../api';
import {errorText} from '../errors';
import type {CodeReviewFinding, CodeReviewRun, CodeReviewSource} from '../code-review-types';
import '../code-review.css';

const DiffView = lazy(() => import('./WorkspaceDiff'));
const time = new Intl.DateTimeFormat('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
const activeStatuses = new Set(['queued', 'capturing', 'running', 'stopping']);
const statusText: Record<CodeReviewRun['status'], string> = {
  queued: '排队中', capturing: '固定改动快照', running: '正在审查', stopping: '正在停止',
  cancelled: '已停止', completed: '审查完成', failed: '审查失败', interrupted: '任务中断',
};
const severityText: Record<CodeReviewFinding['severity'], string> = {high: '高', medium: '中', low: '低'};

function sourceKey(source: CodeReviewSource | null) { return source ? JSON.stringify(source) : ''; }
function active(run?: CodeReviewRun) { return !!run && activeStatuses.has(run.status); }

export function CodeReviewPanel({source, disabledReason, canQuote, onDiscuss}: {
  source: CodeReviewSource | null;
  disabledReason?: string;
  canQuote: boolean;
  onDiscuss: (text: string) => void;
}) {
  const sourceRef = useRef('');
  const [workspaceScope, setWorkspaceScope] = useState<'all' | 'staged' | 'unstaged'>('all');
  const effectiveSource = useMemo<CodeReviewSource | null>(() => source?.kind === 'workspace'
    ? {...source, scope: workspaceScope}
    : source, [source?.kind, source?.kind === 'workspace' ? source.root : '', source?.kind === 'workspace' ? source.member : '', source?.kind === 'turn' ? source.sessionId : '', source?.kind === 'turn' ? source.messageId : '', workspaceScope]);
  const key = sourceKey(effectiveSource);
  sourceRef.current = key;
  const [runs, setRuns] = useState<CodeReviewRun[] | undefined>();
  const [selectedId, setSelectedId] = useState('');
  const selectedRef = useRef('');
  selectedRef.current = selectedId;
  const [run, setRun] = useState<CodeReviewRun>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const readSerial = useRef(0);
  const [selectedFileId, setSelectedFileId] = useState('');
  const [focusedFinding, setFocusedFinding] = useState<CodeReviewFinding>();
  const diffReader = useRef<HTMLDivElement>(null);
  const [snapshotExpanded, setSnapshotExpanded] = useState(false);

  const remember = useCallback((next: CodeReviewRun) => {
    setRun(next);
    setRuns(previous => [next, ...(previous || []).filter(item => item.id !== next.id)].slice(0, 8));
  }, []);

  useEffect(() => {
    let live = true;
    setRuns(undefined);
    setRun(undefined);
    setSelectedId('');
    setSelectedFileId('');
    setFocusedFinding(undefined);
    setSnapshotExpanded(false);
    setError('');
    setBusy(false);
    if (!effectiveSource || typeof api.listCodeReviews !== 'function') {
      setRuns([]);
      return () => {live = false;};
    }
    const requestKey = key;
    void api.listCodeReviews(effectiveSource).then(rows => {
      if (!live || sourceRef.current !== requestKey) return;
      const matching = rows.filter(item => sourceKey(item.source) === requestKey)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      setRuns(matching.slice(0, 8));
      setSelectedId(matching[0]?.id || '');
    }).catch(reason => {
      if (live && sourceRef.current === requestKey) {setError(errorText(reason));setRuns([]);}
    });
    return () => {live = false;};
  }, [key, effectiveSource]);

  useEffect(() => {
    const readCodeReview = api.readCodeReview;
    if (!selectedId || typeof readCodeReview !== 'function') { setRun(undefined); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requestKey = key;
    const requestRunId = selectedId;
    const requestSerial = ++readSerial.current;
    const read = async () => {
      try {
        const next = await readCodeReview(requestRunId);
        if (!live || sourceRef.current !== requestKey || selectedRef.current !== requestRunId || readSerial.current !== requestSerial) return;
        remember(next);
        if (active(next)) timer = setTimeout(read, 1500);
      } catch (reason) {
        if (live && sourceRef.current === requestKey && selectedRef.current === requestRunId && readSerial.current === requestSerial) setError(errorText(reason));
      }
    };
    void read();
    return () => {live = false; if (timer) clearTimeout(timer);};
  }, [key, selectedId, remember, readRevision]);

  useEffect(() => {
    if (source?.kind !== 'workspace') return;
    setWorkspaceScope('all');
  }, [source?.kind, source?.kind === 'workspace' ? source.root : '', source?.kind === 'workspace' ? source.member : '']);

  const snapshot = run?.snapshot;
  const files = snapshot?.files || [];
  const visibleFiles = files.filter(file => file.patch);
  const analyzedCount = files.filter(file => file.patch && !file.omitted).length;
  const file = visibleFiles.find(item => item.id === selectedFileId) || visibleFiles[0];
  const openFindings = run?.findings.filter(item => item.status === 'open') || [];
  const latestBusy = runs?.find(active);
  const editableSource = effectiveSource;
  const canStart = !!editableSource && !disabledReason && !busy && !error && runs !== undefined && !latestBusy
    && (source?.kind !== 'turn' || !!source);

  async function start() {
    if (!editableSource || !canStart || typeof api.startCodeReview !== 'function') return;
    const requestKey = key;
    setBusy(true);
    setError('');
    try {
      const next = await api.startCodeReview(editableSource);
      if (sourceRef.current === requestKey) {
        remember(next);
        setSelectedId(next.id);
      }
    } catch (reason) {
      if (sourceRef.current === requestKey) setError(errorText(reason));
    } finally { if (sourceRef.current === requestKey) setBusy(false); }
  }

  async function cancel() {
    if (!run || typeof api.cancelCodeReview !== 'function') return;
    const requestKey = key;
    const requestRunId = run.id;
    readSerial.current++;
    setBusy(true);
    setError('');
    try {
      const next = await api.cancelCodeReview(requestRunId);
      if (sourceRef.current === requestKey && selectedRef.current === requestRunId) {remember(next);setReadRevision(value=>value+1);}
    } catch (reason) {
      if (sourceRef.current === requestKey && selectedRef.current === requestRunId) setError(errorText(reason));
    } finally {
      if (sourceRef.current === requestKey && selectedRef.current === requestRunId) setBusy(false);
    }
  }

  async function updateFinding(finding: CodeReviewFinding, status: 'open' | 'ignored') {
    if (!run || typeof api.updateCodeReviewFinding !== 'function') return;
    const requestKey = key;
    const requestRunId = run.id;
    readSerial.current++;
    setError('');
    try {
      const next = await api.updateCodeReviewFinding(requestRunId, finding.id, status);
      if (sourceRef.current === requestKey && selectedRef.current === requestRunId) {remember(next);setReadRevision(value=>value+1);}
    } catch (reason) {
      if (sourceRef.current === requestKey && selectedRef.current === requestRunId) setError(errorText(reason));
    }
  }

  function discuss(finding: CodeReviewFinding) {
    if (!run || !snapshot || !canQuote) return;
    const sourceLabel = run.source.kind === 'turn' ? `会话消息 ${run.source.messageId}` : `${run.source.member} · ${run.source.scope}`;
    const reviewedFile = snapshot.files.find(item => item.id === finding.fileId);
    const lines = [
      '请处理这条代码审查问题，先核对当前代码是否仍与审查快照一致，再决定修改：',
      `审查快照：${snapshot.id.slice(0, 16)} · ${sourceLabel}`,
      `仓库与文件：${reviewedFile?.member || ''}/${reviewedFile?.path || ''}${finding.lineStart ? `:${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ''}` : ''}`,
      `等级：${severityText[finding.severity]} · ${finding.title}`,
      finding.body,
      finding.evidence ? `代码证据：${finding.evidence}` : '',
      finding.suggestion ? `修复建议：\n${finding.suggestion}` : '',
    ].filter(Boolean);
    onDiscuss(lines.join('\n\n').slice(0, 12000));
  }

  function locate(finding: CodeReviewFinding) {
    const target = files.find(item => item.id === finding.fileId);
    if (!target) return;
    setSelectedFileId(target.id);
    setFocusedFinding(finding);
    setSnapshotExpanded(true);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const selector = finding.lineStart ? '.code-review-focused-line' : '.wf-diff-file';
      diffReader.current?.querySelector(selector)?.scrollIntoView({block: 'center', behavior: 'smooth'});
    }));
  }

  const label = source?.kind === 'turn' ? '本轮改动' : '未提交改动';

  return <section className="code-review" aria-label="代码审查">
    <header className="code-review-heading">
      <div className="code-review-title"><ShieldAlert size={16}/><h3>代码审查</h3>
        {runs?.length ? <span className="code-review-count">{runs.length} 次</span> : null}
      </div>
      {run && active(run)
        ? <Button compact variant="secondary" disabled={busy || run.status === 'stopping'} onClick={() => void cancel()}><Square size={13}/>停止</Button>
        : <Button compact variant="secondary" disabled={!canStart} onClick={() => void start()}>
          {busy ? <Spinner size={14}/> : runs?.length ? <RotateCcw size={14}/> : <Sparkles size={14}/>}
          {busy ? '启动中' : runs?.length ? `重新审查${label}` : `审查${label}`}
        </Button>}
    </header>
    {source?.kind === 'workspace' && <label className="code-review-scope">
      <span>审查当前仓库的</span>
      <select aria-label="选择未提交改动范围" value={workspaceScope} onChange={event => setWorkspaceScope(event.target.value as typeof workspaceScope)}>
        <option value="all">全部改动（暂存 + 未暂存）</option>
        <option value="staged">仅已暂存</option>
        <option value="unstaged">仅未暂存和新文件</option>
      </select>
    </label>}
    {source?.kind === 'workspace' && <p className="code-review-note">覆盖 {source.member} · 差异按每个文件分别冻结。</p>}
    {disabledReason && <p className="code-review-unavailable" role="status">{disabledReason}</p>}
    {!source && !disabledReason && <p className="code-review-unavailable" role="status">改动记录载入后可开始审查。</p>}
    {runs === undefined && source && <div className="code-review-progress" role="status"><Spinner size={14}/>读取审查记录…</div>}
    {!!runs && runs.length > 1 && <label className="code-review-history"><span>审查记录</span>
          <select aria-label="选择历史审查记录" value={selectedId} disabled={busy} onChange={event => {
        setSelectedId(event.target.value);
        setSelectedFileId('');
        setFocusedFinding(undefined);
      }}>{runs.map(item => <option key={item.id} value={item.id}>{time.format(item.createdAt)} · {statusText[item.status]}</option>)}</select>
    </label>}
    {error && <div className="code-review-error" role="alert"><p>{error}</p>
      {effectiveSource && <button type="button" className="text-action" onClick={() => {
        setError('');
        setRuns(undefined);
        setSelectedId('');
        void api.listCodeReviews?.(effectiveSource).then(rows => {
          if (sourceRef.current === key) {setRuns(rows);setSelectedId(rows[0]?.id || '');}
        }).catch(reason => {if(sourceRef.current===key)setError(errorText(reason));});
      }}>重试</button>}
    </div>}
    {run && <>
      <div className="code-review-status" data-state={run.status} role="status">
        {active(run) ? <LoaderCircle size={14} className="code-review-spinner"/>
          : run.status === 'completed' ? <Check size={14}/>
            : run.status === 'failed' || run.status === 'interrupted' ? <AlertTriangle size={14}/>
              : <Clock3 size={14}/>}
        <strong>{statusText[run.status]}</strong>
        <time dateTime={new Date(run.updatedAt).toISOString()}>{time.format(run.updatedAt)}</time>
      </div>
      {active(run) && run.stage && <p className="code-review-stage">{run.stage}</p>}
      {run.error && <p className="code-review-error-text" role="alert">{run.error}</p>}
      {snapshot && <div className="code-review-coverage">
        <span><Code2 size={14}/>{snapshot.files.length} 个改动项</span>
        <span><FileCode2 size={14}/>{run.status === 'completed' ? '已分析' : '送审范围'} {analyzedCount} 项</span>
        <span className={snapshot.partial ? 'is-warning' : ''}>
          {snapshot.partial ? <AlertTriangle size={14}/> : <Check size={14}/>}
          {snapshot.partial ? '部分范围' : '完整记录'}
        </span>
        {run.engine && <span title={run.engine.id}><Bot size={14}/>{run.engine.model}</span>}
      </div>}
      {snapshot?.partial && <p className="code-review-partial" role="status">快照不完整，以下问题仅基于实际保存的差异；请展开查看遗漏内容。</p>}
      {!!snapshot?.warnings.length && <details className="code-review-warnings">
        <summary>快照说明 · {snapshot.warnings.length} 条</summary>
        <ul>{snapshot.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
      </details>}
      {!!snapshot?.context && <details className="code-review-context">
        <summary>审查使用的工作要求</summary><p>{snapshot.context}</p>
      </details>}
      {snapshot && !files.length && active(run) && <div className="code-review-progress" role="status"><Spinner size={14}/>正在捕获代码上下文…</div>}
      {run.status === 'completed' && run.findings.length === 0 && <p className="code-review-clean" role="status">
        {snapshot?.partial ? '已完成当前保存范围的审查，未发现问题。快照有遗漏，请勿据此判断完整通过。' : '审查完成，未发现需要标注的问题。'}
      </p>}
      {run.status === 'completed' && run.findings.length > 0 && run.findings.every(item => item.status === 'ignored')
        && <p className="code-review-clean" role="status">审查完成；所有问题已忽略。</p>}
      <p className="code-review-note">基于所选差异；未运行测试。</p>
      {!!run.reusedFrom && <p className="code-review-note">此结果复用了相同快照的审查 {run.reusedFrom.slice(0, 12)}。</p>}
      {!!run.warnings?.length && <details className="code-review-warnings">
        <summary>审查说明 · {run.warnings.length} 条</summary>
        <ul>{run.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
      </details>}
      {run.findings.length > 0 && <div className="code-review-findings">
        <div className="code-review-section-heading"><h4>发现的问题</h4><span>{openFindings.length} 项待处理</span></div>
        {run.findings.map(finding => <article className="code-review-finding" key={finding.id} data-status={finding.status}>
          <div className="code-review-finding-heading">
            <span className="code-review-severity" data-severity={finding.severity}>{severityText[finding.severity]}</span>
            <button type="button" className="code-review-finding-toggle" aria-expanded={focusedFinding?.id === finding.id}
              onClick={() => setFocusedFinding(previous => previous?.id === finding.id ? undefined : finding)}>
              <span>{finding.title}</span><ChevronDown size={14}/>
            </button>
          </div>
          <p className="code-review-finding-location">
            {files.find(item => item.id === finding.fileId)?.member} / {files.find(item => item.id === finding.fileId)?.path}
            {finding.lineStart ? `:${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `–${finding.lineEnd}` : ''}` : ' · 文件级'}
          </p>
          {focusedFinding?.id === finding.id && <div className="code-review-finding-detail">
            <p>{finding.body}</p>
            {!!finding.evidence && <blockquote><span>代码证据</span><code>{finding.evidence}</code></blockquote>}
            {!!finding.suggestion && <details><summary>查看修复建议</summary><pre>{finding.suggestion}</pre></details>}
            <div className="code-review-finding-actions">
              {finding.lineStart ? <Button compact variant="secondary" onClick={() => locate(finding)}><Code2 size={13}/>定位代码</Button>
                : files.some(item => item.id === finding.fileId) && <Button compact variant="secondary" onClick={() => locate(finding)}><Code2 size={13}/>查看文件差异</Button>}
              {canQuote && <Button compact variant="secondary" onClick={() => discuss(finding)}><MessageSquare size={13}/>加入修复草稿</Button>}
              <button type="button" className="text-action" onClick={() => void updateFinding(finding, finding.status === 'ignored' ? 'open' : 'ignored')}>
                {finding.status === 'ignored' ? <><RotateCcw size={13}/>恢复</> : <><Check size={13}/>忽略</>}
              </button>
            </div>
          </div>}
        </article>)}
      </div>}
      {snapshot && <div className="code-review-snapshot">
        <Button compact variant="secondary" aria-expanded={snapshotExpanded} onClick={() => setSnapshotExpanded(value => !value)}>
          <Code2 size={13}/>{snapshotExpanded ? '收起审查快照' : `查看固定审查快照 · ${snapshot.files.length} 项`}
        </Button>
        {snapshotExpanded && <div className="code-review-snapshot-content">
          {visibleFiles.length > 0 && <label className="code-review-file-select"><span>差异文件 · {visibleFiles.length} 项</span>
            <select aria-label="选择审查快照中的代码差异" value={file?.id || ''} onChange={event => setSelectedFileId(event.target.value)}>
              {visibleFiles.map(item => <option key={item.id} value={item.id}>{item.member} / {item.path} · {item.scope === 'turn' ? '本轮' : item.scope === 'staged' ? '已暂存' : '未暂存'}{item.omitted ? ' · 记录不完整' : ''}</option>)}
            </select>
          </label>}
          {file?.patch && <div className="changes-reader code-review-reader" ref={diffReader}>
            <Suspense fallback={<div className="code-review-progress" role="status"><Spinner size={14}/>正在载入固定差异…</div>}>
              <div className="code-review-diff"><DiffView text={file.patch} split={false}
                focusRange={focusedFinding?.fileId === file.id && focusedFinding.lineStart ? [focusedFinding.lineStart, focusedFinding.lineEnd || focusedFinding.lineStart] : undefined}/></div>
            </Suspense>
          </div>}
          {files.filter(item => !item.patch).length > 0 && <ul className="code-review-omitted-files">
            {files.filter(item => !item.patch).map(item => <li key={item.id}>{item.member} / {item.path} · 差异未保存</li>)}
          </ul>}
        </div>}
      </div>}
      {!!snapshot && run.findings.length > 0 && <p className="code-review-snapshot-id">快照 {snapshot.id.slice(0, 16)}{run.usage ? ` · ${run.usage.inputTokens + run.usage.outputTokens} tokens` : ''}</p>}
    </>}
    {source?.kind === 'workspace' && runs?.length === 0 && !disabledReason && <p className="code-review-empty"><Code2 size={14}/>审查当前选中仓库的全部文件差异，结果会保留在这里。</p>}
  </section>;
}
