import {useStoredDrafts} from './useStoredDrafts';
function legacy():Record<string,string>{try{const v=JSON.parse(localStorage.getItem('omp.drafts.v1')||'{}');return v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).filter(([,text])=>typeof text==='string')) as Record<string,string>:{};}catch{return {};}}
export function useDrafts(root?:string){const result=useStoredDrafts('text',root,legacy,'');return {draft:result.value,setDraft:result.set,setDraftForKey:result.setForKey,error:result.error,values:result.values,loaded:result.loaded,retry:result.retry};}
