import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, ChevronRight, Code2, File, FileImage, FileText, Folder, RefreshCw } from 'lucide-react';
import { Input } from '@cindy/components/ui/input';
import { Spinner } from '@cindy/components/ui/spinner';
import { api } from '../api';
import type { FileEntry, FileListing, FilePreview } from '../types';

export function FileBrowser({root, active, selected, onOpen, onError, initialDirectory=''}: {root: string; active: boolean; selected?: string; onOpen: (file: FilePreview) => void; onError: (e: unknown) => void; initialDirectory?:string}) {
  const [directory, setDirectory] = useState(initialDirectory), [query, setQuery] = useState(''), [showHidden, setShowHidden] = useState(false), [collapsed, setCollapsed] = useState(false);
  const [listing, setListing] = useState<FileListing | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [opening, setOpening] = useState('');
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const request = useRef(0), alive = useRef(true), loaded = useRef(''), scroll = useRef<HTMLDivElement>(null), positions = useRef(new Map<string, number>());
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  useEffect(() => {
    const key = JSON.stringify([root, directory, query, showHidden, offset, revision]);
    if (!active || collapsed || loaded.current === key) return;
    const id = ++request.current; setBusy(true); setError('');
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const next = await api.listFiles(root, directory, {query, showHidden, offset});
          if (request.current !== id || !alive.current) return;
          setListing(previous => ({...next, entries: offset && previous?.directory === next.directory ? [...previous.entries, ...next.entries] : next.entries})); loaded.current = key;
          if (!offset) requestAnimationFrame(() => {if (request.current === id && scroll.current) scroll.current.scrollTop = positions.current.get(directory) || 0;});
        } catch (e) {if (request.current === id && alive.current) {setError(String(e)); setListing(null);}}
        finally {if (request.current === id && alive.current) setBusy(false);}
      })();
    }, query ? 180 : 0);
    return () => {clearTimeout(timer); request.current++;};
  }, [root, active, directory, query, showHidden, offset, revision, collapsed]);
  const navigate = (path: string) => {setDirectory(path); setQuery(''); setOffset(0); setListing(null); setError('');};
  const open = async (entry: FileEntry) => {
    if (entry.kind === 'directory') {navigate([listing?.directory, entry.name].filter(Boolean).join('/')); return;}
    setOpening(entry.path); setError('');
    try {const file = await api.readPreview(root, entry.path); if (alive.current) onOpen(file);}
    catch (e) {if (alive.current) {setError(String(e)); onError(e);}}
    finally {if (alive.current) setOpening('');}
  };
  const relative = listing?.directory ?? directory;
  const parent = relative.split('/').slice(0, -1).join('/');
  return <section className={`file-browser ${selected ? 'has-preview' : ''}`} aria-label="工作区文件列表">
    <div className="file-browser-heading"><button aria-label={collapsed ? '展开文件列表' : '收起文件列表'} aria-expanded={!collapsed} onClick={() => setCollapsed(v => !v)}>{collapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}工作区文件</button><button className="icon-button" aria-label="刷新文件列表" disabled={busy || collapsed} onClick={() => {setOffset(0); setRevision(v => v + 1);}}><RefreshCw size={13}/></button></div>
    <div hidden={collapsed}>
      <div className="file-breadcrumb"><button className="icon-button" aria-label="上一级目录" disabled={!relative || busy} onClick={() => navigate(parent)}><ArrowUp size={13}/></button><button aria-label="返回工作区根目录" title={root} onClick={() => navigate('')}><Folder size={13}/>{root.split('/').at(-1)}</button>{relative && <span title={relative}>/ {relative}</span>}</div>
      <Input aria-label="筛选当前目录" placeholder="按名称筛选当前目录…" value={query} onChange={value => {setQuery(value); setOffset(0);}}/>
      <div className="file-list-options"><label><input type="checkbox" checked={showHidden} onChange={e => {setShowHidden(e.target.checked); setOffset(0);}}/>显示隐藏文件</label>{listing && <span>{listing.total} 项</span>}</div>
      {error && <p className="error-text" role="alert">{error}<button className="text-action" onClick={() => setRevision(v => v + 1)}>重试</button></p>}
      <div className="file-list" ref={scroll} role="list" aria-busy={busy} onScroll={e => {if (!busy) positions.current.set(directory, e.currentTarget.scrollTop);}}>
        {listing?.entries.map(entry => {
          const directoryEntry = entry.kind === 'directory', unsupported = entry.kind === 'file' || entry.kind === 'blocked';
          const Icon = directoryEntry ? Folder : entry.kind === 'image' ? FileImage : entry.kind === 'text' ? Code2 : entry.kind === 'markdown' ? FileText : File;
          return <div role="listitem" key={entry.path}><button className="file-list-row" aria-label={`${directoryEntry ? '打开目录' : '预览文件'} ${entry.name}`} aria-current={entry.path === selected ? 'true' : undefined} title={entry.reason || `${entry.name}${unsupported ? ' · 暂不支持预览此类型' : entry.link ? ' · 链接' : ''}`} disabled={busy || !!opening || unsupported} onClick={() => void open(entry)}>
            {opening === entry.path ? <Spinner size={14}/> : <Icon size={14}/>}<span>{entry.name}</span>{directoryEntry ? <ChevronRight size={12}/> : unsupported ? <small>{entry.kind === 'blocked' ? '不可访问' : '未支持'}</small> : entry.link ? <small>链接</small> : null}
          </button></div>;
        })}
        {busy && <div className="inline-loading" role="status"><Spinner size={13}/>读取目录…</div>}
        {!busy && !error && listing && !listing.entries.length && <p className="empty-line">{query ? '当前目录没有匹配的文件或文件夹。' : '此目录没有可见条目。'}</p>}
        {listing?.nextOffset != null && <button className="text-action" disabled={busy} onClick={() => setOffset(listing.nextOffset!)}>加载更多（已显示 {listing.entries.length} / {listing.total}）</button>}
      </div>
    </div>
  </section>;
}
