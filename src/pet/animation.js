// Pure timing and frame placement, shared by renderer and tests. No OMP calls.
(function(root){
 const clips={
  idle:{frames:[0,1,2,3],durations:[2600,120,150,750],loop:true},
  working:{frames:[4,5,6,7],durations:[420,320,240,420],loop:true},
  attention:{frames:[8,9,10,11],durations:[650,200,200,650],loop:true},
  completed:{frames:[12,13,14,15,12,13,14,15],durations:[230,230,230,230,230,230,230,230],loop:false},
 };
 function clipFor(s){
  if(s.phase==='attention'||s.phase==='error'||s.pendingCount>0)return 'attention';
  if(s.activeCount>0||['working','thinking','retrying','compacting','settling','background','stopping','connecting'].includes(s.phase))return 'working';
  return s.phase==='completed'?'completed':'idle';
 }
 function sample(clip,elapsed,paused=false){
  const c=clips[clip]||clips.idle,total=c.durations.reduce((a,b)=>a+b,0);
  if(paused)return{frame:c.frames[0],delay:0};
  if(!c.loop&&elapsed>=total)return sample('idle',elapsed-total);
  let time=Math.max(0,elapsed)%total;
  for(let i=0;i<c.frames.length;i++){if(time<c.durations[i])return{frame:c.frames[i],delay:c.durations[i]-time};time-=c.durations[i];}
  return{frame:c.frames[0],delay:c.durations[0]};
 }
 function placement(atlas,index,width,height){
  const source=atlas.frames[index];if(!source)throw Error('Invalid animation frame');
  const scale=Math.min(Math.max(1,width-12)/atlas.maxWidth,Math.max(1,height-12)/atlas.maxHeight);
  return{source,image:{x:(width-source.width*scale)/2,y:height-6-source.height*scale,width:source.width*scale,height:source.height*scale}};
 }
 const api={clips,clipFor,sample,placement};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CindyPetAnimation=api;
})(globalThis);
