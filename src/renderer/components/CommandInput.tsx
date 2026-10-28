import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type ClipboardEventHandler } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, BookOpen, Command, RefreshCw, X } from 'lucide-react';
import { Spinner } from '@cindy/components/ui/spinner';
import { applyCompletion, commandCatalog, commandHint, completionContext, sourceLabel, suggestionsFor, type CommandSuggestion, type SlashCommand } from '../command-completion';

type Props = {
  draft: string; setDraft: (value: string) => void; inputRef: RefObject<HTMLTextAreaElement | null>;
  onSend: () => void; disabled: boolean; placeholder: string; root?: string; openRequest: number;
  nativeCommands: SlashCommand[]; status: 'idle' | 'loading' | 'ready' | 'error'; error: string;
  loadCommands: (force?: boolean) => Promise<void>;
  onCompletionActive: (active: boolean) => void;
  onPaste?:ClipboardEventHandler<HTMLTextAreaElement>;
};
export function CommandInput({draft, setDraft, inputRef, onSend, disabled, placeholder, root, openRequest, nativeCommands, status, error, loadCommands, onCompletionActive,onPaste}: Props) {
  const [editLarge,setEditLarge]=useState(false);const large=draft.length>8000;
  useEffect(()=>{if(!large)setEditLarge(false);},[large]);
  const [focused, setFocused] = useState(false), [caret, setCaret] = useState(0), [selectionEnd, setSelectionEnd] = useState(0);
  const [manual, setManual] = useState(false), [dismissed, setDismissed] = useState('');
  const [filter, setFilter] = useState<'all' | 'skills' | 'commands'>('all'), [selected, setSelected] = useState(0);
  const [composing, setComposing] = useState(false), composingRef = useRef(false);
  const menu = useRef<HTMLDivElement>(null), lastOpen = useRef(openRequest), lastRoot = useRef(root);
  const [position, setPosition] = useState<{left: number; width: number; top?: number; bottom?: number; maxHeight: number} | null>(null);
  const catalog = useMemo(() => commandCatalog(nativeCommands), [nativeCommands]);
  const context = completionContext(draft, caret, selectionEnd, catalog, manual);
  const signature = `${draft}\0${caret}\0${selectionEnd}`;
  const open = !disabled && !composing && !!context && (manual || focused) && (manual || dismissed !== signature);
  const suggestions = useMemo(() => context ? suggestionsFor(context, catalog, filter) : [], [context?.kind, context?.query, context?.parent, catalog, filter]);
  const activeIndex = Math.min(selected, Math.max(0, suggestions.length - 1));
  const hint = commandHint(draft, catalog);
  useEffect(() => {onCompletionActive(open && (suggestions.length > 0 || status === 'loading'));}, [open, suggestions.length, status, onCompletionActive]);
  const readCaret = () => {const el = inputRef.current; if (el) {setCaret(el.selectionStart); setSelectionEnd(el.selectionEnd);}};
  const close = () => {setManual(false); setDismissed(signature);};
  useEffect(() => {setSelected(0);}, [context?.kind, context?.query, filter, root]);
  const wantsCatalog = !disabled && (manual || (focused && /^\s*\//.test(draft)));
  // A workspace change resets the launcher before it may start that workspace's OMP.
  useEffect(() => {if (wantsCatalog && lastRoot.current === root) void loadCommands();}, [wantsCatalog, root, loadCommands]);
  useEffect(() => {
    if (lastRoot.current !== root) {lastRoot.current = root; setManual(false); setFocused(false); setDismissed(''); setFilter('all');}
  }, [root]);
  useEffect(() => {
    if (lastOpen.current === openRequest) return;
    lastOpen.current = openRequest; if (disabled) return;
    setManual(true); setDismissed(''); setFilter('all'); setSelected(0); inputRef.current?.focus(); readCaret();
  }, [openRequest, disabled]);
  useLayoutEffect(() => {
    if (!open) {setPosition(null); return;}
    const measure = () => {
      const rect = inputRef.current?.closest('.composer')?.getBoundingClientRect(); if (!rect) return;
      const above = rect.top - 20, below = window.innerHeight - rect.bottom - 20;
      const upward = above >= 180 || above >= below, available = Math.max(100, upward ? above : below);
      const width = Math.min(rect.width, 620, window.innerWidth - 24);
      setPosition({left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width,
        ...(upward ? {bottom: window.innerHeight - rect.top + 8} : {top: rect.bottom + 8}), maxHeight: Math.min(390, available)});
    };
    measure(); const observer = new ResizeObserver(measure); if (inputRef.current) observer.observe(inputRef.current);
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
    return () => {observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true);};
  }, [open, inputRef]);
  useEffect(() => {if (open) menu.current?.querySelector(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({block: 'nearest'});}, [activeIndex, open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {if (e.target !== inputRef.current && !menu.current?.contains(e.target as Node)) close();};
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [open, signature]);
  const accept = (suggestion: CommandSuggestion) => {
    if (!context) return;
    const result = applyCompletion(draft, context, suggestion);
    setDraft(result.text); setManual(false); setFilter('all'); setCaret(result.caret); setSelectionEnd(result.caret);
    const next = completionContext(result.text, result.caret, result.caret, catalog);
    setDismissed(context.kind === 'command' && next?.kind === 'subcommand' ? '' : `${result.text}\0${result.caret}\0${result.caret}`);
    requestAnimationFrame(() => {const el = inputRef.current; if (el) {el.focus(); el.setSelectionRange(result.caret, result.caret);}});
  };
  return <>
    {large&&<div className="large-paste"><span>长文本 · {draft.length.toLocaleString()} 字符 · 将发送完整原文</span><button type="button" onClick={()=>setEditLarge(v=>!v)}>{editLarge?'收起':'编辑全文'}</button><button type="button" onClick={()=>setDraft('')}>移除</button>{!editLarge&&<pre>{draft.slice(0,180)}…</pre>}</div>}
    <textarea ref={inputRef} id="message-input" role="combobox" aria-label="给 OMP 的消息" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? 'command-completions' : undefined} aria-activedescendant={open && suggestions.length ? `command-option-${activeIndex}` : undefined}
      aria-describedby={hint ? 'command-input-hint' : undefined} autoComplete="off" placeholder={large&&!editLarge?'可继续粘贴，或点击编辑全文…':placeholder} value={large&&!editLarge?'':draft} disabled={disabled} rows={2}
      onPaste={onPaste}
      onFocus={() => {setFocused(true); readCaret();}} onBlur={() => {setFocused(false); setManual(false);}}
      onSelect={readCaret} onClick={readCaret}
      onChange={e => {setDraft(large&&!editLarge?draft+e.target.value:e.target.value); setFocused(true); setManual(false); setDismissed(''); setCaret(e.target.selectionStart); setSelectionEnd(e.target.selectionEnd);}}
      onCompositionStart={() => {composingRef.current = true; setComposing(true);}}
      onCompositionEnd={() => {composingRef.current = false; setComposing(false); readCaret();}}
      onKeyDown={e => {
        if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {e.preventDefault(); setManual(true); setDismissed(''); void loadCommands(); return;}
        if (open && e.key === 'Escape') {e.preventDefault(); e.stopPropagation(); close(); return;}
        if (open && suggestions.length && !e.shiftKey && !e.ctrlKey && !e.metaKey && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
          e.preventDefault(); setSelected((activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return;
        }
        if (open && suggestions.length && !e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'Tab' || e.key === 'Enter')) {e.preventDefault(); accept(suggestions[activeIndex]); return;}
        if (open && status === 'loading' && !suggestions.length && e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {e.preventDefault(); return;}
        if (e.key === 'Enter' && !e.shiftKey) {e.preventDefault(); close(); onSend();}
      }}/>
    {hint && !open && <div id="command-input-hint" className="command-input-hint" title={hint}>{hint}</div>}
    {open && position && createPortal(<div className="command-popover" ref={menu} style={position} onMouseDown={e => e.preventDefault()}>
      <div className="command-popover-header"><span>{context?.kind === 'subcommand' ? `/${context.parent?.name} 子命令` : '技能与命令'} <small>{suggestions.length}</small></span><button type="button" tabIndex={-1} aria-label="刷新技能与命令" disabled={status === 'loading'} onClick={() => void loadCommands(true)}><RefreshCw size={13}/></button><button type="button" tabIndex={-1} aria-label="关闭命令补全" onClick={close}><X size={14}/></button></div>
      {context?.kind === 'command' && <div className="command-filters" aria-label="命令类型">{([{value: 'all', label: '全部'}, {value: 'skills', label: '技能'}, {value: 'commands', label: '命令'}] as const).map(item => <button type="button" key={item.value} tabIndex={-1} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}</div>}
      {status === 'loading' && <div className="command-fetch-state" role="status"><Spinner size={12}/>正在连接 OMP 并读取技能与命令…</div>}
      {status === 'error' && <div className="command-fetch-state error-text" role="alert"><span>{error || '技能目录读取失败'}</span><button type="button" tabIndex={-1} onClick={() => void loadCommands(true)}>重试</button></div>}
      <div id="command-completions" role="listbox" aria-label="技能与命令补全" className="command-options">
        {suggestions.map((item, i) => <button type="button" tabIndex={-1} id={`command-option-${i}`} data-option-index={i} key={item.key} role="option" aria-selected={i === activeIndex} onPointerMove={() => setSelected(i)} onClick={() => accept(item)}>
          {item.source === 'skill' ? <BookOpen size={15}/> : <Command size={15}/>}<span className="command-option-copy"><span className="command-option-name">{item.name}{item.hint && <small>{item.hint}</small>}</span><span className="command-description">{item.description || '由 OMP 提供'}{item.aliases?.length ? ` · 别名 ${item.aliases.map(x => `/${x}`).join('、')}` : ''}</span></span><span className="command-source">{sourceLabel(item.source)}</span>{i === activeIndex && <ArrowUpRight size={13}/>}
        </button>)}
      </div>
      {!suggestions.length && status !== 'loading' && <p className="command-empty">没有匹配的技能或命令。可切换分类、修改关键词或刷新目录。</p>}
      <div className="command-popover-footer">{suggestions.length ? <><span>↑ ↓ 选择 · Tab / Enter 补全 · Esc 关闭</span><span>补全后再次 Enter 发送</span></> : <span>{status === 'loading' ? '目录加载后可选择 · Esc 关闭' : 'Esc 关闭 · Enter 交给 OMP 处理'}</span>}</div>
    </div>, document.body)}
  </>;
}
