import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Copy, FileText, Maximize2, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@cindy/components/ui/button';
import { Input } from '@cindy/components/ui/input';
import { Spinner } from '@cindy/components/ui/spinner';
import { api } from '../api';
import type { FilePreview, Work, WorkEvent } from '../types';
import { documentHeadings, parseMemory, plainText, workOutline } from '../panel-data';
import { Document } from './Document';
import { Modal } from './Modal';
import { FileBrowser } from './FileBrowser';
import { captureReaderPosition, restoreReaderPosition, type ReaderPosition } from '../reader-position';

// Keep inactive tabs mounted, including expanded cards and document selection.
export function PanelPage({name, active, identity, children}: {name: string; active: boolean; identity: string; children: ReactNode}) {
  const host = useRef<HTMLDivElement>(null), positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {const el = host.current!; if (active) el.scrollTop = positions.current.get(identity) || 0;}, [active, identity]);
  return <div ref={host} className="panel-content" id={`tool-panel-${name}`} role="tabpanel" aria-labelledby={`tab-${name}`} hidden={!active} onScroll={e => {if (active) positions.current.set(identity, e.currentTarget.scrollTop);}}>{children}</div>;
}

export function MemoryResults({text, onQuote, canQuote, onError}: {text: string; onQuote: (text: string) => void; canQuote: boolean; onError: (e: unknown) => void}) {
  const parsed = useMemo(() => parseMemory(text), [text]);
  return <div className="memory-results">
    {parsed.hits.length > 0 && <p className="results-caption">{parsed.hits.length} 条知识 · 引用后可在输入框编辑</p>}
    {parsed.extra.some(s => s.stale) && <p className="memory-warning">部分关联知识已标记过期，使用前请展开下方核实提示。</p>}
    {parsed.hits.map((hit, i) => <article className="memory-card" key={`${hit.source}-${i}`}>
      <h3>{hit.title}</h3><div className="memory-tags">{hit.tags.slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}{hit.tags.length > 4 && <span>+{hit.tags.length - 4}</span>}</div>
      <p className="memory-excerpt">{hit.excerpt ? plainText(hit.excerpt) : '此结果仅返回文档元数据，可引用来源让 OMP 读取全文。'}</p>
      {hit.source && <p className="memory-source" title={hit.source}>{hit.source.split(/[\\/]/).slice(-2).join('/')}</p>}
      <div className="result-actions"><Button variant="secondary" compact disabled={!canQuote} onClick={() => onQuote(`参考 Stele 知识：${hit.title}\n来源：${hit.source || hit.kind}${hit.excerpt ? `\n摘录：${plainText(hit.excerpt).slice(0, 1600)}` : ''}${parsed.extra.some(s => s.stale) ? '\n注意：此检索包含过期知识提示，引用前请核实来源。' : ''}`)}><ArrowUpRight size={13}/>引用到聊天</Button></div>
      <details className="source-details"><summary>来源与检索详情</summary><p>{hit.source}</p><pre>{hit.metadata}</pre>{hit.excerpt && <Document content={hit.excerpt} onError={onError}/>}</details>
    </article>)}
    {parsed.fallback && <div className="plain-result">{parsed.fallback}</div>}
    {parsed.extra.map((section, i) => <details key={i} className={`source-details ${section.stale ? 'stale-details' : ''}`}><summary>{section.stale ? '需重新核实的知识' : /Sessions/.test(section.title) ? '相关历史会话' : section.title}</summary><pre>{section.text}</pre></details>)}
  </div>;
}

