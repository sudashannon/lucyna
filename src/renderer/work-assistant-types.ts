export type WorkAssistantStatus = 'idle'|'collecting'|'summarizing'|'waiting_model'|'error';
export type WorkAssistantRole = 'user'|'assistant';

export type WorkAssistantCitation = {
  sessionId:string;
  messageId:string;
  role:WorkAssistantRole;
  quote:string;
};

export type WorkAssistantItem = {
  text:string;
  sources:WorkAssistantCitation[];
};

export type WorkAssistantSource = WorkAssistantCitation & {
  nativeMessageId?:string;
  title:string;
  at?:number;
  text:string;
};

export type WorkAssistantSummary = {
  overview:{text:string;sources:WorkAssistantCitation[]};
  goals:WorkAssistantItem[];
  decisions:WorkAssistantItem[];
  progress:WorkAssistantItem[];
  openQuestions:WorkAssistantItem[];
  nextSteps:WorkAssistantItem[];
};

export type WorkAssistantSnapshot = {
  workId:string;
  root:string;
  hostId?:string;
  enabled:boolean;
  status:WorkAssistantStatus;
  error?:string;
  historyCoverage?:{
    available:number;
    loaded:number;
    skipped:number;
    limited:boolean;
    warnings:string[];
    checkedAt?:number;
  };
  coverage:{
    sessions:number;
    totalMessages:number;
    visibleMessages:number;
    contextMessages?:number;
    omittedMessages?:number;
    truncated:boolean;
    droppedMessages?:number;
    droppedSessions?:number;
    sourceRevision?:number;
    summaryRevision?:number;
  };
  sessions:Array<{sessionId:string;title:string;messageCount:number;lastActivityAt?:number;visibleMessages?:number}>;
  summary:WorkAssistantSummary|null;
  sources:WorkAssistantSource[];
  sourceRevision?:number;
  summaryRevision?:number;
  updatedAt?:number;
  usedTokens:number;
  usageUnknown?:boolean;
};

export type WorkAssistantOperation = 'status'|'refresh'|'configure'|'history';
