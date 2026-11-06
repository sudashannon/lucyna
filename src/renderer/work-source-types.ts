import type {HistoryEntry} from './types';

export type WorkSourceLocation={
  root:string;
  hostId?:string;
  sessionId:string;
  messageId:string;
  nativeMessageId?:string;
  role:'user'|'assistant';
  text:string;
  at?:number;
  clientSessionId?:string;
  entry?:HistoryEntry;
};
