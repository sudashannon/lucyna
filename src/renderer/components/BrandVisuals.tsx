import {useState} from 'react';
import {Cat,Layers2,UserRound} from 'lucide-react';

const girl = new URL('../assets/brand/cindy-omp-girl-v1.png', import.meta.url).href;
const cat = new URL('../assets/brand/cindy-omp-cat-v1.png', import.meta.url).href;
const companions = new URL('../assets/brand/cindy-omp-companions-v1.png', import.meta.url).href;
const applicationLogo = new URL('../../assets/app-icon.png', import.meta.url).href;

export function BrandLogo({size = 32}: {size?: number}) {
  const [failed,setFailed]=useState(false);
  return failed?<Layers2 className="cindy-logo" size={size} aria-hidden="true"/>:<img className="cindy-logo" src={applicationLogo} width={size} height={size} alt="" aria-hidden="true" draggable={false} decoding="async" onError={()=>setFailed(true)}/>;
}

// Static, shared image URLs: streaming messages never create timers or canvases.
// Text labels and native activity indicators retain their accessible semantics.
export function BrandAvatar({kind = 'girl', size = 24}: {kind?: 'girl' | 'cat'; size?: number}) {
  const [failed,setFailed]=useState(''),Fallback=kind==='cat'?Cat:UserRound;
  return failed===kind?<Fallback className={`cindy-avatar cindy-avatar-${kind} cindy-avatar-fallback`} size={size} aria-hidden="true"/>:<img className={`cindy-avatar cindy-avatar-${kind}`} src={kind === 'girl' ? girl : cat} width={size} height={size} alt="" aria-hidden="true" draggable={false} decoding="async" onError={()=>setFailed(kind)}/>;
}

export function BrandCompanions() {
  const [failed,setFailed]=useState(false);
  return failed?<Cat className="cindy-companions" size={144} aria-hidden="true"/>:<img className="cindy-companions" src={companions} width={144} height={144} alt="" aria-hidden="true" draggable={false} decoding="async" onError={()=>setFailed(true)}/>;
}

// Original 5×7 lettering; the rest of the interface keeps its reading font.
const wordmark = [
  ['10000','10000','10000','10000','10000','10000','11111'],
  ['10001','10001','10001','10001','10001','10001','01110'],
  ['01111','10000','10000','10000','10000','10000','01111'],
  ['10001','10001','01010','00100','00100','00100','00100'],
  ['10001','11001','11001','10101','10011','10011','10001'],
  ['01110','10001','10001','11111','10001','10001','10001'],
];
export function PixelWordmark() {
  return <svg className="pixel-wordmark" viewBox="0 0 35 7" aria-hidden="true" focusable="false" shapeRendering="crispEdges">{wordmark.flatMap((letter,index)=>letter.flatMap((row,y)=>Array.from(row,(cell,x)=>cell==='1'?<rect key={`${index}-${x}-${y}`} x={index*6+x} y={y} width={1} height={1} fill="currentColor"/>:null)))}</svg>;
}
