import {memo,useState} from 'react';
import {FileText,X} from 'lucide-react';
import {Modal} from './Modal';
import {textBytes,textLines,type DraftTextAttachment} from '../text-attachments';

export const TextAttachments=memo(function TextAttachments({files,onChange,pending=false}:{files:DraftTextAttachment[];onChange:(files:DraftTextAttachment[])=>void;pending?:boolean}){
  const [preview,setPreview]=useState<string|null>(null),[page,setPage]=useState(0);
  const selected=files.find(f=>f.id===preview),size=16000,pages=selected?Math.ceil(selected.text.length/size):0;
  if(!files.length)return null;
  return <><div className="text-attachments" aria-label="待发送文本附件">{files.map(file=><div className="text-attachment" key={file.id}>
    <button type="button" className="text-attachment-preview" aria-label={`预览文本 ${file.name}`} onClick={()=>{setPreview(file.id);setPage(0);}}><FileText size={19}/><span><strong>{file.name}</strong><small>{textLines(file.text).toLocaleString()} 行 · {(textBytes(file.text)/1024).toFixed(1)} KiB · {file.mode==='file'?'按需读取':'全文发送'}</small></span></button>
    <select disabled={pending} aria-label={`${file.name} 发送方式`} value={file.mode} onChange={e=>onChange(files.map(f=>f.id===file.id?{...f,mode:e.target.value as 'file'|'inline'}:f))}><option value="file">文件附件</option><option value="inline">全文发送</option></select>
    <button type="button" disabled={pending} className="icon-button" aria-label={`移除文本 ${file.name}`} onClick={()=>onChange(files.filter(f=>f.id!==file.id))}><X size={14}/></button>
  </div>)}</div>
  <Modal open={!!selected} onClose={()=>setPreview(null)} title={selected?.name||'文本附件'} description={selected?.mode==='inline'?'全文会直接进入模型上下文。':'发送时保存到当前 OMP 会话；模型通过 read 按需读取。'} className="text-attachment-modal">
    <pre tabIndex={0} aria-label="文本附件原文">{selected?.text.slice(page*size,(page+1)*size)}</pre>
    {pages>1&&<nav aria-label="文本预览分页"><button type="button" disabled={page===0} onClick={()=>setPage(p=>p-1)}>上一段</button><span>{page+1} / {pages}</span><button type="button" disabled={page+1>=pages} onClick={()=>setPage(p=>p+1)}>下一段</button></nav>}
  </Modal></>;
});
