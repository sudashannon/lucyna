import { Streamdown, defaultRehypePlugins, type Components, type DiagramPlugin, type MermaidErrorComponentProps } from 'streamdown';
import { code } from '@streamdown/code';
import { cjk } from '@streamdown/cjk';
import { createMathPlugin } from '@streamdown/math';
import 'katex/dist/katex.min.css';
import { api } from '../api';
import { createElement, memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { documentHeadings } from '../panel-data';
import { markdownTranslations } from '../markdown-config';

// The official Shiki plugin uses a JavaScript regex engine: no eval/WASM CSP exception.
// Very large tool dumps keep their complete text without scheduling expensive highlighting.
const basePlugins = { cjk, math: createMathPlugin({singleDollarTextMath: true}), code: {...code, highlight(options: Parameters<typeof code.highlight>[0], callback?: Parameters<typeof code.highlight>[1]) {
  return options.code.length > 24000 ? {tokens: options.code.split('\n').map(content => [{content}])} : code.highlight(options, callback);
}} };
// rehype-harden normalizes ./image.png to /image.png. Preserve document-relative
// paths for our guarded IPC readers; retain Streamdown's HTML sanitizer and URL filter.
const rehypePlugins = [defaultRehypePlugins.raw, defaultRehypePlugins.sanitize];
const remarkRehypeOptions = {footnoteLabel: '注释', footnoteBackLabel: '返回注释引用'};
let loadedDiagram: DiagramPlugin | undefined, diagramPromise: Promise<DiagramPlugin> | undefined;
function loadDiagram() {return diagramPromise ??= import('../markdown-mermaid').then(module => loadedDiagram = module.mermaid);}
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | undefined;
function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);
  if (!themeObserver) {themeObserver = new MutationObserver(() => themeListeners.forEach(fn => fn())); themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});}
  return () => {themeListeners.delete(listener); if (!themeListeners.size) {themeObserver?.disconnect(); themeObserver = undefined;}};
}
const readTheme = () => document.documentElement.dataset.theme === 'dark';
function DiagramError({chart, retry}: MermaidErrorComponentProps) {
  return <div className="markdown-diagram-error" role="status"><p>图表暂时无法渲染，原始内容已保留。</p><button type="button" onClick={retry}>重试图表</button><details><summary>查看 Mermaid 源码</summary><pre>{chart}</pre></details></div>;
}
export const Document = memo(function Document({content, onError, onNavigate, resolveImage, streaming = false}: {content: string; onError: (e: unknown) => void; onNavigate?: (href: string) => void; resolveImage?: (src: string) => Promise<string>; streaming?: boolean}) {
  const [expanded,setExpanded]=useState(false);
  const [diagram,setDiagram]=useState(() => loadedDiagram);
  const needsDiagram = /^\s*(?:`{3,}|~{3,})mermaid\b/im.test(content);
  useEffect(() => {let active=true; if(needsDiagram&&!diagram) void loadDiagram().then(value=>{if(active)setDiagram(value);}).catch(e=>{if(active)onError(e);});return ()=>{active=false;};}, [needsDiagram,diagram,onError]);
  const plugins = useMemo(() => ({...basePlugins, mermaid: diagram}), [diagram]);
  const dark = useSyncExternalStore(subscribeTheme, readTheme);
  const limited = content.length > 200000 && !expanded;
  const visible = limited ? content.slice(0,24000) : content;
  const headingSource = streaming ? '' : visible;
  const components = useMemo<Components>(() => {
    const headings = documentHeadings(headingSource);
    const heading = (level: number) => ({children, node, id}: any) => createElement(`h${level}`, {id: headings.find(h => h.line === node?.position?.start?.line)?.id || id}, children);
    return {
    // Static documents retain line-based outline IDs; streaming blocks have local positions.
    ...(!streaming ? {h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), h5: heading(5), h6: heading(6)} : {}),
    a: ({href, children, ...props}) => <a href={href} id={props.id} title={props.title} aria-label={props['aria-label']} onClick={event => {event.preventDefault(); if (!href) return; try {if (href.startsWith('#')) {event.currentTarget.closest('.markdown')?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({block: 'start'});} else if (/^https?:\/\//i.test(href)) void api.openExternal(href).catch(onError); else if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href) && onNavigate) onNavigate(href); else onError('此链接无法在当前文档中打开。');} catch (e) {onError(e);}}}>{children}</a>,
    img: ({alt, src}) => <LocalImage src={src} alt={alt} resolve={resolveImage}/>,
  };}, [headingSource, streaming, onNavigate, onError, resolveImage]);
  const mermaid = useMemo(() => ({config: {theme: dark ? 'dark' : 'neutral', fontFamily: 'Source Han Sans SC, Microsoft YaHei, sans-serif', securityLevel: 'strict', htmlLabels: false}, errorComponent: DiagramError}), [dark]);
  const controls = useMemo(() => ({code: {copy: {onError}, download: false}, mermaid: {copy: {onError}, download: true, fullscreen: true, panZoom: true}, table: {copy: true, fullscreen: true, download: true}, image: false}), [onError]);
  return <div className="markdown markdown-engine" data-markdown-streaming={streaming || undefined}>
    <Streamdown className={dark ? 'markdown-dark' : 'markdown-light'} mode={streaming ? 'streaming' : 'static'} isAnimating={streaming} parseIncompleteMarkdown={streaming} plugins={plugins} components={components} rehypePlugins={rehypePlugins} remarkRehypeOptions={remarkRehypeOptions} mermaid={mermaid} controls={controls} translations={markdownTranslations} lineNumbers={false} codeBlockMaxHeight={480} tableMaxHeight={480}>{visible}</Streamdown>
    {limited && <div className="markdown-long-notice"><p>{content.length.toLocaleString()} 字符 · 已展示开头，按需加载完整排版。</p><button type="button" onClick={()=>setExpanded(true)}>加载完整文档</button></div>}
  </div>;
});
function LocalImage({src, alt, resolve}: {src?: string; alt?: string; resolve?: (src: string) => Promise<string>}) {
  const [url, setUrl] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => {let active = true; setUrl(''); setFailed(false); if (src && resolve && !/^(?:[a-z]+:|\/\/)/i.test(src)) void resolve(src).then(value => {if (active) setUrl(value);}).catch(() => {if (active) setFailed(true);}); return () => {active = false;};}, [src, resolve]);
  return url ? <img src={url} alt={alt || '文档图片'} loading="lazy"/> : <span className="attachment-note">{alt || '图片'} · {failed ? '图片无法读取' : resolve && src && !/^(?:[a-z]+:|\/\/)/i.test(src) ? '读取中…' : '外部图片未加载'}</span>;
}
export function imageData(block: any): string | null {
  const mime = block.mimeType || block.mime_type || block.source?.media_type || block.contentType;
  const data = block.data ?? block.base64 ?? (block.source?.type === 'base64' ? block.source.data : undefined);
  if (!/^image\/(png|jpeg|jpg|gif|webp|bmp)$/.test(mime || '') || typeof data !== 'string') return null;
  const encoded = data.replace(/\s/g, '');
  if (!encoded || encoded.length > 14 * 1024 * 1024 || encoded.length%4 || /[^A-Za-z0-9+/=]/.test(encoded)) return null;
  try { if (atob(encoded).length > 10 * 1024 * 1024) return null; } catch { return null; }
  return `data:${mime};base64,${encoded}`;
}
export function MessageContent({content, onError, onImage, streaming = false}: {content: any; onError: (e: unknown) => void; onImage: (url: string) => void; streaming?: boolean}) {
  if (typeof content === 'string') return <Document content={content} onError={onError} streaming={streaming}/>;
  if (!Array.isArray(content)) return <pre>{JSON.stringify(content, null, 2)}</pre>;
  return <>{content.map((block, i) => {
    if (typeof block === 'string' || typeof block?.text === 'string') return <Document key={i} content={typeof block === 'string' ? block : block.text} onError={onError} streaming={streaming}/>;
    if (block?.type === 'image') { const src = imageData(block); return src ? <button key={i} className="message-image" onClick={() => onImage(src)} aria-label="放大消息图片"><img src={src} alt="消息附件" loading="lazy"/></button> : <p key={i} className="muted">图片数据缺失或格式不支持</p>; }
    if (block?.type === 'toolCall') return <p key={i} className="muted">调用 {block.name || '工具'}</p>;
    return null;
  })}</>;
}
