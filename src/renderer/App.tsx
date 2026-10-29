import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent } from 'react';
import {useStoredDrafts} from './useStoredDrafts';
import {readImage,validateInput,nativeImages,type DraftImage} from './composer-input';
import {shouldAttachText,validateTextAttachments,composeTextPrompt,type DraftTextAttachment} from './text-attachments';
import {TextAttachments} from './components/TextAttachments';
import { ArrowUp, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, CircleX, Clock3, Code2, FileImage, FileText, Folder, FolderOpen, Globe2, History as HistoryIcon, Import, Layers2, ListFilter, MessageSquare, Moon, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, SlidersHorizontal, Square, Sun, TerminalSquare, X, Zap } from 'lucide-react';
import { Button } from '@cindy/components/ui/button';
import { Input } from '@cindy/components/ui/input';
import { Spinner } from '@cindy/components/ui/spinner';
import { Tooltip, Tip } from '@cindy/components/ui/tooltip';
import { SegmentedControl } from '@cindy/components/ui/segmented-control';
import { SidebarIconButton } from '@cindy/components/sidebar/SidebarIconButton';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useWorkbench } from './useWorkbench';
import { useDrafts } from './useDrafts';
import { useSessionState } from './useSessionState';
import { useListNavigation } from './useListNavigation';
import { errorText } from './errors';
import { api, previewMode, demoMode } from './api';
import type { ClientSettings, FilePreview, HistoryEntry, Work } from './types';
import { Document, MessageContent } from './components/Document';
import { Modal, NativeQuestion } from './components/Modal';
import {HistoryDeletionDialog} from './components/HistoryDeletionDialog';
import { TerminalPanel } from './components/TerminalPanel';
import { ModelPicker } from './components/ModelPicker';
import { SettingsDialog } from './components/SettingsDialog';
import { RunActivity, SessionTranscript } from './components/SessionTranscript';
import { phaseLabels } from './session-view';
import { CommandInput } from './components/CommandInput';
import { DocumentReader, EventsPanel, MemoryResults, PanelPage, PreviewPane } from './components/ToolPanels';
import { WorkDetails } from './components/WorkDetails';
import { KnowledgeWorkspace as KnowledgePanel } from './components/KnowledgeWorkspace';
import { TriangleAlert, Info, ClipboardCheck } from 'lucide-react';
import { WorkDiagnostics, WorkHealthNotice, workIssues } from './components/WorkDiagnostics';
import { BrandLogo, BrandCompanions } from './components/BrandVisuals';
import {ConnectionProgress} from './components/ConnectionProgress';
import {historyBatch,historyStart,historyEnd,jumpWindow} from './transcript-window';
import {Trash2,Undo2} from 'lucide-react';
import {WindowTitlebar} from './components/WindowTitlebar';
import {SessionMonitor} from './components/SessionMonitor';
import {PrimaryNavigation} from './components/PrimaryNavigation';
import {ConversationTimeline} from './components/ConversationTimeline';
import {historyLabel} from './history-entry';
import {useFeedback} from './useFeedback';
import {CopyPlus} from 'lucide-react';
import {buildTimeline,messageDomId,type TimelineEntry} from './conversation-timeline';

