import {useEffect,useState} from 'react';
import {Spinner} from '@cindy/components/ui/spinner';
export function ConnectionProgress({phase,started}:{phase:string;started:number}){
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const seconds=Math.max(0,Math.floor((now-started)/1000));
  return <div className="connection-progress" role="status"><Spinner size={18}/><div><strong>{phase||'正在连接 OMP'}</strong><p>{seconds>=20?'启动时间较长，可以先切换到其他工作区；连接将在后台继续。':'正在使用现有配置恢复会话，可以继续切换工作区。'}</p></div><time>{seconds} 秒</time></div>;
}
