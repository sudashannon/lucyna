import {resultExcerpt} from '../result-excerpt.cjs';
import type {Message} from './session-view';
export type TimelineEntry={id:string;index:number;kind:'user'|'answer'|'completed'|'question';label:string};
export const timelineLabels={user:'提问',answer:'回答',completed:'本轮完成',question:'等待回复'};
export const messageDomId=(id:string)=>'message-'+encodeURIComponent(id);
export function buildTimeline(messages:Message[],completed=false):TimelineEntry[]{
 const entries:TimelineEntry[]=[];let answer:TimelineEntry|undefined;
 for(let index=0;index<messages.length;index++){
  const message=messages[index];
  if(message.role==='user'){if(answer)entries.push(answer);answer=undefined;entries.push({id:message.id,index,kind:'user',label:resultExcerpt(message.content,100)||'图片或技能消息'});}
  else if(message.role==='assistant'&&!message.streaming){const label=resultExcerpt(message.content,100);if(label)answer={id:message.id,index,kind:'answer',label};}
 }
 if(answer)entries.push({...answer,kind:completed?'completed':'answer'});
 return entries.sort((a,b)=>a.index-b.index);
}
export function railEntries(entries:TimelineEntry[],total:number,slots=24){
 const priority={question:4,completed:2,user:1,answer:0},buckets=new Map<number,TimelineEntry>();
 for(const entry of entries){const bucket=Math.floor(entry.index/Math.max(1,total-1)*Math.max(1,slots)),previous=buckets.get(bucket);if(!previous||priority[entry.kind]>priority[previous.kind])buckets.set(bucket,entry);}
 const selected=new Map([...buckets.values()].map(entry=>[entry.id,entry]));if(entries[0])selected.set(entries[0].id,entries[0]);if(entries.length)selected.set(entries[entries.length-1].id,entries[entries.length-1]);return [...selected.values()].sort((a,b)=>a.index-b.index);
}
