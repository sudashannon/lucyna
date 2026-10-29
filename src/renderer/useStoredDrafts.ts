import {useCallback,useEffect,useRef,useState,type SetStateAction} from 'react';

let database:Promise<IDBDatabase>|undefined;
function db():Promise<IDBDatabase>{
  if(database)return database;
  const opening=new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('omp.composer.v1',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
    request.onsuccess=()=>{
      const connection=request.result;
      const invalidate=()=>{connection.close();if(database===opening)database=undefined;};
      connection.onversionchange=invalidate;
      connection.onclose=invalidate;
      resolve(connection);
    };
    request.onerror=()=>reject(request.error);
  });
  database=opening;
  void opening.catch(()=>{if(database===opening)database=undefined;});
  return opening;
}
async function load<T>(kind:string){
  const connection=await db();
  return new Promise<Record<string,T>>((resolve,reject)=>{
    const result:Record<string,T>={};
    const tx=connection.transaction('drafts','readonly');
    const request=tx.objectStore('drafts').openCursor();
    request.onsuccess=()=>{
      const cursor=request.result;if(!cursor)return;
      const key=String(cursor.key);
      if(key.startsWith(kind+':'))result[key.slice(kind.length+1)]=cursor.value;
      cursor.continue();
    };
    // A cursor finishing does not prove that the transaction committed.
    tx.oncomplete=()=>resolve(result);
    tx.onerror=tx.onabort=()=>reject(tx.error||request.error||new Error('Draft read aborted'));
  });
}
async function save(kind:string,key:string,value:unknown){
  const connection=await db();
  return new Promise<void>((resolve,reject)=>{
    const tx=connection.transaction('drafts','readwrite');
    tx.objectStore('drafts').put(value,kind+':'+key);
    tx.oncomplete=()=>resolve();
    tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Draft write aborted'));
  });
}
const readError='暂时无法读取本机草稿，当前输入已保留；正在重试。';
const writeError='草稿暂时无法保存到本机，正在重试；关闭前请复制保留。';

// Never write until the existing drafts have been read successfully. Typed
// values win over recovered records; untouched drafts keep their disk value.
export function useStoredDrafts<T>(kind:string,key:string|undefined,initial:()=>Record<string,T>,empty:T){
  const [values,setValues]=useState(initial),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
  const [revision,retry]=useState(0);
  const dirty=useRef(new Set<string>()),saved=useRef<Record<string,T>>({});
  const current=useRef(values),writing=useRef(false),mounted=useRef(false);
  current.current=values;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    if(loaded)return;
    let active=true;
    void load<T>(kind).then(stored=>{
      if(!active)return;
      saved.current=stored;
      setValues(existing=>({...stored,...Object.fromEntries(Object.entries(existing).filter(([key])=>dirty.current.has(key)||!(key in stored)))}));
      setError('');setLoaded(true);
    }).catch(reason=>{
      if(!active)return;
      console.warn('Draft storage read failed:',reason?.name,reason?.message);
      setError(readError);
    });
    return()=>{active=false;};
  },[kind,loaded,revision]);
  const retryNow=useCallback(()=>retry(value=>value+1),[]);
  useEffect(()=>{
    if(!error)return;
    const timer=window.setTimeout(retryNow,5000);
    window.addEventListener('focus',retryNow);
    return()=>{clearTimeout(timer);window.removeEventListener('focus',retryNow);};
  },[error,revision,retryNow]);
  const setForKey=useCallback((target:string,action:SetStateAction<T>)=>{
    if(!target)return;
    dirty.current.add(target);
    setValues(previous=>({...previous,[target]:typeof action==='function'?(action as (x:T)=>T)(previous[target]??empty):action}));
  },[empty]);
  const set=useCallback((action:SetStateAction<T>)=>{if(key)setForKey(key,action);},[key,setForKey]);
  useEffect(()=>{
    if(!loaded||writing.current)return;
    const entries=Object.entries(values).filter(([key,value])=>saved.current[key]!==value);
    if(!entries.length)return;
    writing.current=true;
    void (async()=>{
      try{
        for(const [key,value]of entries){await save(kind,key,value);saved.current[key]=value;}
        if(mounted.current)setError('');
      }catch(reason){
        console.warn('Draft storage write failed:',(reason as Error)?.name,(reason as Error)?.message);
        if(mounted.current)setError(writeError);
        return;
      }finally{writing.current=false;}
      // Edits made during an older transaction need another write. Failures
      // wait for the retry timer, rather than spinning in an immediate loop.
      if(mounted.current&&Object.entries(current.current).some(([key,value])=>saved.current[key]!==value))retryNow();
    })();
  },[values,loaded,kind,revision,retryNow]);
  return {value:key?values[key]??empty:empty,set,setForKey,values,error,loaded,retry:retryNow};
}
