import type {Run} from './session-view';

export type MonitorSession={id:string;root:string;workName:string;title:string;connection:string;busy:boolean;questions:number;error:boolean;errorText:string;unread:boolean;model:string;runtime:string;run:Run|null;queued:number;summary:string;connectionPhase:string};
export type MonitorFilter='connected'|'running'|'completedUnread'|'attention'|'all';
export const monitorFilters=[['connected','全部连接'],['running','运行中'],['completedUnread','已完成未读'],['attention','待处理'],['all','全部打开']] as const;
export const isCompletedUnread=(s:MonitorSession)=>s.connection==='ready'&&s.unread&&!s.busy&&!s.questions&&!s.error&&s.run?.outcome==='completed';
export function matchesMonitorFilter(s:MonitorSession,filter:MonitorFilter){
  if(filter==='completedUnread')return isCompletedUnread(s);
  if(filter==='connected')return s.connection!=='idle';
  if(filter==='running')return s.busy;
  if(filter==='attention')return !!(s.questions||s.error);
  return true;
}