export function WorkSummary({work, content, loading, error, updated, refresh, onRead}: {work: Work; content: string; loading: boolean; error: string; updated: string; refresh: () => void; onRead: () => void}) {
  const outline = useMemo(() => workOutline(content), [content]);
  const sections = outline.sections.filter(s => /定位|目标|进度|状态|下一步|阻塞|风险/.test(s.title));
  return <>
    <div className="panel-title"><h2>工作概览</h2><button className="icon-button" aria-label="刷新工作摘要" onClick={refresh} disabled={loading}>{loading ? <Spinner size={14}/> : <RefreshCw size={14}/>}</button></div>
    <p className="panel-intro">{work.name}</p><p className="path-text">{work.root}</p>
    <div className="summary-meta"><span>SESSION.md 摘录</span>{updated && <time>读取于 {updated}</time>}</div>
    {content && <button className="text-action" onClick={onRead}>展开全文与目录 <ArrowUpRight size={12}/></button>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {!content && loading ? <div className="inline-loading"><Spinner size={14}/>读取工作上下文…</div> : content && <>
      <div className="work-counts"><span><strong>{outline.tasks.length}</strong> 文档待办</span><span><strong>{outline.completed}</strong> 已勾选</span></div>
      <p className="helper-text">以下来自文档记录，不代表实时运行状态。</p>
      {(sections.length ? sections : outline.sections).slice(0, 3).map((section, i) => <section className="summary-section" key={i}><h3>{section.title}</h3><p className="summary-excerpt">{plainText(section.content).slice(0, 650)}</p></section>)}
      {!outline.sections.length && <p className="summary-excerpt">{plainText(content).slice(0, 650)}</p>}
      {outline.tasks.length > 0 && <section className="summary-section"><h3>未完成事项</h3><ul className="summary-tasks">{outline.tasks.slice(0, 5).map((task, i) => <li key={i}>{task}</li>)}</ul>{outline.tasks.length > 5 && <p className="helper-text">还有 {outline.tasks.length - 5} 项，展开全文查看。</p>}</section>}
      <Button variant="secondary" compact onClick={onRead}><Maximize2 size={13}/>阅读完整 SESSION.md</Button>
    </>}
  </>;
}

export function DocumentReader({file, root, onError, onNavigate, positions: sharedPositions, active = true}: {file: FilePreview; root?: string; onError: (e: unknown) => void; onNavigate?: (file: FilePreview) => void; positions?: Map<string, ReaderPosition>; active?: boolean}) {
  const [search, setSearch] = useState(''), [index, setIndex] = useState(0), [count, setCount] = useState(0);
  const body = useRef<HTMLDivElement>(null), localPositions = useRef(new Map<string, ReaderPosition>()), positions = sharedPositions || localPositions.current;
  const handledAnchor = useRef<FilePreview|null>(null);
  const identity = `${root || ''}|${file.path || file.name}`, headings = useMemo(() => file.kind === 'markdown' ? documentHeadings(file.content || '') : [], [file.content, file.kind]);
  const navigate = useCallback(async (href: string) => {
    if (!root || !file.path || !onNavigate) {onError('请在文件预览中打开此链接。'); return;}
    try {const [reference,anchor] = href.split('#'); const next = await api.readPreview(root, decodeURIComponent(reference), file.path); onNavigate({...next,anchor:anchor?decodeURIComponent(anchor):undefined});} catch (e) {onError(e);}
  }, [root, file.path, onNavigate, onError]);
  const resolveImage = useCallback(async (src: string) => {const next = await api.readPreview(root!, decodeURIComponent(src), file.path); if (next.kind !== 'image') throw Error('不是图片'); return next.dataUrl!;}, [root, file.path]);
  useLayoutEffect(() => {
    const el = body.current; if (!el || !active) return;
    restoreReaderPosition(el, positions.get(identity));
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth && el.clientWidth !== width) {
        restoreReaderPosition(el, positions.get(identity));
        width = el.clientWidth;
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [identity, active, positions]);
  useLayoutEffect(() => {setSearch(''); setIndex(0);}, [identity]);
  useEffect(() => {
    if(!file.anchor||!active||handledAnchor.current===file)return;
    const frame=requestAnimationFrame(()=>{const el=body.current,heading=el?.querySelector(`[id="${CSS.escape(file.anchor!)}"]`);if(el&&heading){el.scrollTop+=heading.getBoundingClientRect().top-el.getBoundingClientRect().top;positions.set(identity,captureReaderPosition(el));handledAnchor.current=file;}});
    return()=>cancelAnimationFrame(frame);
  },[file,active,identity,positions]);
  useEffect(() => {
    const el = body.current; if (!el || !active) return;
    const ranges: Range[] = [], term = search.trim().toLocaleLowerCase();
    if (term) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {acceptNode: node => node.parentElement?.closest('.code-toolbar') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT}); let node: Node | null;
      while ((node = walker.nextNode()) && ranges.length < 1000) {const text = node.textContent!.toLocaleLowerCase(); let offset = text.indexOf(term); while (offset >= 0 && ranges.length < 1000) {const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + term.length); ranges.push(range); offset = text.indexOf(term, offset + term.length);}}
    }
    setCount(ranges.length);
    const highlights = (CSS as any).highlights;
    if (highlights && (window as any).Highlight) highlights.set('document-search', new (window as any).Highlight(...ranges));
    const current = ranges[index % (ranges.length || 1)];
    if (current) el.scrollTop += current.getBoundingClientRect().top - el.getBoundingClientRect().top - 50;
    return () => {highlights?.delete('document-search');};
  }, [search, index, file.content, active]);
  return <div className="document-reader">
    <form className="reader-search" onSubmit={e => {e.preventDefault(); setIndex(i => i + 1);}}><Search size={13}/><Input aria-label="在文档中查找" placeholder="查找文档内容…" value={search} onChange={value => {setSearch(value); setIndex(0);}}/>{search && <><span role="status">{count ? index % count + 1 : 0}/{count}</span><button type="submit" disabled={!count}>下一处</button></>}</form>
    {headings.length > 0 && <details className="document-outline"><summary>目录 · {headings.length} 节</summary><nav aria-label="文档目录">{headings.map(h => <button key={h.id} title={h.title} style={{paddingLeft: Math.min(h.level - 1, 3) * 12}} onClick={() => {const el = body.current?.querySelector(`[id="${CSS.escape(h.id)}"]`); if (el && body.current) body.current.scrollTop += el.getBoundingClientRect().top - body.current.getBoundingClientRect().top;}}>{h.title}</button>)}</nav></details>}
    <div className="reader-body" ref={body} onScroll={e => {if (active) positions.set(identity, captureReaderPosition(e.currentTarget));}}>{file.kind === 'text' ? <pre className="plain-code">{file.content}</pre> : <Document content={file.content || ''} onError={onError} onNavigate={href => void navigate(href)} resolveImage={root && file.path ? resolveImage : undefined}/>}</div>
  </div>;
}

