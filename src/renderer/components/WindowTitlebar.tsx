import {useEffect,useRef,useState} from 'react';
import {api} from '../api';
import {BrandLogo} from './BrandVisuals';
import '../window-titlebar.css';
const menus=[['file','文件','F'],['edit','编辑','E'],['view','视图','V'],['window','窗口','W'],['help','帮助','H']];
export function WindowTitlebar({onError}:{onError:(error:unknown)=>void}){
 const [active,setActive]=useState(''),bar=useRef<HTMLElement>(null);
 const open=async(id:string)=>{
  const button=bar.current?.querySelector<HTMLButtonElement>(`[data-menu="${id}"]`);if(!button||!api.windowChrome?.enabled)return;
  const {left,bottom}=button.getBoundingClientRect();setActive(id);
  try{await api.windowChrome.menu(id,{x:left,y:bottom+4});}catch(error){onError(error);}finally{setActive('');}
 };
 const latest=useRef(open);latest.current=open;
 useEffect(()=>api.windowChrome?.onAction(action=>{if(action.startsWith('menu:'))void latest.current(action.slice(5));}),[]);
 return <header className="window-titlebar" aria-label="Lucyna 窗口标题栏"><div className="window-titlebar-content"><span className="window-app-mark" title="Lucyna · 工作台"><BrandLogo size={18}/><span>Lucyna</span></span><nav ref={bar} className="window-menubar" role="menubar" aria-label="应用菜单" onKeyDown={event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length]?.focus();
 }}>{menus.map(([id,label,key])=><button key={id} data-menu={id} role="menuitem" aria-haspopup="menu" aria-expanded={active===id} aria-keyshortcuts={`Alt+${key}`} title={`${label} · Alt+${key}`} onPointerDown={event=>event.preventDefault()} onClick={()=>void open(id)} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();void open(id);}}}>{label}</button>)}</nav><div className="window-drag-space" aria-hidden="true"/></div></header>;
}
