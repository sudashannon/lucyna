import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from '../api';
import {Document} from './Document';
type Status={enabled:boolean;status:string;label:string;message:string;idleSeconds:number;cooldownSeconds:number;usedTokens:number;sourceCount:number;factCount:number;currentSource:string;document?:{id:string};skipped:{path:string;reason:string}[];history:{at:number;state:string;message:string}[]};
export function KnowledgeConsolidation({root,active}:{root:string;active:boolean}){
 const [value,setValue]=useState<Status|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[content,setContent]=useState('');
 const version=useRef(0),pending=useRef(false);
 const refresh=useCallback(async()=>{if(pending.current)return;pending.current=true;const current=version.current;try{const next=await api.knowledgeRequest('consolidationStatus',{root});if(current===version.current){setValue(next);setError('');}}catch(e){if(current===version.current)setError(String(e));}finally{pending.current=false;}},[root]);
 useEffect(()=>{version.current++;setValue(null);setContent('');return()=>{version.current++;};},[root]);
 useEffect(()=>{if(!active)return;void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},5000);return()=>window.clearInterval(timer);},[active,refresh]);
 const act=async(kind:string,args:Record<string,unknown>={})=>{const current=version.current;setBusy(true);setError('');try{const result=await api.knowledgeRequest(kind,{root,...args});if(current!==version.current)return;if(kind==='consolidationRead')setContent(result.content);else setValue(result);}catch(e){if(current===version.current)setError(String(e));}finally{if(current===version.current)setBusy(false);}};
 const running=value?.status==='running'||value?.status==='publishing';
 return <section className="wr-consolidation" aria-label="知识沉淀">
  <div className="wr-section-title"><strong>知识沉淀 · L1 / L2 → L3</strong><span>{value?value.enabled?'已开启':'已暂停':'正在连接'}</span></div>
  <p role="status">{value?.label||'正在读取默认后台任务…'}{value?.message&&value.message!==value.label?' · '+value.message:''}</p>
  <p className="wd-caption">自动提炼笔记与会话日志中的可复用结论，保存到「Work 经验 · L3」。保留出处与原件，无需逐次配置。</p>
  {running&&<><progress aria-label="正在沉淀知识"/><p className="wd-caption">{value?.currentSource}</p></>}
  {value&&<p className="wd-caption">空闲 {value.idleSeconds} 秒 · 每 {value.cooldownSeconds/60} 分钟最多处理 3 份变化资料 · 已处理 {value.sourceCount} 份 / 沉淀 {value.factCount} 条 · 已知用量 {value.usedTokens.toLocaleString()} Token</p>}
  {error&&<p role="alert" className="error-text">{error}</p>}
  <div className="wr-actions">
   {value&&<button disabled={busy} onClick={()=>void act('consolidationConfigure',{enabled:!value.enabled})}>{value.enabled?'暂停知识沉淀':'开启知识沉淀'}</button>}
   {value?.enabled&&!running&&<button disabled={busy} onClick={()=>void act('consolidationConfigure',{retry:true})}>重新检查资料</button>}
   {value?.document&&<button disabled={busy} onClick={()=>content?setContent(''):void act('consolidationRead')}>{content?'收起沉淀结果':'查看沉淀结果'}</button>}
   {error&&<button disabled={busy} onClick={()=>void refresh()}>重试连接</button>}
  </div>
  {content&&<details open className="wr-consolidation-result"><summary>已入库知识 · 原文与出处</summary><Document content={content} onError={e=>setError(String(e))}/><p className="wd-caption">可在「知识库 → Work 经验 · L3」检索和编辑。手动编辑后自动任务会保留你的版本并提示冲突。</p></details>}
  {!!value?.skipped.length&&<details><summary>{value.skipped.length} 份资料未处理</summary><ul>{value.skipped.map(s=><li key={s.path}>{s.path}：{s.reason}</li>)}</ul></details>}
  {!!value?.history.length&&<details><summary>最近沉淀记录</summary><ul>{value.history.map((h,i)=><li key={i}>{new Date(h.at).toLocaleString('zh-CN')} · {h.message}</li>)}</ul></details>}
  <p className="wd-caption">由本地 agent 在内置知识服务中执行，不新增 OMP 会话。关闭客户端后继续；服务重启后等待客户端同步模型配置。</p>
 </section>;
}
