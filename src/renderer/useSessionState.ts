import {useCallback,useState,type SetStateAction} from 'react';
// Setters capture their key, so late results update their originating view.
export function useSessionState<T>(key:string,initial:T) {
  const [values,setValues]=useState<Record<string,T>>({});
  const set=useCallback((action:SetStateAction<T>)=>setValues(previous=>({...previous,[key]:typeof action==='function'?(action as (old:T)=>T)(previous[key]??initial):action})),[key,initial]);
  return [values[key]??initial,set,values] as const;
}
