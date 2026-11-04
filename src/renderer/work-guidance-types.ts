export type WorkGuidanceRole = 'user'|'assistant';
export type WorkGuidanceOperation = 'suggest'|'cancel'|'material'|'feedback';

export type WorkGuidanceIdentity = {root:string;hostId?:string;sessionKey:string};
export type WorkGuidanceCitation = {sessionId:string;messageId:string;role:WorkGuidanceRole;quote:string};
export type WorkGuidanceCompletion = {
  id:string;
  text:string;
  reason:string;
  basis:'extracted'|'inferred';
  sources:WorkGuidanceCitation[];
};
export type WorkGuidanceAsset = {
  id:string;
  title:string;
  path:string;
  reason:string;
  kind:string;
  version?:string;
};
export type WorkGuidanceCoverage = {
  sourceRevision:number;
  sessions:number;
  totalMessages:number;
  visibleMessages:number;
  omittedMessages:number;
  assetsAvailable?:boolean;
  assetsNotice?:string;
  historyCoverage?:{available:number;loaded:number;skipped:number;limited:boolean;warnings:string[];checkedAt?:number};
};
export type WorkGuidanceSuggestArgs = WorkGuidanceIdentity & {revision:number;draft:string;caret:number};
export type WorkGuidanceCancelArgs = WorkGuidanceIdentity & {revision?:number;requestId?:string};
export type WorkGuidanceMaterialArgs = WorkGuidanceIdentity & {requestId:string;assetId:string};
export type WorkGuidanceFeedbackKind = 'accepted'|'edited'|'ignored'|'asset_used'|'asset_ignored';
export type WorkGuidanceFeedbackArgs = WorkGuidanceIdentity & {requestId:string;completionId?:string;assetId?:string;feedback:WorkGuidanceFeedbackKind};
export type WorkGuidanceResponse = WorkGuidanceIdentity & {
  revision:number;
  draftHash:string;
  caret:number;
  sourceRevision:number;
  requestId:string;
  status:'complete'|'cancelled'|'stale'|'paused'|'waiting_model'|'error';
  completions:WorkGuidanceCompletion[];
  assets:WorkGuidanceAsset[];
  coverage?:WorkGuidanceCoverage;
  error?:string;
};
export type WorkGuidanceCancelResult=WorkGuidanceIdentity&{
  revision:number;
  requestId:string;
  status:'cancelled';
  completions:[];
  assets:[];
};
export type WorkGuidanceFeedbackResult={ok:true;requestId:string;feedback:WorkGuidanceFeedbackKind;duplicate?:boolean};
export type WorkGuidanceMaterial = WorkGuidanceIdentity & {
  requestId:string;
  assetId:string;
  title:string;
  path:string;
  kind:string;
  origin:string;
  version?:string;
  snapshotVersion?:string;
  sourceHash?:string|null;
  snapshot:boolean;
  content:string|null;
  truncated:boolean;
};
export type WorkGuidanceResult = WorkGuidanceResponse | WorkGuidanceMaterial | WorkGuidanceCancelResult | WorkGuidanceFeedbackResult | undefined;
