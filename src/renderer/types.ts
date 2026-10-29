import type {KnowledgeCatalog, KnowledgeDetail, KnowledgeCandidate, KnowledgeReview} from './knowledge-types';
import type {WorkDetail, GitInspection} from './work-detail-data';
export interface WorkIssue {code: string; severity: 'error' | 'warning' | 'info'; message: string; member?: string; actual?: string; expected?: string}
export interface Work { name: string; root: string; kind: string; state?: string; error?: string; health?: 'ok' | 'warning' | 'error'; issues?: WorkIssue[] }
export interface HistoryEntry { title?: string; id?: string; path?: string; cwd?: string; sessionFile?: string; agentDir?: string; modified?: string; modifiedAt?: string; importedAt?: string; sourceKind?: string; runtime?: 'windows' | 'wsl' }
export interface ClientSettings {version:1; runtime:'windows'|'wsl'; windowsExecutable:string; wslExecutable:string; wslAgentDir:string; model:string; thinking:string}
export interface FeedbackSettings {version:1;mode:'silent'|'focus'|'companion';style:'soft'|'pixel';volume:number;completed:boolean;attention:boolean;error:boolean;reducedMotion:boolean}
export interface FeedbackInfo {settings:FeedbackSettings;warning:string}
export interface SettingsInfo {settings:ClientSettings; storage:string; workspace:{distro:string;user:string;root:string}}
export interface EnvironmentCheck {runtime:string; version:string; configFiles:string[]; elapsedMs:number; note:string}
export interface HistoryDeletionPlan {token:string;files:{path:string;kind:'journal'|'artifacts'|'backup'|'memo'}[];warnings:string[]}
export interface History { sessions: HistoryEntry[]; managed: HistoryEntry[]; warnings?: string[]; trash?: {key:string;source:string;entry:HistoryEntry;deletedAt:string;version?:number;files?:HistoryDeletionPlan['files'];state?:string}[] }
export interface FilePreview { kind: 'markdown' | 'image' | 'text'; name: string; path?: string; content?: string; dataUrl?: string; anchor?: string }
export interface FileEntry { name: string; path: string; kind: 'directory' | 'markdown' | 'image' | 'text' | 'file' | 'blocked'; link?: boolean; reason?: string }
export interface FileListing { directory: string; entries: FileEntry[]; total: number; nextOffset: number | null }
export interface WorkEvent { id: string; time: string; text: string; level: 'info' | 'success' | 'warning' | 'error'; detail?: string; root?: string }
// OMP extension events and message blocks are owned by the native protocol.
export type OmpEvent = Record<string, any>;
export interface Desktop {
  workRun(operation:string,data?:Record<string,unknown>):Promise<any>;
  workDetails(root:string):Promise<WorkDetail>;
  workGit(root:string,member:string,action:string,options?:{scope?:string;file?:string}):Promise<GitInspection>;
  openExternal(url:string):Promise<void>;
  mode?:'native'|'demo';
  windowChrome?:{enabled:boolean;menu:(id:string,position:{x:number;y:number})=>Promise<unknown>;theme:(theme:string)=>Promise<unknown>;onAction:(fn:(action:string)=>void)=>()=>void};
  getPet?():Promise<{settings:PetSettings;warning:string;sessions:{id:string;title:string}[]}>;
  savePet?(patch:Partial<PetSettings>):Promise<PetSettings>;
  resetPetPosition?():Promise<PetSettings>;
  petContext?(context:{theme:string;id:string;title:string;visible?:boolean}):Promise<void>;
  getFeedback?():Promise<FeedbackInfo>;
  saveFeedback?(patch:Partial<FeedbackSettings>):Promise<FeedbackSettings>;
  previewFeedback?(input:{kind:'completed'|'attention'|'error';style:FeedbackSettings['style'];volume:number}):Promise<void>;
  stopFeedbackPreview?():Promise<void>;
  onFeedback?(fn:(info:FeedbackInfo)=>void):()=>void;
  onPetNavigate?(fn:(target:{id:string})=>void):()=>void;
  knowledgeCatalog(refresh?:boolean):Promise<KnowledgeCatalog>;
  knowledgeDocument(id:string):Promise<KnowledgeDetail>;
  knowledgeCandidates():Promise<KnowledgeCandidate[]>;
  knowledgeReviews():Promise<KnowledgeReview[]>;
  knowledgeImage(id:string,src:string):Promise<string>;
  knowledgeRequest(kind:string,args?:Record<string,unknown>):Promise<any>;
  knowledgeSaveFile(name:string,bytes:Uint8Array):Promise<boolean>;
  onKnowledge(fn:(data:{requestId:string;event:{type:string;content?:string;references?:import('./knowledge-types').KnowledgeEvidence[]}})=>void):()=>void;
  getSettings(): Promise<SettingsInfo>; checkSettings(settings:ClientSettings): Promise<EnvironmentCheck>; saveSettings(settings:ClientSettings): Promise<ClientSettings>;
  copyText(text: string): Promise<void>;
  listWorks(): Promise<Work[]>; readWork(root: string): Promise<string>;
  context(query: string): Promise<OmpEvent>; start(options: OmpEvent): Promise<unknown>;
  request(type: string, data?: OmpEvent, id?: string): Promise<OmpEvent>; respond(data: OmpEvent,id?:string): Promise<unknown>; close(id?:string): Promise<unknown>;
  listConnections?(): Promise<OmpEvent[]>;
  chooseSession(): Promise<string | null>; listHistory(root: string): Promise<History>;
  previewHistoryDeletion(source:string,root:string):Promise<HistoryDeletionPlan>;
  deleteHistory(source:string,root:string,token:string):Promise<string>;
  restoreHistory(root:string,key:string):Promise<void>;
  importSession(source: string, root: string): Promise<OmpEvent>;
  terminal(root: string): Promise<unknown>; startTerminal(root: string, dimensions: {cols: number; rows: number; requestId?: string}): Promise<{id: string}>;
  terminalInput(id: string, data: string): Promise<unknown>; terminalResize(id: string, cols: number, rows: number): Promise<unknown>; closeTerminal(id: string): Promise<unknown>;
  onTerminal(fn: (event: OmpEvent) => void): () => void; onEvent(fn: (event: OmpEvent) => void): () => void;
  choosePreview(root: string): Promise<FilePreview | null>; readPreview(root: string, reference: string, basePath?: string): Promise<FilePreview>; webPreview(url: string): Promise<unknown>;
  listFiles(root: string, directory?: string, options?: {query?: string; showHidden?: boolean; offset?: number}): Promise<FileListing>;
}
declare global { interface Window { desktop?: Desktop } }
export interface PetSettings {version:1;enabled:boolean;animated:boolean;alwaysOnTop:boolean;appearance:'duo'|'cat';size:'small'|'medium'|'large';quiet:boolean;privacy:boolean;reducedMotion:boolean;closeToTray:boolean;notifyCompletion:boolean;notifyError:boolean;pinnedSessionId:string;position:{displayId:number;right:number;bottom:number}|null}
