import {useEffect,useMemo,useRef,useState,type RefObject} from 'react';
import {ListTree,Search,ChevronUp,ChevronDown} from 'lucide-react';
import {Input} from '@cindy/components/ui/input';
import {Tip} from '@cindy/components/ui/tooltip';
import {messageDomId,railEntries,timelineLabels,type TimelineEntry} from '../conversation-timeline';
import '../conversation-timeline.css';
import '../conversation-timeline-inline.css';

export function ConversationTimeline({entries,total,selected,onJump,transcript}:{entries:TimelineEntry[];total:number;selected:string;onJump:(entry:TimelineEntry)=>void;transcript:RefObject<HTMLDivElement|null>}){
 const [query,setQuery]=useState(''),[page,setPage]=useState(0),[reading,setReading]=useState('');
 const list=useRef<HTMLOListElement>(null),rail=useRef<HTMLDivElement>(null),[slots,setSlots]=useState(24);
 useEffect(()=>{const element=rail.current;if(!element)return;const observer=new ResizeObserver(()=>setSlots(Math.max(4,Math.min(24,Math.floor(element.clientHeight/24)-3))));observer.observe(element);return()=>observer.disconnect();},[entries.length>0]);
 const filtered=useMemo(()=>entries.filter(entry=>(timelineLabels[entry.kind]+' '+entry.label).toLowerCase().includes(query.trim().toLowerCase())),[entries,query]);
 const pages=Math.max(1,Math.ceil(filtered.length/30)),current=Math.min(page,pages-1);
 useEffect(()=>setPage(0),[query]);
 useEffect(()=>{if(selected)setReading(selected);},[selected]);
 // Observe only the mounted history window, never measure thousands of journal
 // entries or run a scroll handler on every streamed token in the whole app.
 useEffect(()=>{
  const element=transcript.current;if(!element)return;
  const ids=new Map(entries.map(entry=>[entry.id==='run-status'?'run-status':messageDomId(entry.id),entry.id]));
  let timer:ReturnType<typeof setTimeout>|undefined,width=element.clientWidth,anchor:{id:string;offset:number;bottom:boolean}|undefined;
  const update=()=>{
   timer=undefined;if(!element.clientHeight)return;
   const top=element.getBoundingClientRect().top,guide=top+Math.min(64,element.clientHeight*.15);
   const nodes=Array.from(element.querySelectorAll<HTMLElement>('[id^="message-"],#run-status')).filter(node=>ids.has(node.id));
   let active:HTMLElement|undefined=nodes[0];
   for(const node of nodes){if(node.getBoundingClientRect().top>guide)break;active=node;}
   const bottom=element.scrollHeight-element.scrollTop-element.clientHeight<24;
   if(bottom)active=nodes.at(-1);
   if(active){anchor={id:active.id,offset:active.getBoundingClientRect().top-top,bottom};setReading(ids.get(active.id)!);}
  };
  const schedule=()=>{if(!timer)timer=setTimeout(update,80);};
  const resize=new ResizeObserver(()=>{
   // Switching between the outline and compact rail changes text wrapping. Keep
   // the same passage at the same reading offset instead of reusing raw pixels.
   if(element.clientWidth&&element.clientWidth!==width){
    width=element.clientWidth;const target=anchor&&document.getElementById(anchor.id);
    if(anchor?.bottom)element.scrollTop=element.scrollHeight;
    else if(anchor&&target&&element.contains(target))element.scrollTop+=target.getBoundingClientRect().top-element.getBoundingClientRect().top-anchor.offset;
   }
   schedule();
  });resize.observe(element);if(element.firstElementChild)resize.observe(element.firstElementChild);
  const mutations=new MutationObserver(schedule);mutations.observe(element,{childList:true,subtree:true});
  element.addEventListener('scroll',schedule,{passive:true});schedule();
  return()=>{clearTimeout(timer);resize.disconnect();mutations.disconnect();element.removeEventListener('scroll',schedule);};
 },[entries,transcript]);
 useEffect(()=>{if(query.trim())return;const index=entries.findIndex(entry=>entry.id===reading);if(index>=0)setPage(Math.floor(index/30));},[reading,query,entries]);
 useEffect(()=>{
  const element=list.current,target=element?.querySelector<HTMLElement>('[aria-current="location"]');if(!element||!target||!element.clientHeight)return;
  const bounds=element.getBoundingClientRect(),row=target.getBoundingClientRect();
  if(row.top<bounds.top)element.scrollTop+=row.top-bounds.top;
  else if(row.bottom>bounds.bottom)element.scrollTop+=row.bottom-bounds.bottom;
 },[reading,current,query]);
 const markers=useMemo(()=>{
  const result=railEntries(entries,total,slots),active=entries.find(entry=>entry.id===reading);
  if(active&&!result.some(entry=>entry.id===active.id))result.push(active);
  return result.sort((a,b)=>a.index-b.index);
 },[entries,total,reading,slots]);
 if(!entries.length)return null;
 const railCurrent=markers.some(entry=>entry.id===reading)?reading:markers[0]?.id;
 return <nav className="conversation-timeline is-docked" aria-label="会话关键事件">
  <div className="timeline-outline">
   <header><strong>会话时间轴</strong><span>{entries.length} 个节点</span></header>
   <div className="timeline-search"><Search size={14} aria-hidden="true"/><Input aria-label="搜索会话时间轴" placeholder="搜索会话节点…" value={query} onChange={setQuery}/></div>
   <ol ref={list}>{filtered.slice(current*30,(current+1)*30).map(entry=><li key={entry.id}><button className={'timeline-entry '+entry.kind} onClick={()=>onJump(entry)} aria-current={reading===entry.id?'location':undefined}><small>{timelineLabels[entry.kind]}</small><span>{entry.label}</span></button></li>)}</ol>
   {!filtered.length&&<p className="empty-line" role="status">没有匹配的节点</p>}
   {pages>1&&<footer><button aria-label="更早的会话节点" disabled={!current} onClick={()=>setPage(current-1)}><ChevronUp size={14}/></button><span>{current+1} / {pages}</span><button aria-label="后续会话节点" disabled={current>=pages-1} onClick={()=>setPage(current+1)}><ChevronDown size={14}/></button></footer>}
  </div>
  <span className="timeline-rail-heading" title="会话时间轴"><ListTree size={15} aria-hidden="true"/></span>
  <div className="timeline-rail" ref={rail} onKeyDown={event=>{
   const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button')),index=buttons.indexOf(event.target as HTMLButtonElement);
   const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?Math.min(index+1,buttons.length-1):event.key==='ArrowUp'?Math.max(0,index-1):-1;
   if(next<0)return;event.preventDefault();buttons[next]?.focus({preventScroll:true});
  }}>{markers.map(entry=><Tip key={entry.id} side="left" delay={120} text={<span className="timeline-marker-tip"><small>{timelineLabels[entry.kind]}</small>{entry.label}</span>}><button tabIndex={entry.id===railCurrent?0:-1} className={'timeline-marker '+entry.kind+(reading===entry.id?' selected':'')} style={{top:entry.index/Math.max(1,total-1)*100+'%'}} aria-current={reading===entry.id?'location':undefined} aria-label={'跳转到'+timelineLabels[entry.kind]+'：'+entry.label} onClick={()=>onJump(entry)}/></Tip>)}</div>
 </nav>;
}
