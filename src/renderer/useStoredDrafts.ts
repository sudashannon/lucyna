import {useCallback,useEffect,useRef,useState,type SetStateAction} from 'react';
let database:Promise<IDBDatabase>|undefined;
function db(){return database??=new Promise((resolve,reject)=>{const request=indexedDB.open('omp.composer.v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('drafts');request.onsuccess=()=>resolve(request.result);request.onerror=()=>{database=undefined;reject(request.error);};});}
async function load(kind:string){const database=await db();return new Promise<Record<string,any>>((resolve,reject)=>{const result:Record<string,any>={};const request=database.transaction('drafts').objectStore('drafts').openCursor();request.onsuccess=()=>{const c=request.result;if(!c){resolve(result);return;}const key=String(c.key);if(key.startsWith(kind+':'))result[key.slice(kind.length+1)]=c.value;c.continue();};request.onerror=()=>reject(request.error);});}
async function save(kind:string,key:string,value:unknown){const database=await db();return new Promise<void>((resolve,reject)=>{const tx=database.transaction('drafts','readwrite');tx.objectStore('drafts').put(value,kind+':'+key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
// IndexedDB avoids synchronous quota-bound localStorage writes for large text/images.
export function useStoredDrafts<T>(kind:string,key:string|undefined,initial:()=>Record<string,T>,empty:T){
 const [values,setValues]=useState(initial),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
 const dirty=useRef(new Set<string>()),saved=useRef<Record<string,T>>({});
 useEffect(()=>{let active=true;void load(kind).then(stored=>{if(!active)return;setValues(current=>({...stored,...Object.fromEntries(Object.entries(current).filter(([key])=>dirty.current.has(key)||!(key in stored)))}));setLoaded(true);}).catch(()=>{setLoaded(true);setError('无法读取本机草稿，请保留当前输入。');});return()=>{active=false;};},[kind]);
 const set=useCallback((action:SetStateAction<T>)=>{if(!key)return;dirty.current.add(key);setValues(previous=>({...previous,[key]:typeof action==='function'?(action as (x:T)=>T)(previous[key]??empty):action}));},[key,empty]);
 useEffect(()=>{if(!loaded)return;for(const [key,value]of Object.entries(values)){if(saved.current[key]===value)continue;saved.current[key]=value;void save(kind,key,value).catch(()=>{delete saved.current[key];setError('草稿暂时无法保存到本机，请先复制保留。');});}},[values,loaded,kind]);
 return {value:key?values[key]??empty:empty,set,values,error};
}
