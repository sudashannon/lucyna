export type WorkAssistantStatus = 'idle'|'collecting'|'summarizing'|'waiting_model'|'error';
export type WorkAssistantRole = 'user'|'assistant';
export type WorkAnalysisStats={
  mode:'incremental'|'full';
  /** Distinct messages sent in the current or most recent batch, including evidence retrieval rounds. */
  contextMessages:number;
  changedMessages:number;
  supplementalMessages:number;
  pendingMessages:number;
  fullProcessedMessages?:number;
  fullTotalMessages?:number;
  lastFullAt?:number;
  rounds?:number;
};

export type WorkAssistantCitation = {
  sessionId:string;
  messageId:string;
  role:WorkAssistantRole;
  quote:string;
};

export type WorkAssistantSourceTarget = WorkAssistantCitation & {
  nativeMessageId?:string;
  at?:number;
};

export type WorkAssistantItem = {
  id?:string;
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
  lastAttemptAt?:number;
  analysis?:WorkAnalysisStats;
  usedTokens:number;
  usageUnknown?:boolean;
};

export type WorkAssistantOperation = 'status'|'refresh'|'configure'|'history';