type Tab = 'work' | 'history' | 'preview' | 'memory' | 'events';
const tabs: {value: Tab; label: string}[] = [{value: 'work', label: '工作'}, {value: 'history', label: '会话'}, {value: 'preview', label: '预览'}, {value: 'memory', label: '记忆'}, {value: 'events', label: '事件'}];
const dateLabel = (entry: HistoryEntry) => {
  const value = entry.modifiedAt || entry.importedAt || entry.modified;
  if (!value) return '';
  const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', {month: 'short', day: 'numeric'});
};
const sidebarDefaultWidth = 224, sidebarMinWidth = 200, sidebarMaxWidth = 420;
const noImages:DraftImage[]=[];
const noTextAttachments:DraftTextAttachment[]=[];
export function App() {
  useFeedback();
  const w = useWorkbench();
  const customChrome=!!api.windowChrome?.enabled;
  const [workChecksOpen, setWorkChecksOpen] = useState(false);
  const workIssueCount = w.works.reduce((sum, work) => sum + workIssues(work).length, 0);
  const [section,setSection]=useState<'workbench'|'knowledge'|'sessions'>('workbench'),[knowledgeVisited,setKnowledgeVisited]=useState(false);
  const knowledgeOpen=section==='knowledge',setKnowledgeOpen=useCallback((open:boolean)=>setSection(open?'knowledge':'workbench'),[]);
  const openKnowledge=()=>{setKnowledgeVisited(true);setKnowledgeOpen(true);};
  const [sidebar, setSidebar] = useState(true);
  const [knowledgeSidebarTarget,setKnowledgeSidebarTarget]=useState<HTMLDivElement|null>(null);
  const [panel, setPanel] = useSessionState(w.id,true), [tab, setTab] = useSessionState<Tab>(w.id,'work');
  const [theme, setTheme] = useState(() => localStorage.getItem('omp.theme') === 'dark' ? 'dark' : 'light');
  const {draft, setDraft,setDraftForKey, error: draftError,values:allDrafts,loaded:draftsLoaded,retry:retryDrafts} = useDrafts(w.draftKey);
  const {value:images,set:setImages,setForKey:setImagesForKey,error:imageError,values:allImages,loaded:imagesLoaded,retry:retryImages}=useStoredDrafts<DraftImage[]>('images',w.draftKey,()=>({}),noImages);
  const {value:textAttachments,set:setTextAttachments,error:textAttachmentError,values:allTextAttachments,loaded:textAttachmentsLoaded,retry:retryTextAttachments}=useStoredDrafts<DraftTextAttachment[]>('textAttachments',w.draftKey,()=>({}),noTextAttachments);
  const [imageBusy,setImageBusy]=useSessionState(w.id,false),imagePicker=useRef<HTMLInputElement>(null);
  const [palette, setPalette] = useState(false), [filter, setFilter] = useState('');
  const [web, setWeb] = useState(false), [url, setUrl] = useState(''), [webBusy, setWebBusy] = useState(false), [webError, setWebError] = useState('');
  const [about, setAbout] = useState(false), [file, setFile, sessionFiles] = useSessionState<FilePreview | null>(w.id,null), [zoom, setZoom] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<Record<string,{root:string;report:(e:unknown)=>void}>>({}), [terminalVisible, setTerminalVisible, terminalVisibility] = useSessionState(w.id,false);
  const [query, setQuery] = useSessionState(w.id,''), [memory, setMemory] = useSessionState(w.id,''), [memoryBusy, setMemoryBusy] = useSessionState(w.id,false), [memoryError, setMemoryError] = useSessionState(w.id,'');
  const [dialogBusy, setImportBusy] = useSessionState(w.id,false), [commandOpenRequest, setCommandOpenRequest] = useState(0);
  const importBusy=dialogBusy||w.importing;
  const [deleteTarget,setDeleteTarget]=useState<{entry:HistoryEntry;root:string}|null>(null),[trashOpen,setTrashOpen]=useState(false),[trashBusy,setTrashBusy]=useState(false),[trashError,setTrashError]=useState('');
  useEffect(()=>{
    if(!draftsLoaded||!imagesLoaded||!textAttachmentsLoaded||draftError||imageError||textAttachmentError)return;
    const protectedKeys=new Set([...Object.keys(allDrafts).filter(key=>!!allDrafts[key]),...Object.keys(allImages).filter(key=>allImages[key]?.length),...Object.keys(allTextAttachments).filter(key=>allTextAttachments[key]?.length)]);
    w.pruneEmpty(protectedKeys,new Set(Object.keys(terminals)));
  },[w.id,w.sessions.length,w.pruneEmpty,allDrafts,allImages,allTextAttachments,draftsLoaded,imagesLoaded,textAttachmentsLoaded,draftError,imageError,textAttachmentError,terminals]);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [settingsOpen,setSettingsOpen]=useState(false),[clientSettings,setClientSettings]=useState<ClientSettings|null>(null);
  const runtime=clientSettings?.runtime || 'windows', runtimeLabel=(w.runtime || runtime)==='wsl'?'WSL OMP':'Windows OMP';
  useEffect(()=>{if(!previewMode&&api.getSettings)void api.getSettings().then(info=>setClientSettings(info.settings)).catch(w.report);},[w.report]);
  const [historySearch, setHistorySearch] = useSessionState(w.id,''), [historySource, setHistorySource] = useSessionState(w.id,'all'), [workReading, setWorkReading] = useState(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  useLayoutEffect(()=>{
    const update=()=>w.setConversationVisible(section==='workbench'&&!settingsOpen&&!workReading&&!zoom&&!palette&&!about&&document.visibilityState==='visible'&&document.hasFocus());
    const blur=()=>w.setConversationVisible(false);
    update();window.addEventListener('focus',update);window.addEventListener('blur',blur);document.addEventListener('visibilitychange',update);
    return()=>{window.removeEventListener('focus',update);window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',update);};
  },[section,settingsOpen,workReading,zoom,palette,about,w.id,w.setConversationVisible]);
  const [completionActive, setCompletionActive] = useState(false);
  const [deferredQuestion,setDeferredQuestion]=useSessionState(w.id,'');
  const [petTarget,setPetTarget]=useState('');
  useEffect(()=>api.onPetNavigate?.(({id})=>{setPetTarget(id);setKnowledgeOpen(false);setSettingsOpen(false);setPalette(false);setModelsOpen(false);setWorkReading(false);setZoom(null);}),[]);
  useEffect(()=>{if(petTarget===w.id){setDeferredQuestion('');setPetTarget('');}},[petTarget,w.id,setDeferredQuestion]);
  useEffect(()=>{void api.petContext?.({theme,id:w.id,title:w.title,visible:section==='workbench'&&!settingsOpen&&!workReading&&!zoom}).catch(()=>{});},[theme,w.id,w.title,section,settingsOpen,workReading,zoom]);
  const sendPending = useRef(new Set<string>());
  const readingPositions=useRef(new Map<string,{top:number;follow:boolean}>());
  const [panelWidth, setPanelWidth] = useState(() => Math.max(320, Math.min(520, Number(localStorage.getItem('omp.panelWidth')) || 370)));
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth, Number(localStorage.getItem('omp.sidebarWidth')) || sidebarDefaultWidth)));
  const [knowledgeSidebarWidth,setKnowledgeSidebarWidth]=useState(()=>Math.max(280,Math.min(480,Number(localStorage.getItem('omp.knowledgeSidebarWidth'))||340)));
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth), [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarDrag = useRef<{startX: number; startWidth: number} | null>(null);
  // Keep a usable chat column when both sidebars are open; preserve the user's
  // preferred width so enlarging the window restores it automatically.
  const activeSidebarMin=knowledgeOpen?280:sidebarMinWidth;
  const sideBySide=panel&&section==='workbench'&&viewportWidth>1280;
  const visiblePanelWidth=sideBySide?Math.min(panelWidth,Math.max(320,viewportWidth-(sidebar?activeSidebarMin:64)-640)):panelWidth;
  const sidebarLimit = Math.max(activeSidebarMin, Math.min(knowledgeOpen?480:sidebarMaxWidth, viewportWidth - (sideBySide ? visiblePanelWidth : 0) - (sideBySide?640:480)));
  const visibleSidebarWidth = Math.min(knowledgeOpen?knowledgeSidebarWidth:sidebarWidth, sidebarLimit);
  const resizeSidebar = (width: number) => (knowledgeOpen?setKnowledgeSidebarWidth:setSidebarWidth)(Math.max(activeSidebarMin, Math.min(sidebarLimit, Math.round(width))));
  const endSidebarDrag = () => {sidebarDrag.current = null; setSidebarResizing(false);};
  const composer = useRef<HTMLTextAreaElement>(null), transcript = useRef<HTMLDivElement>(null), follow = useRef(true);
  const [historyAnchor,setHistoryAnchor]=useSessionState(w.id,''),startIndex=historyStart(w.messages,historyAnchor);
  const [historyEndAnchor,setHistoryEndAnchor]=useSessionState(w.id,''),endIndex=historyEnd(w.messages,historyEndAnchor);
  const [jumpTarget,setJumpTarget]=useSessionState(w.id,''),pendingJump=useRef<{session:string;id:string}|null>(null);
  const timeline=useMemo(()=>buildTimeline(w.messages,w.run?.outcome==='completed'),[w.id,w.timelineRevision]);
  const timelineEntries:TimelineEntry[]=w.questions.length?[...timeline,{id:'run-status',index:w.messages.length,kind:'question',label:'OMP 正在等待你的回复'}]:timeline;
  const jumpTo=(entry:TimelineEntry)=>{const range=jumpWindow(w.messages,entry.index);follow.current=false;setAwayFromLatest(true);pendingJump.current={session:w.id,id:entry.id};setHistoryAnchor(range.start);setHistoryEndAnchor(range.end);setJumpTarget(entry.id);if(entry.kind==='question')setDeferredQuestion('');};
  const latest=()=>{pendingJump.current=null;setHistoryAnchor(w.messages[Math.max(0,w.messages.length-historyBatch)]?.id||'');setHistoryEndAnchor('');setJumpTarget('');follow.current=true;setAwayFromLatest(false);requestAnimationFrame(()=>transcript.current?.scrollTo({top:transcript.current.scrollHeight,behavior:'instant'}));};
  useLayoutEffect(()=>{const pending=pendingJump.current,element=transcript.current;if(!pending||pending.session!==w.id||!element||section!=='workbench')return;const target=document.getElementById(pending.id==='run-status'?'run-status':messageDomId(pending.id));if(!target)return;follow.current=false;element.scrollTop+=target.getBoundingClientRect().top-element.getBoundingClientRect().top-16;readingPositions.current.set(w.id,{top:element.scrollTop,follow:false});setAwayFromLatest(true);pendingJump.current=null;},[historyAnchor,historyEndAnchor,jumpTarget,w.id,section]);
  useEffect(()=>{if(!jumpTarget)return;const timer=setTimeout(()=>setJumpTarget(''),3500);return()=>clearTimeout(timer);},[jumpTarget,setJumpTarget]);
  const prepend=useRef<{id:string;height:number;top:number}|null>(null);
  useEffect(()=>{if(!historyAnchor&&w.messages.length)setHistoryAnchor(w.messages[startIndex].id);},[w.messages,historyAnchor,startIndex,setHistoryAnchor]);
  useLayoutEffect(()=>{const before=prepend.current,element=transcript.current;if(before&&before.id===w.id&&element){element.scrollTop=before.top+element.scrollHeight-before.height;prepend.current=null;}},[historyAnchor,w.id]);
  const earlier=()=>{const element=transcript.current;if(!element)return;follow.current=false;prepend.current={id:w.id,height:element.scrollHeight,top:element.scrollTop};setHistoryAnchor(w.messages[Math.max(0,startIndex-historyBatch)].id);};
  const workValid = !!w.work && w.work.kind !== 'invalid';
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('omp.theme', theme); }, [theme]);
  useEffect(()=>{if(customChrome)void api.windowChrome!.theme(theme).catch(w.report);},[customChrome,theme,w.report]);
  useEffect(() => { localStorage.setItem('omp.panelWidth', String(panelWidth)); }, [panelWidth]);
  useEffect(() => { localStorage.setItem('omp.sidebarWidth', String(sidebarWidth)); }, [sidebarWidth]);
  useEffect(()=>{localStorage.setItem('omp.knowledgeSidebarWidth',String(knowledgeSidebarWidth));},[knowledgeSidebarWidth]);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resize); window.addEventListener('blur', endSidebarDrag);
    return () => {window.removeEventListener('resize', resize); window.removeEventListener('blur', endSidebarDrag);};
  }, []);
  useEffect(() => {if (!sidebar || viewportWidth <= 760) endSidebarDrag();}, [sidebar, viewportWidth]);
  useEffect(() => { if (w.work) localStorage.setItem('omp.work', w.work.root); document.querySelector('.work-row[aria-current="page"]')?.scrollIntoView({block: 'nearest'}); }, [w.work?.root]);
  useEffect(()=>{setModelsOpen(false);setWorkReading(false);setZoom(null);},[w.id]);
  useLayoutEffect(()=>{
    if(section!=='workbench')return;
    const position=readingPositions.current.get(w.id);follow.current=position?.follow??!historyEndAnchor;
    if(transcript.current)transcript.current.scrollTop=follow.current?transcript.current.scrollHeight:position?.top||0;
    setAwayFromLatest(!follow.current);
  },[w.id,section]);
  useEffect(() => {if (sidebar) document.querySelector('.work-row[aria-current="page"]')?.scrollIntoView({block: 'nearest'});}, [sidebar]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if(api.windowChrome?.enabled)return; // Native menu owns desktop accelerators.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {e.preventDefault(); setPalette(v => !v); setFilter('');}
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {e.preventDefault(); setSidebar(v => !v);}
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => { if (section==='workbench'&&follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }, [w.messages, w.busy,historyEndAnchor,historyAnchor,section]);
  useEffect(() => { if (composer.current) {composer.current.style.height = 'auto'; composer.current.style.height = Math.min(200, composer.current.scrollHeight) + 'px';} }, [draft]);
  const pick = (work: Work) => {
    setKnowledgeOpen(false);
    void w.selectWork(work); setPalette(false);
  };
  const [workFilter,setWorkFilter]=useState('all');
  const [recentWorks,setRecentWorks]=useState<Record<string,number>>(()=>{try{const value=JSON.parse(localStorage.getItem('omp.recentWorks')||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}});
  useEffect(()=>{if(!w.work?.root)return;const root=w.work.root;setRecentWorks(previous=>{const next=Object.fromEntries(Object.entries({...previous,[root]:Date.now()}).filter(([,v])=>typeof v==='number').sort((a,b)=>b[1]-a[1]).slice(0,100));try{localStorage.setItem('omp.recentWorks',JSON.stringify(next));}catch{}return next;});},[w.work?.root]);
  const visibleWorks=w.works.filter(work=>workFilter==='all'||workFilter==='recent'?true:workFilter==='open'?w.sessions.some(s=>s.root===work.root):w.sessions.some(s=>s.root===work.root&&(s.questions||s.error||s.unread)));
  if(workFilter==='recent')visibleWorks.sort((a,b)=>(recentWorks[b.root]||0)-(recentWorks[a.root]||0));
  const matchingWorks = w.works.filter(x => `${x.name} ${x.root}`.toLowerCase().includes(filter.toLowerCase()));
  const workNavigation = useListNavigation(matchingWorks.length, `${palette}:${filter}`, index => pick(matchingWorks[index]));
  const openPanel = (next: Tab) => {setKnowledgeOpen(false);setTab(next); setPanel(true);};
  const toggleToolsPanel = (open: boolean) => {
    setPanel(open);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`button[aria-label="${open ? '收起' : '展开'}工具面板"]`)?.focus());
  };
  const focusComposer = () => requestAnimationFrame(() => {if (!document.querySelector('[role="dialog"]')) composer.current?.focus();});
  const quoteKnowledge=useCallback((text:string)=>{setDraft(previous=>[previous,text].filter(Boolean).join('\n\n'));setKnowledgeOpen(false);requestAnimationFrame(()=>composer.current?.focus());},[setDraft]);
  const newConversation = async () => {
    setKnowledgeOpen(false);
    if (!await w.newSession()) return false;
    follow.current = true; setAwayFromLatest(false); focusComposer(); return true;
  };
  const hideTerminal = () => {setTerminalVisible(false); focusComposer();};
  const toggleTerminal = () => { if (!workValid || !w.work) return; const root=w.work.root;setTerminals(previous=>({...previous,[w.id]:previous[w.id]||{root,report:w.report}})); if (terminalVisible) hideTerminal(); else setTerminalVisible(true); };
  const chooseFile = async () => {if (!w.work) return; try {const selected = await api.choosePreview(w.work.root); if (selected) {setFile(selected); openPanel('preview');}} catch (e) {w.report(e);} };
  const openWeb = async () => { if (!url.trim()) return; setWebBusy(true); setWebError(''); try {await api.webPreview(url.trim()); setWeb(false);} catch (e) {setWebError(errorText(e));} finally {setWebBusy(false);} };
  const addImages=(added:DraftImage[])=>setImages(previous=>{try{validateInput('',[...previous,...added]);return [...previous,...added];}catch(e){queueMicrotask(()=>w.report(e));return previous;}});
  const attachImages=async(files:File[])=>{setImageBusy(true);try{const added=await Promise.all(files.map(readImage));addImages(added);}catch(e){w.report(e);}finally{setImageBusy(false);}};
  const paste=(e:ClipboardEvent<HTMLTextAreaElement>)=>{
    const files=Array.from(e.clipboardData.files),text=e.clipboardData.getData('text/plain');if(!files.length&&!text)return;e.preventDefault();
    if(text){const el=e.currentTarget,start=el.selectionStart,end=el.selectionEnd;try{
      if(shouldAttachText(text)){
        const next=el.value?draft.slice(0,start)+draft.slice(end):draft;
        const added:DraftTextAttachment={id:crypto.randomUUID(),name:`粘贴文本 ${textAttachments.length+1}.md`,text,mode:'file'};
        validateTextAttachments(next,[...textAttachments,added]);setDraft(next);setTextAttachments(previous=>[...previous,added]);
      }else{const next=el.value?draft.slice(0,start)+text+draft.slice(end):draft+text;validateTextAttachments(next,textAttachments);setDraft(next);}
    }catch(error){w.report(error);}}
    if(files.length)void attachImages(files);
  };
  const send = async () => {
    const text = draft;
    if ((!text.trim()&&!images.length&&!textAttachments.length) || !workValid || imageBusy || sendPending.current.has(w.id) || w.connection === 'closing' || importBusy) return;
    try{validateTextAttachments(text,textAttachments);validateInput(composeTextPrompt(text,textAttachments.filter(f=>f.mode==='inline')),images);}catch(e){w.report(e);return;}
    const local = /^\/(resume|model|models|new)(?:\s+([\s\S]*))?$/.exec(text);
    if (local) {
      if(images.length||textAttachments.length){w.setError('此界面命令不接收附件，请先发送或移除附件。');return;}
      if (local[2]?.trim()) {w.setError(`/${local[1]} 请通过打开的面板操作，不接收文本参数。`); return;}
      if (local[1] === 'resume') {openPanel('history'); void w.refreshHistory(); setDraft(''); return;}
      if (local[1] === 'new') {if (await newConversation()) setDraft(''); return;}
      if (w.busy) {w.setError('请先停止当前任务，再切换模型。'); return;}
      setModelsOpen(true); setDraft(''); return;
    }
    sendPending.current.add(w.id); setDraft('');setImages([]);latest();
    // Keep raw text attachments in durable drafts until native prompt acceptance.
    // New attachments pasted while a send is pending belong to the next message.
    try {if (await w.send(text,nativeImages(images),textAttachments)) {setTextAttachments(previous=>previous.filter(f=>!textAttachments.some(sent=>sent.id===f.id)));}
      else {setDraft(previous => previous ? `${text}\n${previous}` : text);setImages(previous=>[...images,...previous]);}}
    finally {sendPending.current.delete(w.id);}
  };
  const stop = async (id=w.id) => {
    const target=w.sessions.find(s=>s.id===id);if(!target)return;
    const restored = await target.stop();
    const text = (restored || []).map((item: any) => item.text || '').filter(Boolean).join('\n\n');
    if (text) setDraftForKey(target.draftKey,previous => [text, previous].filter(Boolean).join('\n\n'));
    const restoredImages=(restored||[]).flatMap((item:any)=>item.images||[]).map((image:any)=>({...image,id:crypto.randomUUID(),name:'恢复的待处理图片'}));
    if(restoredImages.length)setImagesForKey(target.draftKey,previous=>[...previous,...restoredImages]);
  };
  const importFile = async () => {if (importBusy) return;setImportBusy(true);let source:string|null=null;try{source=await api.chooseSession();}catch(e){w.report(e);}finally{setImportBusy(false);}if(source)await w.resume({path:source},{copy:true});};
  const applyClientSettings=async(next:ClientSettings,nextTheme:string,changed:boolean)=>{
    if(changed){
      const saved=await api.saveSettings(next);setClientSettings(saved);await w.refreshHistory();w.log('默认设置已保存，已有连接继续运行','success',saved.runtime==='wsl'?'新连接使用 WSL 原生 OMP':'新连接使用 Windows 原生 OMP');
    }
    setTheme(nextTheme);
  };
  const resume = async (entry: HistoryEntry,copy=false) => {follow.current = true; setAwayFromLatest(false);await w.resume(entry,{copy});};
  const restoreHistory=async(key:string)=>{if(!w.work||trashBusy)return;const root=w.work.root;setTrashBusy(true);setTrashError('');try{await api.restoreHistory(root,key);await w.refreshHistory(root);}catch(e){setTrashError(errorText(e));}finally{setTrashBusy(false);}};
  const searchMemory = async (input=query) => {if (!input.trim() || memoryBusy) return; setMemoryBusy(true); setMemoryError(''); setMemory(''); try {const result = await api.context(input.trim()); setMemory((result.content || []).map((x: any) => x.text || '').join('\n') || '没有找到匹配内容。'); w.log('Stele 检索完成', 'success');} catch (e) {setMemoryError(errorText(e)); w.log('Stele 检索失败', 'error', String(e));} finally {setMemoryBusy(false);} };
  const entries = [...(w.history?.managed || []), ...(w.history?.sessions || [])];
  const filteredHistory = entries.filter(e => (historySource === 'all' || (e.runtime || (e.sessionFile?'windows':'wsl'))===historySource) && `${e.title || ''} ${e.id || ''} ${e.path || e.sessionFile || ''}`.toLowerCase().includes(historySearch.trim().toLowerCase())).sort((a, b) => (Date.parse(b.modifiedAt || b.importedAt || b.modified || '') || 0) - (Date.parse(a.modifiedAt || a.importedAt || a.modified || '') || 0));
  const selectedName = w.work?.name || '选择工作区';
  const status = w.connection === 'closing' ? '正在结束会话' : w.connection === 'starting' ? '正在连接 OMP' : w.questions.length ? '等待你回复' : w.busy ? phaseLabels[w.run!.phase] : w.connection === 'ready' ? '会话已连接' : '准备开始';
  const sessionRows = (root:string) => <div className="open-sessions" aria-label="已打开的会话">{w.sessions.filter(s=>s.root===root).map(s=><div className={`open-session ${s.id===w.id?'selected':''}`} key={s.id}>
    <button className="session-select" data-session={s.id} aria-current={s.id===w.id?'true':undefined} title={s.title} onClick={()=>{setKnowledgeOpen(false);w.selectSession(s.id);}}><span className={`session-dot ${s.questions?'needs-input':s.busy||s.connection==='starting'?'running':s.error?'failed':s.unread?'unread':''}`}/><span className="session-row-label">{s.title}<small>{s.questions?'等待你回复':s.connection==='starting'?'正在连接':s.busy?'正在运行':s.error?'需要关注':s.outcome==='aborted'?'已停止':s.unread?'已完成 · 未读':s.connection==='ready'?'已连接':'未连接'}</small></span></button>
    <button className="session-dismiss" aria-label={`关闭会话 ${s.title}`} disabled={s.busy||s.connection==='starting'||s.connection==='closing'} title="关闭连接并从列表移除，历史仍保留" onClick={()=>void w.dismiss(s.id)}><X size={12}/></button>
  </div>)}</div>;
  const historyList = (items: HistoryEntry[], compact = false) => <div className={`history-list ${compact ? 'compact' : ''}`}>{items.map((entry, index) => <div className="history-item" key={entry.sessionFile || entry.path || index}><button className="history-row" title={[entry.title||entry.id||'未命名会话',entry.sessionFile||entry.path,entry.modifiedAt||entry.importedAt||entry.modified].filter(Boolean).join('\n')} aria-current={entry.sessionFile === w.sessionFile && w.connection === 'ready' ? 'true' : undefined} onClick={() => void resume(entry)}>
    <MessageSquare size={15}/><span className="history-label"><span>{entry.title || entry.id || '未命名会话'}</span>{!compact && <small>{entry.sessionFile === w.sessionFile && w.connection === 'ready' ? '当前会话 · ' : ''}<strong className="history-origin">{historyLabel(entry,runtime)}</strong>{dateLabel(entry) && ` · ${dateLabel(entry)}`}</small>}</span>{compact ? <time>{dateLabel(entry)}</time> : <ArrowUpRight size={14}/>}
  </button>{!compact&&<><button className="icon-button history-copy" title="创建独立副本并继续，原件保留" aria-label={`创建副本并继续 ${entry.title||entry.id||'未命名会话'}`} disabled={importBusy} onClick={()=>void resume(entry,true)}><CopyPlus size={14}/></button><button className="icon-button history-delete" title="移到客户端回收站" aria-label={`删除历史 ${entry.title||entry.id||'未命名会话'}`} onClick={()=>{setTrashError('');setDeleteTarget({entry,root:w.work!.root});}}><Trash2 size={14}/></button></>}</div>)}</div>;
  const onWindowAction=useRef<(action:string)=>void>(()=>{});
  onWindowAction.current=action=>{
    if(action==='new-session')void newConversation().catch(w.report);
    if(action==='search-work'){setFilter('');setPalette(true);}
    if(action==='settings')setSettingsOpen(true);
    if(action==='toggle-sidebar')setSidebar(value=>!value);
    if(action==='toggle-panel'){setKnowledgeOpen(false);toggleToolsPanel(!panel);}
    if(action==='knowledge')openKnowledge();
    if(action==='sessions')setSection('sessions');
    if(action==='about')setAbout(true);
  };
  useEffect(()=>customChrome?api.windowChrome!.onAction(action=>onWindowAction.current(action)):undefined,[customChrome]);
  return <Tooltip.Provider><div className={`desktop-window ${customChrome?'with-window-chrome':''} ${demoMode?'demo-window':''}`}>{customChrome&&<WindowTitlebar onError={w.report}/>} {demoMode&&<div className="demo-banner" role="note">演示数据 · 此窗口不连接真实 OMP、WSL 或 Stele</div>}<div data-session-id={w.id} className={`app-shell ${sidebar ? '' : 'rail-mode'} ${section!=='workbench'?'utility-open':''} ${knowledgeOpen ? 'knowledge-open' : section==='workbench'&&panel ? 'with-panel' : ''} ${sidebarResizing ? 'resizing-sidebar' : ''}`} style={{'--panel-width': `${visiblePanelWidth}px`, '--sidebar-width': `${visibleSidebarWidth}px`} as CSSProperties}>
    <aside className="sidebar" id="workspace-navigation" aria-label={knowledgeOpen?'知识库导航':'工作区导航'}>
      {sidebar && <div className="sidebar-resizer" role="separator" aria-label="调整左侧栏宽度" aria-controls="workspace-navigation" aria-orientation="vertical" aria-valuemin={activeSidebarMin} aria-valuemax={sidebarLimit} aria-valuenow={visibleSidebarWidth} aria-valuetext={`${visibleSidebarWidth} 像素`} tabIndex={0} title="拖动调整侧栏宽度；双击恢复默认宽度"
        onDoubleClick={() => (knowledgeOpen?setKnowledgeSidebarWidth:setSidebarWidth)(knowledgeOpen?340:sidebarDefaultWidth)}
        onKeyDown={e => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault(); resizeSidebar(e.key === 'Home' ? activeSidebarMin : e.key === 'End' ? sidebarLimit : visibleSidebarWidth + (e.key === 'ArrowLeft' ? -16 : 16));
        }}
        onPointerDown={e => {if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); sidebarDrag.current = {startX: e.clientX, startWidth: visibleSidebarWidth}; e.currentTarget.setPointerCapture(e.pointerId); setSidebarResizing(true);}}
        onPointerMove={e => {const drag = sidebarDrag.current; if (drag && e.currentTarget.hasPointerCapture(e.pointerId)) resizeSidebar(drag.startWidth + e.clientX - drag.startX);}}
        onPointerUp={e => {if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); endSidebarDrag();}}
        onPointerCancel={endSidebarDrag} onLostPointerCapture={endSidebarDrag}/>} 
      <div className="brand-row"><button className="brand" onClick={() => setAbout(true)} aria-label="关于 Lucyna"><span className="brand-symbol"><BrandLogo size={32}/></span>{sidebar && <span>Lucyna<span className="brand-caption">{knowledgeOpen?'知识库':'工作台'}</span></span>}</button>{sidebar && <SidebarIconButton icon={PanelLeftClose} label="收起侧栏 · Ctrl B" onClick={() => setSidebar(false)}/>}</div>
      {!sidebar && <SidebarIconButton icon={PanelLeftOpen} label="展开侧栏 · Ctrl B" onClick={() => setSidebar(true)}/>}
      <PrimaryNavigation section={section} expanded={sidebar&&viewportWidth>760} count={w.sessions.filter(s=>s.connection!=='idle').length} onChange={next=>{if(next==='knowledge')setKnowledgeVisited(true);setSection(next);}}/>
      <div className="work-sidebar-content" hidden={knowledgeOpen}>
      {sidebar ? <><button className="nav-action new-chat" onClick={() => void newConversation()} disabled={!workValid}><Plus size={17}/><span>新会话</span></button><button className="nav-action" onClick={() => {setPalette(true); setFilter('');}}><Search size={16}/><span>搜索工作区</span><kbd>Ctrl K</kbd></button></> : <><SidebarIconButton icon={Plus} label="新会话" disabled={!workValid} onClick={() => void newConversation()}/><SidebarIconButton icon={Search} label="搜索工作区" onClick={() => setPalette(true)}/></>}
      {!sidebar && <SidebarIconButton icon={ClipboardCheck} label="查看工作区检查" onClick={() => setWorkChecksOpen(true)}/>}
      <nav className="compact-navigation" aria-label="工作区快捷导航"><span className="rail-divider"/>
        <SidebarIconButton icon={FolderOpen} label={w.work ? `当前工作区：${w.work.name} · 查看概览` : '选择工作区'} active={!!w.work} onClick={() => w.work ? openPanel('work') : setPalette(true)}/>
        <SidebarIconButton icon={HistoryIcon} label="历史会话" disabled={!workValid} onClick={() => openPanel('history')}/>
      </nav>
      <div className="workspace-section"><div className="section-label">{sidebar && <span>工作区</span>}<div className="work-section-actions">{sidebar && <button className="work-check-button" aria-label="查看工作区检查" onClick={() => setWorkChecksOpen(true)}><ClipboardCheck size={13}/>{workIssueCount ? `${workIssueCount} 项检查` : '检查'}</button>}<Tip text="从 WSL 刷新"><button className="icon-button" aria-label="刷新工作区" onClick={() => void w.loadWorks()} disabled={w.loading}>{w.loading ? <Spinner size={14}/> : <RefreshCw size={14}/>}</button></Tip></div></div>
        {sidebar&&<div className="work-list-filter"><label>显示<select aria-label="工作区筛选" value={workFilter} onChange={e=>setWorkFilter(e.target.value)}><option value="all">全部工作区</option><option value="recent">最近使用优先</option><option value="open">有打开的会话</option><option value="attention">有待处理或未读结果</option></select></label></div>}
        <nav className="work-list">{w.loading && !w.works.length ? <div className="skeleton-list" aria-label="正在读取工作区"><i/><i/><i/></div> : visibleWorks.length ? visibleWorks.map(work => <div className="work-group" key={work.root}><Tip text={`${work.name} · ${work.root}`} side="right"><button className={`work-row ${work.root === w.work?.root ? 'selected' : ''}`} aria-current={work.root === w.work?.root ? 'page' : undefined} onClick={() => pick(work)}>
          {work.root === w.work?.root ? <FolderOpen size={17}/> : <Folder size={17}/>} {sidebar && <><span>{work.name}</span>{work.kind === 'invalid' ? <CircleX size={13} aria-label="工作区存在阻断错误"/> : workIssues(work).some(i=>i.severity==='warning') ? <TriangleAlert size={13} className="work-warning-icon" aria-label="工作区有登记提醒"/> : workIssues(work).length ? <Info size={13} className="work-info-icon" aria-label="工作区有兼容记录"/> : null}</>}
        </button></Tip>{sidebar&&sessionRows(work.root)}</div>) : sidebar && <p className="sidebar-empty">{workFilter!=='all'?'当前筛选没有工作区，可切换到全部。':previewMode ? '在桌面客户端中连接 WSL 工作区' : '未发现工作区，点击刷新重试。'}</p>}</nav>
      </div>
      {sidebar && w.work && <button className="nav-action history-shortcut" onClick={() => openPanel('history')}><HistoryIcon size={16}/><span>历史会话</span>{entries.length > 0 && <span className="count">{entries.length}</span>}</button>}
      </div>
      <div className="knowledge-sidebar-slot" ref={setKnowledgeSidebarTarget} hidden={!knowledgeOpen}/>
      <div className="sidebar-bottom"><div className="sidebar-footer-actions"><SidebarIconButton icon={SlidersHorizontal} label="设置" onClick={()=>setSettingsOpen(true)}/><SidebarIconButton icon={theme === 'light' ? Moon : Sun} label={theme === 'light' ? '切换深色外观' : '切换浅色外观'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}/>{sidebar && <><span className="footer-host">{runtimeLabel}</span><SidebarIconButton icon={CircleHelp} label="关于与快捷键" onClick={() => setAbout(true)}/></>}</div>{sidebar && <div className="profile-row"><span className="profile-avatar">L</span><span>本地工作空间<small>{previewMode ? '浏览器界面预览' : runtimeLabel+' · 原生运行时'}</small></span><Check size={13}/></div>}</div>
    </aside>
    <main className="workspace-main" hidden={section!=='workbench'}>
      <header className="workspace-header"><div className="breadcrumb"><FolderOpen size={16}/><button onClick={() => setPalette(true)}>{selectedName}<ChevronDown size={13}/></button><span className="breadcrumb-divider">/</span><button className="session-title" title={w.title} onClick={() => openPanel('history')}>{w.title}</button></div><div className="header-actions">
        <SidebarIconButton icon={TerminalSquare} label="WSL 终端" active={terminalVisible} disabled={!workValid} onClick={toggleTerminal}/>
        <SidebarIconButton icon={Globe2} label="打开网页预览" onClick={() => {setWeb(true); setWebError('');}}/>
        <SidebarIconButton icon={FileImage} label="预览 Markdown 或图片" disabled={!workValid} onClick={() => void chooseFile()}/>
        {!panel && <><span className="toolbar-divider"/><SidebarIconButton icon={PanelRightOpen} label="展开工具面板" aria-controls="tools-panel" aria-expanded={false} onClick={() => toggleToolsPanel(true)}/></>}
      </div></header>
      {previewMode && <div className="preview-banner">浏览器外观预览 · 会话与 WSL 功能请在桌面客户端使用</div>}
      <WorkHealthNotice work={w.work} onOpen={() => setWorkChecksOpen(true)}/>
      {(draftError||imageError||textAttachmentError) && <div className="notice" role="alert"><CircleX size={16}/><span>{draftError||imageError||textAttachmentError}</span><Button compact variant="secondary" onClick={()=>{retryDrafts();retryImages();retryTextAttachments();}}>重试读取与保存</Button></div>}
      {w.error && <div className="notice" role="alert"><CircleX size={16}/><span>{w.error}</span><button className="icon-button" onClick={() => w.setError('')} aria-label="关闭错误提示"><X size={15}/></button></div>}
      {w.questions[0]&&deferredQuestion===w.questions[0].id&&<div className="pending-question"><span>此会话正在等待你的回复</span><Button compact variant="secondary" onClick={()=>setDeferredQuestion('')}>查看问题</Button></div>}
      {w.connection==='starting'&&<ConnectionProgress phase={w.connectionPhase} started={w.connectionStarted||Date.now()}/>}
      <div className={`chat-stage ${w.messages.length ? 'has-messages' : ''}`}>
        {w.messages.length > 0 ? <div className="transcript-region"><div className="transcript" ref={transcript} onScroll={() => {if(section!=='workbench')return;const el = transcript.current!; follow.current = endIndex===w.messages.length&&el.scrollHeight - el.scrollTop - el.clientHeight < 100; readingPositions.current.set(w.id,{top:el.scrollTop,follow:follow.current});setAwayFromLatest(!follow.current);}} aria-label="会话记录">
          <div className="message-column">{startIndex>0&&<button className="load-earlier" onClick={earlier}>查看更早的记录 · 还有 {startIndex} 条</button>}<SessionTranscript messages={w.messages.slice(startIndex,endIndex)} busy={w.busy&&endIndex===w.messages.length} jumpTarget={jumpTarget} onError={w.report} onImage={setZoom}/>
            {endIndex<w.messages.length?<button className="load-earlier load-later" onClick={()=>{const end=Math.min(w.messages.length,endIndex+historyBatch);setHistoryEndAnchor(end<w.messages.length?w.messages[end-1].id:'');}}>查看后续记录 · 还有 {w.messages.length-endIndex} 条</button>:<RunActivity run={w.run} waitingInput={!!w.questions.length} onEvents={() => openPanel('events')}/>}
          </div>
        </div><ConversationTimeline key={w.id} entries={timelineEntries} total={w.messages.length+(w.questions.length?1:0)} selected={jumpTarget} onJump={jumpTo} transcript={transcript}/></div> : <div className="welcome"><div className="welcome-mark welcome-character"><BrandCompanions/></div><h1>想从哪里继续？</h1><p>{w.work ? `在 ${w.work.name} 中，与 OMP 一起工作。` : '选择工作区，开始新任务，或接着上次的思路。'}</p></div>}
        <div className="composer-area">
          {awayFromLatest && <button type="button" className="jump-latest" onClick={latest}>回到最新消息 <ChevronDown size={13}/></button>}
          {w.queued.length > 0 && <div className="queued-messages" aria-label="OMP 待处理消息"><div className="queue-caption"><Clock3 size={12}/>OMP 待处理 · {w.queued.length}</div>{w.queued.map((item, i) => <div className="queued-message" key={`${item.queue}-${i}`}><span title={item.message}>{item.message}</span><button type="button" aria-label={`移除待处理消息 ${i + 1}`} onClick={() => void w.removeQueued(item)}><X size={13}/></button></div>)}</div>}
          <form className="composer" onSubmit={e => {e.preventDefault(); void send();}}>
          <TextAttachments key={'texts-'+w.id} files={textAttachments} onChange={setTextAttachments} pending={w.sending}/>
          {w.sending&&textAttachments.length>0&&<p className="attachment-loading" role="status"><Spinner size={12}/> 正在提交文本附件…</p>}
          {images.length>0&&<div className="composer-attachments" aria-label="待发送图片">{images.map(img=><div key={img.id}><button type="button" title={img.name} aria-label={`预览附件 ${img.name}`} onClick={()=>setZoom(`data:${img.mimeType};base64,${img.data}`)}><img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name}/></button><button type="button" aria-label={`移除附件 ${img.name}`} onClick={()=>setImages(previous=>previous.filter(x=>x.id!==img.id))}><X size={12}/></button></div>)}</div>}
          {imageBusy&&<p className="attachment-loading" role="status">正在读取图片…</p>}
          <input ref={imagePicker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value='';void attachImages(files);}}/>
          <CommandInput key={w.id} inputRef={composer} draft={draft} setDraft={setDraft} onSend={() => void send()} root={w.work?.root} openRequest={commandOpenRequest}
            onPaste={paste}
            onCompletionActive={setCompletionActive}
            nativeCommands={w.nativeCommands} status={w.commandsStatus} error={w.commandsError} loadCommands={w.loadCommands}
            disabled={!workValid || importBusy || w.connection === 'closing'} placeholder={!workValid ? '先从左侧选择工作区…' : w.busy ? '补充下一条消息，OMP 会在当前任务后处理…' : '交给 OMP 一个任务，或输入 / 使用技能…'}/>
          <div className="composer-toolbar"><div className="composer-tools"><Tip text="添加图片，也可直接粘贴"><button type="button" className="icon-button" aria-label="添加图片" disabled={!workValid||imageBusy||importBusy} onClick={()=>imagePicker.current?.click()}><FileImage size={17}/></button></Tip><Tip text="技能与命令 · 输入 /"><button type="button" className="icon-button" aria-label="技能与命令" disabled={!workValid || importBusy || w.connection === 'closing'} onClick={() => setCommandOpenRequest(v => v + 1)}><Plus size={18}/></button></Tip><button type="button" className="composer-chip" onClick={() => setPalette(true)}><Folder size={13}/><span>{selectedName}</span><ChevronDown size={11}/></button></div>
            <div className="composer-tools"><Tip text="选择 OMP 原生模型"><button type="button" className="model-control" disabled={!workValid || w.busy || importBusy || w.connection === 'starting' || w.connection === 'closing'} onClick={() => setModelsOpen(true)}><Zap size={12}/><span>{w.model}</span><ChevronDown size={11}/></button></Tip>{w.busy && w.connection === 'ready' && <button type="button" className="send-button stop-button" aria-label="停止生成" disabled={w.run?.phase === 'stopping'} onClick={() => void stop()}>{w.run?.phase === 'stopping' ? <Spinner size={14}/> : <Square size={14} fill="currentColor"/>}</button>}{(!w.busy || !!draft.trim() || images.length>0 || textAttachments.length>0 || w.connection === 'starting') && <button type="submit" className="send-button" aria-label={w.busy && w.connection === 'ready' ? '加入待处理消息' : '发送消息'} disabled={(!draft.trim()&&!images.length&&!textAttachments.length) || w.sending || imageBusy || !workValid || importBusy || (w.connection === 'starting' && w.busy) || w.connection === 'closing' || w.run?.phase === 'stopping'}>{w.connection === 'starting' ? <Spinner size={16}/> : <ArrowUp size={18}/>}</button>}</div>
          </div>
        </form><div className="composer-footnote"><span>{w.connection === 'starting' && <Spinner size={11}/>} {status}</span><span>{completionActive ? 'Tab / Enter 补全' : w.busy ? 'Enter 加入待处理' : 'Enter 发送'} <span className="footnote-separator">·</span> Shift Enter 换行</span></div>
          {!w.messages.length && <div className="starter-actions"><button disabled={!workValid} onClick={() => {setDraft('/work-review'); composer.current?.focus();}}><Check size={14}/>检查工作状态</button><button disabled={!workValid} onClick={() => openPanel('history')}><Clock3 size={14}/>继续历史会话</button><button onClick={() => openPanel('memory')}><BookOpen size={14}/>检索 Stele 记忆</button></div>}
        </div>
        {!w.messages.length && w.work && <section className="recent-sessions"><div className="recent-header"><span>最近会话</span><button onClick={() => openPanel('history')}>查看全部 <ArrowUpRight size={12}/></button></div>{w.historyError ? <button className="text-action" onClick={() => void w.refreshHistory()}>会话读取失败，点击重试</button> : !w.history ? <div className="inline-loading"><Spinner size={13}/>读取会话…</div> : entries.length ? historyList(entries.slice(0, 3), true) : <p className="empty-line">还没有历史会话。发送第一条消息即可开始。</p>}</section>}
      </div>
      {Object.entries(terminals).filter(([id])=>w.sessions.some(s=>s.id===id)).map(([id,t])=><TerminalPanel key={id} root={t.root} visible={id===w.id&&!!terminalVisibility[id]} theme={theme} onHide={hideTerminal} onActive={()=>{}} onError={t.report}/>)}
      <footer className="workspace-status"><span><Folder size={11}/>{w.work?.root || '工作区保留在 WSL'}</span><button onClick={() => openPanel('events')}><SlidersHorizontal size={12}/>{w.connection === 'ready' ? 'OMP 已连接' : 'OMP'}</button></footer>
    </main>
    {knowledgeVisited&&<KnowledgePanel sidebarTarget={knowledgeSidebarTarget} sidebarExpanded={sidebar&&viewportWidth>760} active={knowledgeOpen} workName={w.work?.name||''} onQuote={quoteKnowledge}/>}
    <SessionMonitor active={section==='sessions'} sessions={w.sessions} onOpen={id=>{setPetTarget(id);setSection('workbench');w.selectSession(id);}} onStop={id=>void stop(id)} onClose={id=>void w.sessions.find(s=>s.id===id)?.close()}/>
    <aside id="tools-panel" hidden={!panel||section!=='workbench'} className="tools-panel" aria-label="工具面板"><div className="panel-resizer" role="separator" aria-label="调整工具面板宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={520} aria-valuenow={visiblePanelWidth} tabIndex={0} onKeyDown={e => {if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {e.preventDefault(); setPanelWidth(v => Math.max(320, Math.min(520, v + (e.key === 'ArrowLeft' ? 16 : -16))));}}} onPointerDown={e => {e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e => {if (e.currentTarget.hasPointerCapture(e.pointerId)) setPanelWidth(Math.max(320, Math.min(520, window.innerWidth - e.clientX)));}} onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)}/>
      <div className="panel-header"><SidebarIconButton icon={PanelRightClose} label="收起工具面板" aria-controls="tools-panel" aria-expanded={true} onClick={() => toggleToolsPanel(false)}/><SegmentedControl value={tab} options={tabs.map(t => ({...t, id: `tab-${t.value}`, 'aria-controls': `tool-panel-${t.value}`}))} role="tablist" onValueChange={setTab} aria-label="工具面板" height={30} optionHeight={26}/><span className="panel-header-balance" aria-hidden="true"/></div>
      <PanelPage name="history" active={panel && tab === 'history'} identity={w.work?.root || ''}>
        <div className="panel-title"><h2>历史会话</h2><button className="icon-button" aria-label="刷新历史会话" disabled={!workValid} onClick={() => void w.refreshHistory()}><RefreshCw size={14}/></button></div>
        <p className="panel-intro">{w.work ? w.work.name : '选择一个工作区查看会话。'}</p>
        {workValid && <><div className="history-filters"><Input aria-label="搜索历史会话" placeholder="搜索标题或会话 ID…" value={historySearch} onChange={setHistorySearch}/><select aria-label="会话来源" value={historySource} onChange={e => setHistorySource(e.target.value)}><option value="all">全部来源</option><option value="windows">Windows</option><option value="wsl">WSL</option></select></div>
        {w.work&&sessionRows(w.work.root)}
        <div className="panel-buttons"><Button variant="secondary" compact onClick={() => void importFile()} disabled={importBusy} loading={importBusy}><Import size={13}/>导入副本</Button>{w.connection === 'ready' && <Button variant="secondary" compact disabled={w.busy} onClick={() => void w.close()}>结束会话</Button>}</div>
        <p className="helper-text">WSL 原生历史直接续聊 · 已有副本继续写入副本 · 跨环境时创建新副本</p>
        {!!w.history?.trash?.length&&<button className="trash-link" onClick={()=>{setTrashError('');setTrashOpen(true);}}><Trash2 size={13}/>回收站 · {w.history.trash.length}</button>}
        {w.historyError ? <p role="alert" className="error-text">{w.historyError}</p> : !w.history ? <div className="inline-loading"><Spinner size={14}/>读取中…</div> : <><p className="results-caption">{filteredHistory.length} / {entries.length} 个会话</p>{filteredHistory.length ? historyList(filteredHistory) : <p className="empty-line">{historySearch || historySource !== 'all' ? '没有匹配的会话，试试其他关键词或来源。' : '没有发现此工作区的历史会话。'}</p>}{(w.history.warnings || []).map((warning, i) => <p key={i} className="helper-text">{warning}</p>)}</>}</>}
      </PanelPage>
      <PanelPage name="work" active={panel && tab === 'work'} identity={w.work?.root || ''}>
        {w.work ? <WorkDetails work={w.work} connections={w.sessions.filter(s=>s.root===w.work?.root&&['ready','starting','closing'].includes(s.connection)).length} onConnections={()=>setSection('sessions')} active={panel&&tab==='work'&&section==='workbench'} history={entries} onOpen={next=>{setFile(next);openPanel('preview');}} onResume={entry=>void resume(entry)} onCommand={command=>{setDraft(previous=>[command,previous].filter(Boolean).join('\n\n'));focusComposer();}} onMemory={value=>{setQuery(value);openPanel('memory');void searchMemory(value);}} onError={w.report}/> : <Empty icon={FolderOpen} title="选择工作区" description="查看工作进展、仓库与 Worktree，以及工作资产。"/>}
      </PanelPage>
      <PanelPage name="preview" active={panel && tab === 'preview'} identity={w.work?.root || ''}>
        {w.sessions.map(s=><div key={s.id} hidden={s.id!==w.id} className="session-preview"><PreviewPane selected={sessionFiles[s.id]||null} root={s.root} active={s.id===w.id&&panel&&tab==='preview'} choose={() => void chooseFile()} onError={s.report} onImage={setZoom}/></div>)}
      </PanelPage>
      <PanelPage name="memory" active={panel && tab === 'memory'} identity="stele">
        <div className="panel-title"><h2>Stele 记忆</h2><Button variant="secondary" compact onClick={openKnowledge}>知识库<ArrowUpRight size={13}/></Button></div><p className="panel-intro">查找长期知识，引用到当前对话。</p>
        <form className="memory-search" onSubmit={e => {e.preventDefault(); void searchMemory();}}><Input aria-label="搜索 Stele 记忆" placeholder="搜索问题、决定或项目知识…" value={query} onChange={setQuery}/><Button variant="cta" size="sm" compact disabled={!query.trim() || memoryBusy} loading={memoryBusy} type="submit">检索</Button></form>
        {memoryError && <p className="error-text" role="alert">{memoryError}</p>}{memoryBusy && <div className="inline-loading" role="status"><Spinner size={14}/>正在检索 Stele…</div>}
        {memory ? <MemoryResults text={memory} canQuote={workValid && !importBusy && w.connection !== 'closing'} onError={w.report} onQuote={text => {setDraft(previous => [previous, text].filter(Boolean).join('\n\n')); focusComposer();}}/> : !memoryBusy && <Empty icon={BookOpen} title="让已有经验接上新任务" description="输入关键词检索 Work 的 L3 知识。"/>}
        <div className="memory-note"><Layers2 size={15}/><span>Work 管理工作上下文<br/>Stele 保存 L3 长期知识</span></div>
      </PanelPage>
      <PanelPage name="events" active={panel && tab === 'events'} identity={w.work?.root || ''}>
        <EventsPanel events={w.events} root={w.work?.root} status={status} onError={w.report}/>
      </PanelPage>
    </aside>
    <HistoryDeletionDialog target={deleteTarget} onClose={()=>setDeleteTarget(null)} onDeleted={w.refreshHistory}/>
    <Modal open={trashOpen} onClose={()=>{if(!trashBusy)setTrashOpen(false);}} title="历史回收站" description="恢复会将会话及关联备忘放回原位置。若原位置已有文件，会保留两边文件并提示处理。">{trashError&&<p role="alert" className="error-text">{trashError}</p>}<div className="history-trash-list">{w.history?.trash?.length?w.history.trash.map(item=><div className="trash-item" key={item.key}><span>{item.entry.title||item.entry.id||'未命名会话'}<small>{item.version===2?`${item.files?.length||0} 项文件${item.state!=='trashed'?' · 待完成恢复':''}`:'旧版隐藏记录 · 原文件未移动'}</small></span><Button compact variant="secondary" loading={trashBusy} disabled={trashBusy} onClick={()=>void restoreHistory(item.key)}><Undo2 size={13}/>恢复</Button></div>):<p className="muted">回收站为空</p>}</div></Modal>
    <Modal open={workReading} onClose={() => setWorkReading(false)} title="SESSION.md" description="工作区原始记录 · 可查找内容或通过目录跳转。" className="reading-modal"><DocumentReader file={{name: 'SESSION.md', path: 'SESSION.md', kind: 'markdown', content: w.document}} root={w.work?.root} onNavigate={next => {setFile(next); setWorkReading(false); openPanel('preview');}} onError={w.report}/></Modal>
    <Modal open={palette} onClose={() => setPalette(false)} title="切换工作区" description="搜索 WSL 中的项目，↑ ↓ 选择，Enter 打开。" className="command-palette"><div className="palette-search"><Search size={18}/><Input autoFocus aria-label="搜索工作区" placeholder="按名称或路径搜索…" value={filter} onChange={setFilter} onKeyDown={workNavigation.onKeyDown} role="combobox" aria-expanded={palette} aria-controls="work-search-results" aria-activedescendant={matchingWorks.length ? `work-option-${workNavigation.activeIndex}` : undefined}/><kbd>Esc</kbd></div><div className="palette-results" id="work-search-results" role="listbox" ref={workNavigation.listRef} aria-label="匹配的工作区">{matchingWorks.map((work, index) => <button key={work.root} id={`work-option-${index}`} role="option" aria-selected={index === workNavigation.activeIndex} onPointerMove={() => workNavigation.setSelected(index)} onClick={() => pick(work)}><Folder size={18}/><span>{work.name}<small>{work.root}</small></span>{work.root === w.work?.root ? <Check size={15}/> : <ArrowUpRight size={15}/>}</button>)}{!matchingWorks.length && <p className="empty-line">没有匹配的工作区。</p>}</div></Modal>
    <Modal open={web} onClose={() => {if (!webBusy) setWeb(false);}} title="打开网页" description="网页将在独立预览窗口中打开。"><form onSubmit={e => {e.preventDefault(); void openWeb();}}><Input autoFocus type="url" required aria-label="网页地址" placeholder="https://…" value={url} onChange={setUrl}/>{webError && <p className="error-text" role="alert">{webError}</p>}<div className="modal-actions"><Button variant="secondary" disabled={webBusy} onClick={() => setWeb(false)}>取消</Button><Button variant="cta" loading={webBusy} type="submit">打开预览<ArrowUpRight size={14}/></Button></div></form></Modal>
    <Modal open={about} onClose={() => setAbout(false)} title="关于 Lucyna" description="为原生 OMP 提供桌面界面。"><div className="brand-about"><BrandCompanions/><div><strong>Lucyna</strong><p>银发搭档与黑猫</p></div></div><div className="about-grid"><span>界面</span><strong>React · Cindy 组件</strong><span>执行</span><strong>{runtimeLabel}</strong><span>记忆</span><strong>Work + Stele</strong><span>搜索工作区</span><kbd>Ctrl K</kbd><span>展开 / 收起侧栏</span><kbd>Ctrl B</kbd></div><p className="helper-text">会话副本和客户端设置由 Windows 管理，代码与工作区保留在 WSL。WSL 模式直接读取选定的原生配置目录。Cindy 组件按 Apache-2.0 协议复用。</p></Modal>
    <Modal open={!!zoom} onClose={() => setZoom(null)} title="图片预览" description="按 Esc 关闭，返回当前会话。" className="image-modal">{zoom && <img src={zoom} alt="放大的图片"/>}</Modal>
    {w.questions[0] && <NativeQuestion key={w.id+w.questions[0].id} question={w.questions[0]} onAnswer={w.answer} open={section==='workbench'&&deferredQuestion!==w.questions[0].id} onLater={()=>setDeferredQuestion(w.questions[0].id)}/>}
    {modelsOpen && <ModelPicker key={w.id} start={w.start} request={w.request} choose={w.changeModel} onClose={() => setModelsOpen(false)}/>}
    <WorkDiagnostics works={w.works} open={workChecksOpen} onClose={() => setWorkChecksOpen(false)} loading={w.loading} onRefresh={() => void w.loadWorks()}/>
    {settingsOpen && <SettingsDialog onClose={()=>setSettingsOpen(false)} onApply={applyClientSettings} locked={false} theme={theme}/>}
  </div></div></Tooltip.Provider>;
}
function Empty({icon: Icon, title, description}: {icon: typeof Folder; title: string; description: string}) {return <div className="panel-empty"><Icon size={24} strokeWidth={1.3}/><h3>{title}</h3><p>{description}</p></div>;}
