import {useEffect,useState} from 'react';
import {Button} from '@cindy/components/ui/button';
import {Spinner} from '@cindy/components/ui/spinner';
import {Modal} from './Modal';
import {api} from '../api';
import {errorText} from '../errors';
import type {HistoryEntry,HistoryDeletionPlan} from '../types';

const labels={journal:'OMP 会话记录',memo:'Work 会话备忘',artifacts:'会话专属附件',backup:'会话恢复备份'};
export function HistoryDeletionDialog({target,onClose,onDeleted}:{target:{entry:HistoryEntry;root:string}|null;onClose:()=>void;onDeleted:(root:string)=>Promise<void>}){
  const [plan,setPlan]=useState<HistoryDeletionPlan|null>(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let stale=false;setPlan(null);setError('');setLoading(!!target);if(target)void api.previewHistoryDeletion(target.entry.sessionFile||target.entry.path!,target.root).then(value=>{if(!stale)setPlan(value);}).catch(e=>{if(!stale)setError(errorText(e));}).finally(()=>{if(!stale)setLoading(false);});return()=>{stale=true;};},[target]);
  const remove=async()=>{
    if(!target||!plan||busy)return;setBusy(true);setError('');
    try{await api.deleteHistory(target.entry.sessionFile||target.entry.path!,target.root,plan.token);await onDeleted(target.root);onClose();}
    catch(e){setError(errorText(e));setPlan(null);}finally{setBusy(false);}
  };
  return <Modal open={!!target} onClose={()=>{if(!busy)onClose();}} title="删除会话及关联备忘？" description="下列文件将一起移到回收站，可一并恢复。工作区摘要、共享笔记、知识库和未发送草稿保留。" className="history-delete-dialog">
    <p className="history-delete-title">{target?.entry.title||target?.entry.id||'未命名会话'}</p>
    {loading&&<p className="history-delete-loading" role="status"><Spinner size={16}/>正在检查会话与备忘…</p>}
    {plan&&<><ul className="history-delete-files">{plan.files.map(file=><li key={file.path}><strong>{labels[file.kind]}</strong><span>{file.path.split(/[\\/]/).pop()}</span><small>{file.path}</small></li>)}</ul>{plan.warnings.map(text=><p className="history-delete-note" key={text}>{text}</p>)}</>}
    {error&&<p role="alert" className="error-text">{error}</p>}
    <div className="panel-buttons"><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button loading={busy} disabled={busy||loading||!plan} onClick={()=>void remove()}>移到回收站</Button></div>
  </Modal>;
}
