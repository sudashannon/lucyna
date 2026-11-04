export type WorkWorkflowOperation='status'|'refresh'|'action';
export type WorkWorkflowAction='view'|'done'|'snooze'|'dismiss'|'draft';
export type WorkWorkflowReminderState='new'|'viewed'|'done'|'snoozed'|'dismissed';
export type WorkWorkflowReminderKind='handover'|'record_update'|'repeated_blocker'|'result_reuse';
export type WorkWorkflowSource=
  |{type:'conversation';sessionId:string;messageId:string;role:'user'|'assistant';quote:string}
  |{type:'record';path:'SESSION.md';quote:string};
export type WorkWorkflowCoverage={
  sessions?:number;
  totalMessages?:number;
  visibleMessages?:number;
  contextMessages?:number;
  omittedMessages?:number;
  droppedMessages?:number;
  droppedSessions?:number;
  truncated?:boolean;
  historyCoverage?:{available:number;loaded:number;skipped:number;limited:boolean;warnings:string[]};
};
export type WorkWorkflowReminder={
  id:string;
  key:string;
  kind:WorkWorkflowReminderKind;
  title:string;
  reason:string;
  draftText:string;
  sources:WorkWorkflowSource[];
  state:WorkWorkflowReminderState;
  sourceRevision:number;
  recordHash?:string;
  evidenceFingerprint:string;
  updatedAt:number;
  snoozedUntil?:number;
  active:boolean;
  stale:boolean;
};
export type WorkWorkflowSnapshot={
  workId:string;
  root:string;
  hostId?:string;
  status:'idle'|'analyzing'|'error';
  error?:string;
  sourceRevision:number;
  recordHash?:string;
  recordAvailable:boolean;
  recordWarning?:string;
  recordTruncated?:boolean;
  coverage?:WorkWorkflowCoverage;
  /** Alias for stateRevision, kept by the backend contract for action requests. */
  revision:number;
  stateRevision:number;
  contextFingerprint:string;
  updatedAt?:number;
  reminders:WorkWorkflowReminder[];
};
export type WorkWorkflowRequest={
  root:string;
  hostId?:string;
  id?:string;
  revision?:number;
  action?:WorkWorkflowAction;
};
export type WorkWorkflowResponse={snapshot:WorkWorkflowSnapshot;draftText?:string};
