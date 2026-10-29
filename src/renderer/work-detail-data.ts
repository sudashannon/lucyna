import {documentHeadings, plainText, workOutline} from './panel-data';
import type {HistoryEntry, WorkIssue} from './types';
export interface GitCounts {staged:number;unstaged:number;untracked:number;conflicts:number}
export interface GitTree {path:string;head?:string;branch?:string;detached?:boolean;bare?:boolean;locked?:string|boolean;prunable?:string|boolean}
export interface WorkMember {name:string;path:string;repo:string;branch:string;registeredBranch:string;head?:string;detached?:boolean;base?:string;baseSha?:string;mr?:string;counts?:GitCounts;upstream?:string;ahead?:number;behind?:number;baseAhead?:number;baseBehind?:number;worktrees?:GitTree[];detailError?:string;statusTruncated?:boolean;treesTruncated?:boolean}
export interface WorkAsset {path:string;name:string;title?:string;kind:'note'|'log'|'script'|'evidence';indexed:boolean;directory?:boolean;size?:number;modifiedAt?:string;unavailable?:string}
export interface WorkDetail {root:string;name:string;content:string;modifiedAt:string;fetchedAt:string;members:WorkMember[];assets:WorkAsset[];issues:WorkIssue[];warnings:string[];kind:string}
export interface GitFile {path:string;oldPath?:string;code:string;staged:boolean;unstaged:boolean;untracked:boolean;conflict:boolean}
export interface GitInspection {kind:string;text?:string;truncated?:boolean;checkedAt?:string;files?:GitFile[];counts?:GitCounts;worktrees?:GitTree[];state?:string;draft?:boolean;sourceBranch?:string;targetBranch?:string;sha?:string;url?:string;updatedAt?:string;pipelineStatus?:string;pipelineSha?:string;pipelineMatchesHead?:boolean}
export function workRecord(text:string){
  const outline=workOutline(text), headings=documentHeadings(text);
  const sections=outline.sections.map((s,i)=>({...s,anchor:headings.filter(h=>h.level===2)[i]?.id}));
  const fields=sections.flatMap(s=>{let fence=false;return s.content.split('\n').flatMap(line=>{
    if(/^\s*(```|~~~)/.test(line)){fence=!fence;return [];}
    if(fence)return [];
    const match=/^\s*[-*]\s+(?:\*\*)?([^:：\n*]{1,30})(?:\*\*)?[:：]\s*(.+)$/.exec(line);
    return match?[{label:match[1],text:plainText(match[2]),anchor:s.anchor,section:s.title}]:[];
  });});
  const first=(pattern:RegExp)=>fields.find(f=>pattern.test(f.label));
  const latest=sections.filter(s=>/^\d{4}-\d{2}-\d{2}/.test(s.title)).sort((a,b)=>b.title.slice(0,10).localeCompare(a.title.slice(0,10)));
  return {...outline,sections,fields,latest,goal:first(/^目标$/),current:first(/^当前$/),state:first(/^状态$/)?.text||'',recorded:first(/^最近更新$/)?.text||'',
    pending:fields.filter(f=>/未决|阻塞|风险|下一步/.test(f.label)),checks:fields.filter(f=>/验收|非目标|授权|整体验证|环境安全/.test(f.label))};
}
export function groupRepositories(members:WorkMember[]){
  const groups=new Map<string,WorkMember[]>();
  for(const member of members){const group=groups.get(member.repo)||[];group.push(member);groups.set(member.repo,group);}
  return [...groups].map(([repo,members])=>({repo,members}));
}
export function relatedHistory(asset:WorkAsset,entries:HistoryEntry[]){
  const prefix=/^SESSION-([0-9a-f-]{8,36})\.md$/i.exec(asset.name)?.[1].toLowerCase();
  if(!prefix)return null;
  // A short id may collide, and an imported copy may share the original id.
  // Never guess which journal should receive new messages.
  const matches=entries.filter(e=>e.id?.toLowerCase().startsWith(prefix));
  return matches.length===1?matches[0]:null;
}
