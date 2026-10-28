export interface KnowledgeDocument {id:string;title:string;path:string;workspace:string;type:string;updatedAt?:string;frontmatter?:Record<string,unknown>}
export interface KnowledgeWorkspace {alias:string;path:string;purpose?:{goal?:string}}
export interface KnowledgeCatalog {documents:KnowledgeDocument[];workspaces:KnowledgeWorkspace[];fetchedAt:string}
export interface KnowledgeEdge {from:string;to:string;kind:string;source:string}
export interface KnowledgeDetail {component:KnowledgeDocument;content:string;contentError?:string;forward:KnowledgeEdge[];backlinks:KnowledgeEdge[];relationsError?:string}
export interface KnowledgeEvidence {id:string;workspace:string;title:string;type:string;path?:string;resource?:string;version?:string;excerpt:string;freshness?:string;lineStart?:number;lineEnd?:number}
export interface KnowledgeCandidate {id:string;workspace:string;componentId?:string;title:string;text:string;references:KnowledgeEvidence[];status:string;revision:string;updatedAt?:string;createdAt?:string}
export interface KnowledgeReview {id:string;workspace:string;issue:{rule:string;componentId:string;detail:string;target?:string};dismissed:boolean}
