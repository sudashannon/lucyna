const api=window.companion,img=document.getElementById('character'),badge=document.getElementById('badge'),canvas=document.getElementById('animation');
const Animation=window.CindyPetAnimation,atlases=window.CindyPetAtlas,assets=new Map();
const motionPreference=matchMedia('(prefers-reduced-motion: reduce)');
let lastHit=false,mask=null,appearance='duo',layoutFrame=0,layoutRetries=0;
let snapshot,animationKey='',clip='idle',started=0,timer=0,currentFrame=-1,currentAsset=null,geometry=null,loadRevision=0,paintCount=0,canvasLost=false;
const report=e=>{badge.textContent='桌宠暂不可用';console.error(e);};
const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
function hit(value){if(value===lastHit)return;lastHit=value;api.hit(value).catch(report);}
function reportLayout(){
 if(layoutFrame)return;
 layoutFrame=requestAnimationFrame(()=>{
  layoutFrame=0;if(!geometry)return;
  api.layout({appearance,viewport:{width:innerWidth,height:innerHeight},image:geometry.image,badge:rect(badge),...(geometry.frame===undefined?{}:{frame:geometry.frame})})
   .then(applied=>{if(applied===false&&layoutRetries++<6)setTimeout(reportLayout,100);else if(applied)layoutRetries=0;}).catch(report);
 });
}
function readMask(image){
 const surface=document.createElement('canvas');surface.width=image.naturalWidth;surface.height=image.naturalHeight;
 const ctx=surface.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
 return{width:surface.width,height:surface.height,data:ctx.getImageData(0,0,surface.width,surface.height).data};
}
function staticGeometry(){
 if(!mask||!canvas.hidden)return;
 const r=rect(img),scale=Math.min(r.width/mask.width,r.height/mask.height);
 geometry={image:{x:r.x+(r.width-mask.width*scale)/2,y:r.y+(r.height-mask.height*scale)/2,width:mask.width*scale,height:mask.height*scale},source:{x:0,y:0,width:mask.width,height:mask.height},mask};
 reportLayout();
}
img.addEventListener('load',()=>{mask=readMask(img);staticGeometry();});
if(img.complete&&img.naturalWidth)mask=readMask(img);
function loadAtlas(name){
 if(!assets.has(name))assets.set(name,new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{try{resolve({image,mask:readMask(image),atlas:atlases[name]});}catch(e){reject(e);}};image.onerror=()=>reject(Error('角色动画素材加载失败，已保留静态角色'));image.src=atlases[name].file;}));
 return assets.get(name);
}
function reduced(){return snapshot?.settings.animationMode!=='always'&&(!!snapshot?.settings.reducedMotion||motionPreference.matches);}
// A transparent topmost window can be reported as occluded by Chromium even
// while it remains visible on the desktop. Only the controller knows whether
// the user hid/locked the pet; page visibility must not stop its timer.
function pauseReason(){return !snapshot?'loading':snapshot.hidden?'hidden':snapshot.locked?'locked':reduced()?(snapshot.settings.reducedMotion?'app-reduced-motion':'system-reduced-motion'):snapshot.dragging?'dragging':'';}
function paint(index){
 if(!currentAsset)return;
 const surface=rect(canvas),dpr=Math.min(devicePixelRatio||1,3),w=Math.round(surface.width*dpr),h=Math.round(surface.height*dpr);
 if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
 const {source,image}=Animation.placement(currentAsset.atlas,index,surface.width,surface.height),ctx=canvas.getContext('2d');
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,surface.width,surface.height);
 ctx.drawImage(currentAsset.image,source.x,source.y,source.width,source.height,image.x,image.y,image.width,image.height);
 geometry={source,image:{...image,x:image.x+surface.x,y:image.y+surface.y},mask:currentAsset.mask,frame:index};
 currentFrame=index;canvas.dataset.frame=String(index);canvas.dataset.clip=clip;canvas.dataset.paints=String(++paintCount);reportLayout();
}
function tick(force=false){
 clearTimeout(timer);timer=0;if(canvas.hidden||!currentAsset)return;
 const reason=pauseReason(),frozen=!!reason,step=Animation.sample(clip,performance.now()-started,frozen);
 const index=frozen&&currentFrame>=0&&!reduced()?currentFrame:step.frame;
 if(force||index!==currentFrame)paint(index);
 canvas.dataset.playing=String(!frozen&&step.delay>0);
 canvas.dataset.pauseReason=reason||(!step.delay?'settled':'');
 const names={loading:'加载中',hidden:'已隐藏',locked:'已锁屏','app-reduced-motion':'客户端减少动态效果','system-reduced-motion':'系统减少动态效果',dragging:'正在拖动',settled:'动作已结束'};
 canvas.title=badge.title=`${labels[snapshot?.phase]||'准备好了'} · ${canvas.dataset.playing==='true'?'动画播放中':names[canvas.dataset.pauseReason]||'静止'} · 拖动角色移动，点击状态查看待办`;
 if(!frozen&&step.delay>0)timer=setTimeout(()=>tick(),Math.max(30,step.delay));
}
async function updateAnimation(s,force=false){
 const nextClip=Animation.clipFor(s),notice=s.notices?.filter(n=>n.kind===nextClip).at(-1)?.id||'',key=appearance+':'+nextClip+':'+notice;
 if(key!==animationKey){animationKey=key;clip=nextClip;started=performance.now();currentFrame=-1;}
 if(!s.settings.animated||canvasLost){loadRevision++;clearTimeout(timer);timer=0;currentAsset=null;canvas.hidden=true;img.style.visibility='';canvas.dataset.playing='false';canvas.dataset.pauseReason=canvasLost?'context-lost':'disabled';badge.title=canvasLost?'绘图上下文暂不可用，已显示静态角色':'桌宠动画已关闭';staticGeometry();return;}
 const revision=++loadRevision,name=appearance;
 try{
  const asset=await loadAtlas(name);if(revision!==loadRevision||!snapshot.settings.animated)return;
  const changed=currentAsset!==asset||canvas.hidden;
  currentAsset=asset;canvas.hidden=false;img.style.visibility='hidden';tick(changed||force);
 }catch(e){if(revision!==loadRevision)return;currentAsset=null;canvas.hidden=true;img.style.visibility='';staticGeometry();console.warn(e.message);}
}
function opaque(x,y){
 const b=badge.getBoundingClientRect();if(x>=b.left&&x<=b.right&&y>=b.top&&y<=b.bottom)return true;
 if(!geometry)return false;const {image:r,source:s,mask:m}=geometry;
 const sx=Math.floor((x-r.x)/r.width*s.width),sy=Math.floor((y-r.y)/r.height*s.height);
 return sx>=0&&sy>=0&&sx<s.width&&sy<s.height&&m.data[((sy+s.y)*m.width+sx+s.x)*4+3]>16;
}
const layoutObserver=new ResizeObserver(()=>{if(canvas.hidden)staticGeometry();else tick(true);});
layoutObserver.observe(img);layoutObserver.observe(badge);
window.addEventListener('resize',()=>{layoutRetries=0;if(canvas.hidden)staticGeometry();else tick(true);});
// A restored compositor/canvas may have lost its pixels while the logical frame
// is unchanged. This also matters with reduced motion, where no timer repaints.
function refresh(){layoutRetries=0;if(snapshot)void updateAnimation(snapshot,true);}
document.addEventListener('visibilitychange',refresh);
window.addEventListener('pageshow',refresh);
window.addEventListener('focus',refresh);
canvas.addEventListener('contextlost',()=>{canvasLost=true;refresh();});
canvas.addEventListener('contextrestored',()=>{canvasLost=false;currentFrame=-1;refresh();});
api.onRefresh?.(refresh);
motionPreference.addEventListener('change',()=>{if(snapshot)render(snapshot);});
document.addEventListener('mousemove',e=>{if(!snapshot?.dragging)hit(opaque(e.clientX,e.clientY));});
document.addEventListener('mouseleave',()=>{if(!snapshot?.dragging)hit(false);});
// The character uses Electron's native window drag region. The status chip is
// a normal button, so moving the pet never accidentally opens the inbox.
badge.addEventListener('click',()=>api.action('inbox').catch(report));
document.addEventListener('contextmenu',e=>{e.preventDefault();api.action('inbox').catch(report);});
const labels={idle:'准备好了',connecting:'正在连接 OMP',disconnected:'连接已结束',working:'正在工作',thinking:'正在思考',attention:'等待你处理',completed:'本轮已完成',aborted:'已停止',error:'需要检查',retrying:'正在重试',compacting:'整理上下文',settling:'正在收尾',background:'等待后续任务',stopping:'正在停止'};
function render(s){
 const restored=!!snapshot&&(snapshot.hidden&&!s.hidden||snapshot.locked&&!s.locked);
 snapshot=s;appearance=s.settings.appearance;document.body.dataset.theme=s.theme;document.body.dataset.phase=s.phase;document.body.dataset.animationMode=s.settings.animationMode||'system';document.body.dataset.reduced=String(reduced()||s.hidden||s.locked||!s.settings.animated);
 const src=appearance==='cat'?'assets/cat.png':'assets/companions.png';if(img.getAttribute('src')!==src){mask=null;img.src=src;}
 badge.textContent=s.settings.quiet?(s.pendingCount?`勿扰 · ${s.pendingCount} 条待办`:'勿扰中'):s.pendingCount?`${s.pendingCount} 条待处理`:s.activeCount?`${s.activeCount} 个运行中`:(labels[s.phase]||'准备好了');
 img.title=canvas.title='拖动角色移动 · 点击下方状态查看待办';void updateAnimation(s,restored);
}
api.subscribe(render);api.snapshot().then(render).catch(report);
