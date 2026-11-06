import {textContent,type Message} from './session-view';

const sourceText=(value:string)=>value.replace(/\r\n?/g,'\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,' ').trim();

// Live events and restored journals can have different display IDs. A fallback
// is allowed only for one exact source-text match within the resolved journal.
export function findSourceMessage(messages:Message[],source:{messageId:string;nativeMessageId?:string;role:string;text:string}){
  const text=sourceText(source.text);
  if(!text)throw Error('这条引用缺少可定位的原文，请更新摘要后重试。');
  const matches=messages.map((message,index)=>({message,index})).filter(({message})=>
    message.role===source.role&&sourceText(textContent(message.content)).includes(text));
  const identified=matches.filter(({message})=>[source.nativeMessageId,source.messageId].some(id=>!!id&&(id===message.id||id===message.nativeId)));
  if(identified.length===1)return identified[0].index;
  if(matches.length===1)return matches[0].index;
  throw Error(matches.length?'原会话中有多条相同原文，暂时无法唯一定位，请在时间轴中查找。':'原消息已不在当前会话分支中，或历史尚未载入，请更新摘要后重试。');
}
