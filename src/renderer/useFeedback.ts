import {useEffect} from 'react';
import {api} from './api';
export function useFeedback(){
 useEffect(()=>{
  let alive=true,revision=0;
  const apply=(settings:{reducedMotion:boolean})=>{if(alive)document.documentElement.dataset.reducedMotion=String(settings.reducedMotion);};
  const off=api.onFeedback?.(info=>{revision++;apply(info.settings);});
  void api.getFeedback?.().then(info=>{if(!revision)apply(info.settings);}).catch(()=>{});
  return()=>{alive=false;off?.();};
 },[]);
}
