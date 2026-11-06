import {useEffect,useId,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {ChevronDown,ChevronUp} from 'lucide-react';
import type {WorkAssistantCitation,WorkAssistantSummary} from '../work-assistant-types';

const sections=[
  {key:'nextSteps',label:'下一步',heading:'建议下一步'},
  {key:'openQuestions',label:'未决',heading:'未决问题'},
  {key:'decisions',label:'决定',heading:'决定与方向'},
  {key:'goals',label:'目标',heading:'当前目标'},
  {key:'progress',label:'进展',heading:'进展记录'},
] as const;
type SectionKey=typeof sections[number]['key'];
type CitationRenderer=(source:WorkAssistantCitation,index:number,compact?:boolean)=>ReactNode;
const visibleItemLimit=4;

function ReadableText({text,lines=3}: {text:string;lines?:number}){
  const id=useId(),ref=useRef<HTMLParagraphElement>(null);
  const [expanded,setExpanded]=useState(false),[overflow,setOverflow]=useState(false);
  useEffect(()=>{
    const element=ref.current;
    if(!element)return;
    let live=true;
    const measure=()=>{
      if(!live||!element.getClientRects().length)return;
      const lineHeight=Number.parseFloat(getComputedStyle(element).lineHeight);
      setOverflow(Number.isFinite(lineHeight)&&element.scrollHeight>lineHeight*lines+2);
    };
    const observer=new ResizeObserver(measure);
    observer.observe(element);measure();
    void document.fonts.ready.then(measure);
    return()=>{live=false;observer.disconnect();};
  },[text,lines]);
  return <div className="work-summary-text">
    <p id={id} ref={ref} className={expanded?'is-expanded':'is-collapsed'} style={{WebkitLineClamp:expanded?undefined:lines}}>{text}</p>
    {overflow&&<button className="work-summary-text-toggle" type="button" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(value=>!value)}>
      {expanded?'收起内容':'展开内容'}{expanded?<ChevronUp size={12}/>:<ChevronDown size={12}/>}</button>}
  </div>;
}

function Sources({sources,renderCitation}: {sources:WorkAssistantCitation[];renderCitation:CitationRenderer}){
  const citations=[...new Map(sources.map(source=>[`${source.sessionId}\0${source.messageId}`,source])).values()];
  if(!citations.length)return null;
  return <div className="work-summary-sources" aria-label="对话出处">
    {renderCitation(citations[0],0,true)}
    {citations.length>1&&<details className="work-summary-more-sources">
      <summary aria-label={`查看其余 ${citations.length-1} 条出处`}>另 {citations.length-1} 条出处</summary>
      <div className="work-assistant-citations">{citations.slice(1).map((source,index)=>renderCitation(source,index+1))}</div>
    </details>}
  </div>;
}

export function WorkSummaryReader({summary,stale,renderCitation}: {summary:WorkAssistantSummary;stale:boolean;renderCitation:CitationRenderer}){
  const readerId=useId(),tabRefs=useRef<Array<HTMLButtonElement|null>>([]);
  const [selected,setSelected]=useState<SectionKey>(()=>sections.find(section=>summary[section.key].length)?.key||'nextSteps');
  const [showAll,setShowAll]=useState<Partial<Record<SectionKey,boolean>>>({});
  const section=sections.find(section=>section.key===selected)!,items=summary[selected];
  const all=!!showAll[selected],visible=all?items:items.slice(0,visibleItemLimit);
  const selectIndex=(index:number)=>{setSelected(sections[index].key);tabRefs.current[index]?.focus();};
  return <div className="work-summary-reader">
    <section className="work-assistant-overview">
      <h4>{stale?'上次工作概况':'当前工作概况'}</h4>
      <ReadableText text={summary.overview.text} lines={4}/>
      <Sources sources={summary.overview.sources} renderCitation={renderCitation}/>
    </section>
    <div className="work-summary-tabs" role="tablist" aria-label="摘要栏目">
      {sections.map((item,index)=><button key={item.key} ref={node=>{tabRefs.current[index]=node;}} type="button" role="tab"
        id={`${readerId}-tab-${item.key}`} aria-controls={`${readerId}-panel-${item.key}`} aria-selected={selected===item.key}
        aria-label={`${item.heading}，${summary[item.key].length} 条`} tabIndex={selected===item.key?0:-1}
        onClick={()=>setSelected(item.key)} onKeyDown={event=>{
          let next=index;
          if(event.key==='ArrowRight')next=(index+1)%sections.length;
          else if(event.key==='ArrowLeft')next=(index+sections.length-1)%sections.length;
          else if(event.key==='Home')next=0;
          else if(event.key==='End')next=sections.length-1;
          else return;
          event.preventDefault();selectIndex(next);
        }}><span>{item.label}</span><span className="work-summary-tab-count">{summary[item.key].length}</span></button>)}
    </div>
    {sections.map(item=><section key={item.key} className="work-assistant-group" role="tabpanel" hidden={selected!==item.key}
      id={`${readerId}-panel-${item.key}`} aria-labelledby={`${readerId}-tab-${item.key}`} tabIndex={0}>
      {selected===item.key&&<>
        <h4>{section.heading}<span>{items.length} 条</span></h4>
        {visible.length?<div className="work-summary-list">{visible.map((entry,index)=><article className="work-assistant-item" key={entry.id||`${selected}-${index}-${entry.text}`}>
          <ReadableText text={entry.text}/>
          <Sources sources={entry.sources} renderCitation={renderCitation}/>
        </article>)}</div>:<p className="work-summary-section-empty">此栏目暂无条目。</p>}
        {items.length>visibleItemLimit&&<button type="button" className="work-summary-show-more" aria-expanded={all}
          onClick={()=>setShowAll(value=>({...value,[selected]:!value[selected]}))}>
          {all?<ChevronUp size={14}/>:<ChevronDown size={14}/>} {all?`收起到 ${visibleItemLimit} 条`:`展开其余 ${items.length-visibleItemLimit} 条`}
        </button>}
      </>}
    </section>)}
  </div>;
}
