import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {BookOpen,ChevronLeft,FileText,RefreshCw,X} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {Spinner} from '@cindy/components/ui/spinner';
import {api} from '../../api';
import {errorText} from '../../errors';
import type {KnowledgeEvidence} from '../../knowledge-types';

export const names:Record<string,string>={knowledge:'知识',design:'设计',spec:'规范',report:'报告',plan:'计划',proposal:'提案',tasks:'任务',change:'变更',artifact:'资料',session:'会话',diagram:'图表'};
export const date=(value?:string)=>value&&!Number.isNaN(Date.parse(value))?new Date(value).toLocaleString('zh-CN'):'时间未知';
export const localDate=(value=new Date())=>`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
export function useRemote<T>(kind:string,args:Record<string,unknown>,active=true,revision=0){
  const key=JSON.stringify(args),[tick,setTick]=useState(0),[state,setState]=useState<{data?:T;key?:string;busy:boolean;error:string}>({busy:false,error:''});
  const refresh=useCallback(()=>setTick(t=>t+1),[]);
  useEffect(()=>{if(!active)return;let current=true;setState(old=>({...old,key,busy:true,error:'',data:old.key===key?old.data:undefined}));const request=kind==='catalog'?api.knowledgeCatalog(tick>0||revision>0):kind==='candidates'?api.knowledgeCandidates():kind==='reviews'?api.knowledgeReviews():api.knowledgeRequest(kind,JSON.parse(key));void request.then(data=>{if(current)setState({data,key,busy:false,error:''});}).catch(error=>{if(current)setState(old=>({...old,key,busy:false,error:errorText(error)}));});return()=>{current=false;};},[kind,key,active,tick,revision]);
  return {...state,busy:state.busy||(active&&state.key!==key),error:state.key===key?state.error:'',data:state.key===key?state.data:undefined,refresh};
}
export function useOperation(){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');const lock=useRef(false);
  const run=async<T,>(action:()=>Promise<T>,success='')=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');try{const value=await action();setMessage(success);return value;}catch(e){setError(errorText(e));return undefined;}finally{lock.current=false;setBusy(false);}};
  return {busy,error,message,run,clear:()=>{setError('');setMessage('');}};
}
export function OperationNotice({operation}:{operation:{error:string;message:string}}){return <>{operation.error&&<p className="knowledge-operation-error" role="alert">{operation.error}</p>}{operation.message&&<p className="knowledge-operation-message" role="status">{operation.message}</p>}</>;}
export function RemoteState({busy,error,empty,onRetry,children,emptyText='这里还没有内容'}:{busy:boolean;error:string;empty?:boolean;onRetry:()=>void;children:ReactNode;emptyText?:string}){
  if(error)return <div className="knowledge-empty" role="alert"><p>{error}</p><Button variant="secondary" compact onClick={onRetry}><RefreshCw size={14}/>重试读取</Button></div>;
  if(busy)return <div className="knowledge-empty" role="status"><Spinner size={22}/><p>正在读取 Stele…</p></div>;
  if(empty)return <div className="knowledge-empty"><BookOpen size={28}/><h2>{emptyText}</h2><Button compact variant="secondary" onClick={onRetry}>刷新内容</Button></div>;
  return <>{children}</>;
}
export function KnowledgeDialog({open,onClose,title,children,wide=false}:{open:boolean;onClose:()=>void;title:string;children:ReactNode;wide?:boolean}){return <Dialog.Root open={open} onOpenChange={v=>{if(!v)onClose();}}><Dialog.Portal><Dialog.Overlay className="knowledge-modal-overlay"/><Dialog.Content aria-describedby={undefined} className={'knowledge-dialog '+(wide?'wide':'')}><header><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><button type="button" className="icon-button" aria-label="关闭对话框"><X size={18}/></button></Dialog.Close></header>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;}
export function Split({list,children,reading,onBack}:{list:ReactNode;children:ReactNode;reading:boolean;onBack:()=>void}){
  const pane=useRef<HTMLElement>(null),last=useRef(false);
  useEffect(()=>{if(!matchMedia('(max-width: 1100px)').matches)return;if(reading){const h=pane.current?.querySelector<HTMLElement>('h2');if(h){h.tabIndex=-1;h.focus({preventScroll:true});}}else if(last.current){pane.current?.parentElement?.querySelector<HTMLElement>('[aria-current="true"]')?.focus({preventScroll:true});}last.current=reading;},[reading]);
  return <div className={'knowledge-native-split '+(reading?'reading':'')}><section className="knowledge-native-list">{list}</section><section className="knowledge-native-detail" ref={pane}><button type="button" className="knowledge-native-back" onClick={onBack}><ChevronLeft size={16}/>返回列表</button>{children}</section></div>;
}
export function Evidence({reference,onOpen}:{reference:KnowledgeEvidence;onOpen:(ref:KnowledgeEvidence)=>void}){return <div className="knowledge-evidence-card"><div className="knowledge-native-meta"><span>{reference.workspace}</span><span>{reference.freshness==='current'?'来源版本有效':reference.freshness==='stale'?'来源已变化':'版本待核对'}</span></div><button type="button" className="knowledge-evidence-title" onClick={()=>onOpen(reference)}><FileText size={16}/>{reference.title||reference.path||reference.id}</button><blockquote>{reference.excerpt}</blockquote><small>{reference.lineStart?`原文第 ${reference.lineStart} 至 ${reference.lineEnd||reference.lineStart} 行`:'来源未提供行号'}{reference.version?' / '+reference.version.slice(0,24):''}</small></div>;}
export async function bytes(file:File){if(file.size>32*1024*1024)throw Error('文件超过 32 MiB');return {name:file.name,type:file.type,bytes:new Uint8Array(await file.arrayBuffer())};}
