import type {Message} from './session-view';
export const historyBatch=80;
export function historyStart(messages:Message[],anchor:string){const index=anchor?messages.findIndex(message=>message.id===anchor):-1;return index>=0?index:Math.max(0,messages.length-historyBatch);}
export function historyEnd(messages:Message[],anchor:string){const index=anchor?messages.findIndex(message=>message.id===anchor):-1;return index>=0?index+1:messages.length;}
export function jumpWindow(messages:Message[],index:number){const start=Math.max(0,Math.min(index-4,messages.length-historyBatch)),end=Math.min(messages.length,start+historyBatch);return{start:messages[start]?.id||'',end:end<messages.length?messages[end-1]?.id||'':''};}
