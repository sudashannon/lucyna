import {useEffect,useRef,useState} from 'react';
import {Volume2,VolumeX,AudioLines,Check,MessageCircle,TriangleAlert} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {api} from '../api';
import {errorText} from '../errors';
import type {FeedbackSettings as Settings} from '../types';

export function FeedbackSettings({value,onChange,disabled}:{value:Settings;onChange:(patch:Partial<Settings>)=>void;disabled:boolean}){
 const [playing,setPlaying]=useState(''),[error,setError]=useState('');const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;clearTimeout(timer.current);void api.stopFeedbackPreview?.().catch(()=>{});};},[]);
 const play=async(kind:'completed'|'attention'|'error')=>{
  if(!api.previewFeedback){setError('当前客户端尚未提供音效试听，请在任务结束后重新打开 Lucyna。');return;}
  setPlaying(kind);setError('');try{await api.previewFeedback({kind,style:value.style,volume:value.volume});}catch(e){if(alive.current)setError(errorText(e));}finally{if(alive.current)timer.current=setTimeout(()=>setPlaying(''),650);}
 };
 return <>
  <div className="feedback-presets" role="group" aria-label="声音提示模式">
   {([{id:'silent',title:'静音',caption:'保留文字和状态',Icon:VolumeX},{id:'focus',title:'专注',caption:'仅提示后台会话',Icon:Volume2},{id:'companion',title:'陪伴',caption:'前台会话也提示',Icon:AudioLines}] as const).map(({id,title,caption,Icon})=><button key={id} type="button" aria-pressed={value.mode===id} disabled={disabled} onClick={()=>onChange({mode:id})}><Icon size={17}/><strong>{title}</strong><small>{caption}</small></button>)}
  </div>
  <div className="feedback-controls"><label className="settings-field">音效风格<select aria-label="音效风格" value={value.style} disabled={disabled} onChange={e=>onChange({style:e.target.value as Settings['style']})}><option value="soft">柔和合成器</option><option value="pixel">像素电子</option></select></label>
   <label className="settings-field">提示音量 <span className="feedback-volume">{value.volume}%</span><input aria-label="提示音量" type="range" min="0" max="100" step="1" value={value.volume} disabled={disabled} onChange={e=>onChange({volume:Number(e.target.value)})}/></label></div>
  <div className="feedback-preview" role="group" aria-label="试听提示音">{([{kind:'completed',label:'完成',Icon:Check},{kind:'attention',label:'待回复',Icon:MessageCircle},{kind:'error',label:'中断',Icon:TriangleAlert}] as const).map(({kind,label,Icon})=><Button key={kind} variant="secondary" disabled={disabled||!!playing||value.volume===0} onClick={()=>void play(kind)} aria-label={'试听'+label}><Icon size={14}/>{playing===kind?'播放中…':label}</Button>)}</div>
  <p className="settings-caption" role="status">{playing?'正在试听当前风格；保存后应用。':'点击上方按钮试听。静音与勿扰不限制主动试听；设为 0% 后关闭声音。'}</p>
  {error&&<p className="error-text" role="alert">{error}</p>}
  <div className="feedback-events">{([['completed','本轮完成'],['attention','等待你回复'],['error','执行中断']] as const).map(([key,label])=><label className="pet-option" key={key}><input type="checkbox" disabled={disabled} checked={value[key]} onChange={e=>onChange({[key]:e.target.checked})}/>{label}</label>)}</div>
  <label className="pet-option"><input type="checkbox" aria-label="减少界面与桌宠动效" disabled={disabled} checked={value.reducedMotion} onChange={e=>onChange({reducedMotion:e.target.checked})}/>减少界面与桌宠动效</label>
  <p className="settings-caption">同时发生的提示会合并，不连续响铃。主动停止、工具重试不发声；系统减少动态设置始终优先。关闭桌宠仍可使用提示音，桌宠勿扰会同时暂停声音。</p>
 </>;
}
