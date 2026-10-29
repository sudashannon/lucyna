import {MAX_TEXT_BYTES} from './composer-input';

export type DraftTextAttachment={id:string;name:string;text:string;mode:'file'|'inline'};
export type PreparedTextAttachment={id:string;url:string;name:string;bytes:number;lines:number};
export const MAX_TEXT_ATTACHMENTS=8;
export const textBytes=(text:string)=>new TextEncoder().encode(text).length;
export const textLines=(text:string)=>text.split(/\r\n|\r|\n/).length;
export const shouldAttachText=(text:string)=>text.length>8000||textLines(text)>=100;
export function validateTextAttachments(body:string,files:DraftTextAttachment[]){
  if(files.length>MAX_TEXT_ATTACHMENTS)throw Error('单条消息最多附加 8 份文本，请分批发送；原文仍在剪贴板中。');
  if(textBytes(body)+files.reduce((sum,f)=>sum+textBytes(f.text),0)>MAX_TEXT_BYTES)throw Error('正文与文本附件合计最多 4 MiB，请拆分；已有草稿和剪贴板原文均保留。');
}
export function composeTextPrompt(body:string,files:DraftTextAttachment[],prepared:PreparedTextAttachment[]=[]){
  const parts=body?[body]:[];
  for(const file of files){
    if(file.mode==='inline'){parts.push(file.text);continue;}
    const saved=prepared.find(p=>p.id===file.id);
    if(!saved||!/^local:\/\/paste-lucyna-[a-f0-9]{32}\.md$/.test(saved.url))throw Error('文本附件尚未保存，原文已保留，请重试。');
    parts.push(`文本附件：${file.name}（${textLines(file.text)} 行，${textBytes(file.text)} 字节）\n${saved.url}\n请使用 read 工具按需读取此附件。`);
  }
  return parts.join('\n\n');
}
