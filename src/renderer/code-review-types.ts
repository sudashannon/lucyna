export type CodeReviewSource =
  | {kind: 'turn'; sessionId: string; messageId: string}
  | {kind: 'workspace'; root: string; member: string; scope: 'all' | 'staged' | 'unstaged'};

export type CodeReviewFile = {
  id: string;
  member: string;
  path: string;
  scope: 'turn' | 'staged' | 'unstaged';
  patch: string;
  omitted?: boolean;
};

export type CodeReviewFinding = {
  id: string;
  fileId: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  body: string;
  evidence: string;
  suggestion?: string;
  lineStart?: number;
  lineEnd?: number;
  status: 'open' | 'ignored';
};

export type CodeReviewStatus =
  | 'queued' | 'capturing' | 'running' | 'stopping'
  | 'cancelled' | 'completed' | 'failed' | 'interrupted';

export type CodeReviewRun = {
  id: string;
  source: CodeReviewSource;
  status: CodeReviewStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  stage?: string;
  engine?: {id: string; model: string; version: string};
  usage?: {inputTokens: number; outputTokens: number};
  warnings?: string[];
  reusedFrom?: string;
  snapshot?: {
    id: string;
    root: string;
    capturedAt: number;
    files: CodeReviewFile[];
    warnings: string[];
    partial: boolean;
    context?: string;
  };
  findings: CodeReviewFinding[];
};
