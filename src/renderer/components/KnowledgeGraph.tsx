import {memo,useEffect,useMemo,useRef,useState} from 'react';
import cytoscape, {type Core,type StylesheetStyle} from 'cytoscape';
import {Button} from '@cindy/components/ui/button';
import {Input} from '@cindy/components/ui/input';
import {ArrowLeft,FileText,Search} from 'lucide-react';
import type {KnowledgeDocument,KnowledgeEdge,KnowledgeGraphData} from '../knowledge-types';
import '../knowledge-graph.css';
const emptyMemberships:Record<string,number>={},emptyNodes:KnowledgeDocument[]=[],emptyEdges:KnowledgeEdge[]=[];

export const KnowledgeGraph=memo(function KnowledgeGraph({data,onOpen,onOverview}:{data:KnowledgeGraphData;onOpen:(id:string)=>void;onOverview?:(community:number)=>void}){
  const [workspace,setWorkspace]=useState(''),[query,setQuery]=useState(''),[community,setCommunity]=useState<number|null>(null),[selected,setSelected]=useState(''),[zoom,setZoom]=useState(1),[error,setError]=useState(''),[showSessions,setShowSessions]=useState(false);
  const host=useRef<HTMLDivElement>(null),cy=useRef<Core|null>(null);
  const selectRef=useRef(setSelected);selectRef.current=setSelected;
  const groupRef=useRef(setCommunity);groupRef.current=setCommunity;
  const sourceNodes=data.components||emptyNodes,sourceEdges=data.edges||emptyEdges,memberships=data.communities||emptyMemberships;
  const nodes=useMemo(()=>sourceNodes.filter(n=>(showSessions||n.type!=='session')&&(!workspace||n.workspace===workspace)&&(!query||[n.title,n.path,n.type].join(' ').toLowerCase().includes(query.toLowerCase()))&&(community===null||memberships[n.id]===community)),[sourceNodes,workspace,query,community,memberships,showSessions]);
  const groups=useMemo(()=>{const map=new Map<number,KnowledgeDocument[]>();for(const n of nodes){const key=memberships[n.id];if(key!==undefined)map.set(key,[...(map.get(key)||[]),n]);}return map;},[nodes,memberships]);
  const overview=community===null&&!query&&nodes.length>80&&groups.size>1;
  const graph=useMemo(()=>{
    const available=new Set(nodes.map(n=>n.id));
    if(!overview)return {nodes:nodes.map(n=>({id:n.id,label:n.title,type:n.type,count:1})),edges:sourceEdges.filter(e=>available.has(e.from)&&available.has(e.to))};
    const groupedEdges=new Map<string,KnowledgeEdge&{count:number}>();
    for(const edge of sourceEdges){if(!available.has(edge.from)||!available.has(edge.to))continue;const a=memberships[edge.from],b=memberships[edge.to],from=a===undefined?edge.from:`group:${a}`,to=b===undefined?edge.to:`group:${b}`;if(from===to)continue;const key=[from,to,edge.kind].join('\0'),old=groupedEdges.get(key);if(old)old.count++;else groupedEdges.set(key,{...edge,from,to,count:1});}
    const groupedNodes=[...groups].map(([key,list])=>({id:`group:${key}`,label:(data.communityLabels?.[String(key)]||`社区 ${key}`)+`\n${list.length} 篇`,type:'community',count:list.length,community:key}));
    // Components without a server-assigned community remain reachable as nodes.
    for(const n of nodes)if(memberships[n.id]===undefined)groupedNodes.push({id:n.id,label:n.title,type:n.type,count:1,community:NaN});
    return {nodes:groupedNodes,edges:[...groupedEdges.values()]};
  },[nodes,sourceEdges,overview,groups,memberships,data.communityLabels]);
  const chosen=nodes.find(n=>n.id===selected),chosenGroup=overview&&selected.startsWith('group:')?Number(selected.slice(6)):null;
  const related=useMemo(()=>chosen?sourceEdges.filter(e=>e.from===chosen.id||e.to===chosen.id).slice(0,12):[],[sourceEdges,chosen]);
  function styles():StylesheetStyle[]{
    const css=getComputedStyle(document.documentElement),color=(name:string)=>css.getPropertyValue(name).trim();
    const ink=color('--text-primary'),muted=color('--muted-readable'),surface=color('--surface-elevated'),line=color('--input-border'),selection=color('--sidebar-selection'),focus=color('--focus-ring');
    return [
      {selector:'node',style:{'label':'data(label)','background-color':surface,'border-color':line,'border-width':1,'color':ink,'font-family':css.getPropertyValue('--font-body').trim(),'font-size':12,'text-valign':'bottom','text-margin-y':10,'text-wrap':'wrap','text-max-width':'150px','width':34,'height':34}},
      {selector:'node[type="community"]',style:{'width':56,'height':56,'background-color':selection,'font-size':13}},
      {selector:'node[type="session"]',style:{'shape':'round-rectangle'}},
      {selector:'edge',style:{'width':1,'line-color':line,'target-arrow-color':line,'target-arrow-shape':'triangle','arrow-scale':.6,'curve-style':'bezier','opacity':.55}},
      {selector:'edge[kind="similar"],edge[kind="tag"]',style:{'line-style':'dashed','target-arrow-shape':'none'}},
      {selector:'node.dim',style:{'background-opacity':.35,'border-opacity':.45,'color':muted}},
      {selector:'edge.dim',style:{'opacity':.15}},
      {selector:'node:selected',style:{'background-color':ink,'border-width':3,'border-color':focus,'color':ink}},
      {selector:'edge:selected',style:{'line-color':muted,'opacity':1}},
    ];
  }
  useEffect(()=>{
    if(!host.current)return;
    setError('');
    let instance:Core;
    try {instance=cytoscape({container:host.current,elements:[...graph.nodes.map(n=>({data:n})),...graph.edges.map((e,i)=>({data:{id:`edge:${i}`,source:e.from,target:e.to,kind:e.kind}}))],style:styles(),layout:{name:graph.nodes.length>400?'grid':'cose',animate:false,randomize:false,padding:52,nodeDimensionsIncludeLabels:true,numIter:500} as cytoscape.LayoutOptions,minZoom:.12,maxZoom:3,wheelSensitivity:.2,selectionType:'single',boxSelectionEnabled:false});}
    catch(e){setError(e instanceof Error?e.message:String(e));return;}
    cy.current=instance;
    if(instance.zoom()>1.2){instance.zoom(1.2);instance.center();}
    setZoom(instance.zoom());
    instance.on('tap','node',event=>selectRef.current(event.target.id()));
    instance.on('tap',event=>{if(event.target===instance)selectRef.current('');});
    instance.on('dbltap','node',event=>{const value=event.target.data('community');if(Number.isFinite(value))groupRef.current(value);});
    instance.on('zoom',()=>setZoom(instance.zoom()));
    let previousWidth=host.current.clientWidth;
    const resize=new ResizeObserver(entries=>{const width=entries[0]?.contentRect.width||0;if(!width)return;instance.resize();if(previousWidth&&Math.abs(width-previousWidth)>Math.max(80,previousWidth*.25)){instance.fit(undefined,52);if(instance.zoom()>1.2){instance.zoom(1.2);instance.center();}}previousWidth=width;});resize.observe(host.current);
    const theme=new MutationObserver(()=>instance.style(styles()));theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    return()=>{resize.disconnect();theme.disconnect();instance.destroy();if(cy.current===instance)cy.current=null;};
  },[graph]);
  useEffect(()=>{const instance=cy.current;if(!instance)return;instance.batch(()=>{instance.elements().removeClass('dim').unselect();const node=instance.getElementById(selected);if(node.length){node.select();instance.elements().difference(node.closedNeighborhood()).addClass('dim');}});},[selected,graph]);
  const choose=(id:string)=>{setSelected(id);const instance=cy.current,node=instance?.getElementById(id);if(instance&&node?.length){const p=node.renderedPosition();if(p.x<0||p.y<0||p.x>instance.width()||p.y>instance.height())instance.center(node);}};
  const enter=(key:number)=>{setCommunity(key);setSelected('');};
  return <div className="knowledge-network">
    <section className="knowledge-network-main" aria-label="知识关系画布">
      <div className="knowledge-network-filters"><div className="knowledge-network-search"><Search size={15}/><Input size="sm" aria-label="搜索图谱节点" value={query} onChange={value=>{setQuery(value);setSelected('');}} placeholder="搜索文档节点…"/></div><select aria-label="图谱来源" value={workspace} onChange={e=>{setWorkspace(e.target.value);setCommunity(null);setSelected('');}}><option value="">全部来源</option>{[...new Set(sourceNodes.map(n=>n.workspace))].sort().map(w=><option key={w}>{w}</option>)}</select><label><input type="checkbox" checked={showSessions} onChange={e=>{setShowSessions(e.target.checked);setSelected('');}}/>包含会话</label></div>
      <div className="knowledge-network-caption">{community!==null?<Button compact variant="secondary" onClick={()=>{setCommunity(null);setSelected('');}}><ArrowLeft size={14}/>返回社区总览</Button>:<span>{overview?'社区总览':'文档关系'}</span>}<span>{nodes.length} 个文档 / {graph.nodes.length} 个可见节点</span></div>
      {error?<p role="alert" className="knowledge-network-error">图谱渲染失败：{error}</p>:!graph.nodes.length?<div className="knowledge-empty"><Search size={26}/><h2>没有匹配的节点</h2><Button compact variant="secondary" onClick={()=>{setWorkspace('');setQuery('');setCommunity(null);}}>清除筛选</Button></div>:null}
      <div ref={host} className="knowledge-network-canvas" role="img" aria-label="交互知识图谱，可拖动节点、平移和缩放。也可以使用下方节点选择器。" hidden={!graph.nodes.length||!!error}/>
      <div className="knowledge-network-controls"><label>选择节点<select aria-label="选择图谱节点" value={graph.nodes.some(n=>n.id===selected)?selected:''} onChange={e=>choose(e.target.value)}><option value="">请选择</option>{graph.nodes.map(n=><option key={n.id} value={n.id}>{n.label.replace(/\n/g,' / ')}</option>)}</select></label><div><Button compact variant="secondary" aria-label="缩小图谱" onClick={()=>{const c=cy.current;if(c)c.zoom({level:Math.max(c.minZoom(),c.zoom()/1.25),renderedPosition:{x:c.width()/2,y:c.height()/2}});}}>−</Button><span aria-live="polite">{Math.round(zoom*100)}%</span><Button compact variant="secondary" aria-label="放大图谱" onClick={()=>{const c=cy.current;if(c)c.zoom({level:Math.min(c.maxZoom(),c.zoom()*1.25),renderedPosition:{x:c.width()/2,y:c.height()/2}});}}>+</Button><Button compact variant="secondary" onClick={()=>cy.current?.fit(undefined,52)}>适应画布</Button></div></div>
      <p className="knowledge-network-legend">实线表示引用等显式关系，虚线表示相似或标签关系。社区来自 Stele 的聚合结果。</p>
    </section>
    <aside className="knowledge-network-detail" aria-label="图谱节点详情">
      {chosenGroup!==null?<><h2>{data.communityLabels?.[String(chosenGroup)]||`社区 ${chosenGroup}`}</h2><p>{groups.get(chosenGroup)?.length||0} 篇文档。进入社区查看具体关系。</p><Button compact variant="cta" onClick={()=>enter(chosenGroup)}>进入社区</Button>{onOverview&&<Button compact variant="secondary" onClick={()=>onOverview(chosenGroup)}>生成社区综述</Button>}<div className="knowledge-network-relations">{groups.get(chosenGroup)?.slice(0,12).map(n=><button type="button" key={n.id} onClick={()=>onOpen(n.id)}><FileText size={15}/>{n.title}</button>)}</div></>:chosen?<><h2>{chosen.title}</h2><p>{chosen.workspace} / {chosen.type}</p><Button compact variant="cta" onClick={()=>onOpen(chosen.id)}>{chosen.type==='session'?'查看会话':'打开文档'}</Button><h3>直接关联</h3><div className="knowledge-network-relations">{related.map((edge,i)=>{const id=edge.from===chosen.id?edge.to:edge.from,n=sourceNodes.find(x=>x.id===id);return n?<button type="button" key={id+i} onClick={()=>onOpen(id)}><FileText size={15}/><span>{n.title}<small>{edge.kind}</small></span></button>:null;})}{!related.length&&<p>没有直接关联。</p>}</div></>:<><h2>沿着关系找到知识</h2><p>选择节点查看来源与关联。文档较多时先呈现社区，进入社区后再阅读具体文档。</p><p>拖动画布可平移，滚轮可缩放。键盘操作可使用节点选择器。</p></>}
    </aside>
  </div>;
});