export function PreviewPane({selected, root, choose, onError, onImage, active}: {selected: FilePreview | null; root?: string; choose: () => void; onError: (e: unknown) => void; onImage: (src: string) => void; active: boolean}) {
  const [files, setFiles] = useState<FilePreview[]>([]), [current, setCurrent] = useState(''), [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const rootRef = useRef(root); rootRef.current = root;
  const positions = useRef(new Map<string, ReaderPosition>());
  const key = (file: FilePreview) => file.path || file.name;
  const add = useCallback((file: FilePreview) => {setFiles(prev => [...prev.filter(f => key(f) !== key(file)), file].slice(-8)); setCurrent(key(file)); setError('');}, []);
  useEffect(() => {setFiles([]); setCurrent(''); setExpanded(false); setError(''); positions.current.clear();}, [root]);
  useEffect(() => {if (selected) add(selected);}, [selected, add]);
  const file = files.find(f => key(f) === current);
  const refresh = async () => {if (!file?.path || !root) return; setBusy(true); setError(''); try {const updated = await api.readPreview(root, file.path); if (rootRef.current === root) add(updated);} catch (e) {if (rootRef.current === root) {setError(String(e)); onError(e);}} finally {setBusy(false);} };
  return <>
    <div className="panel-title"><h2>文件预览</h2><div className="panel-title-actions">{file?.path && <button className="icon-button" aria-label="刷新预览文件" disabled={busy} onClick={() => void refresh()}>{busy ? <Spinner size={14}/> : <RefreshCw size={14}/>}</button>}<button className="icon-button" aria-label="选择预览文件" disabled={!root} onClick={choose}><FileText size={15}/></button>{file && file.kind !== 'image' && <button className="icon-button" aria-label="展开阅读文件" onClick={() => setExpanded(true)}><Maximize2 size={14}/></button>}</div></div>
    {root && <FileBrowser key={root} root={root} active={active} selected={file?.path} onOpen={add} onError={onError}/>}
    {files.length > 0 && <div className="preview-files" aria-label="已打开的文件">{files.map(f => <div key={key(f)} className={key(f) === current ? 'selected' : ''}><button title={f.path || f.name} aria-pressed={key(f) === current} onClick={() => {setCurrent(key(f)); setError('');}}>{f.name}</button><button aria-label={`关闭文件 ${f.name}`} onClick={() => {setFiles(prev => prev.filter(x => key(x) !== key(f))); if (current === key(f)) setCurrent(key(files.filter(x => key(x) !== key(f)).at(-1) || {name: '', kind: 'markdown'}));}}><X size={12}/></button></div>)}</div>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {file ? <><div className="file-heading" title={file.path}>{file.name}</div>{file.kind !== 'image' ? <DocumentReader file={file} root={root} onError={onError} onNavigate={add} positions={positions.current} active={active&&!expanded}/> : <button className="preview-image" aria-label="放大预览图片" onClick={() => onImage(file.dataUrl!)}><img src={file.dataUrl} alt={file.name}/></button>}</> : <p className="helper-text">{root ? '点击上方文件即可预览。支持 Markdown、图片及常见代码和配置文件。' : '先选择工作区，查看目录和文件。'}</p>}
    <Modal open={active && expanded && !!file} onClose={() => setExpanded(false)} title={file?.name || '阅读文件'} description="在文档中搜索或通过目录跳转，关闭后返回工具面板。" className="reading-modal">{file && file.kind !== 'image' ? <DocumentReader file={file} root={root} onError={onError} onNavigate={add} positions={positions.current}/> : file && <img src={file.dataUrl} alt={file.name}/>}</Modal>
  </>;
}

export function EventsPanel({events, root, status, onError}: {events: WorkEvent[]; root?: string; status: string; onError: (e: unknown) => void}) {
  const [filter, setFilter] = useState('all'), [query, setQuery] = useState(''), [copied, setCopied] = useState(false);
  const list = events.filter(e => (!e.root || e.root === root) && (filter === 'all' || e.level === filter) && `${e.text} ${e.detail || ''}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {setCopied(false);}, [events, filter, query]);
  const copy = async () => {try {await api.copyText(list.map(e => `${e.time} [${e.level}] ${e.text}${e.detail ? '\n' + e.detail : ''}`).join('\n\n')); setCopied(true);} catch (e) {onError(e);} };
  const labels = {info: '信息', success: '完成', warning: '提醒', error: '错误'};
  return <><div className="panel-title"><h2>运行事件</h2><button className="icon-button" aria-label="复制筛选后的事件" disabled={!list.length} onClick={() => void copy()}><Copy size={14}/></button></div><p className="panel-intro">{status} · 当前工作区 · 最近 200 条</p><div className="event-filters"><Input aria-label="搜索事件" placeholder="搜索事件或错误…" value={query} onChange={setQuery}/><select aria-label="事件级别" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部</option><option value="error">错误</option><option value="warning">提醒</option><option value="success">完成</option></select></div>{copied && <p className="helper-text" role="status">已复制 {list.length} 条事件</p>}{list.length ? <ol className="event-list">{list.map(event => <li key={event.id} data-level={event.level}><div className="event-meta"><span>{labels[event.level]}</span><time>{event.time}</time></div><p>{event.text}</p>{event.detail && <details className="source-details"><summary>详细信息</summary><pre>{event.detail}</pre></details>}</li>)}</ol> : <p className="empty-line">{events.length ? '没有符合筛选条件的事件。' : '连接、命令、生成与工具执行的进度将显示在这里。'}</p>}</>;
}
