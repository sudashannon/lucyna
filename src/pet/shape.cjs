// Native hit regions in window-local DIP coordinates. Reads alpha without
// modifying art. Runs only when the displayed asset or its layout changes.
function windowShape({bitmap,width,height,image,badge,bounds,source={x:0,y:0,width,height}}){
 if(!bitmap||bitmap.length<width*height*4)throw Error('Invalid sprite bitmap');
 if(!['x','y','width','height'].every(k=>Number.isInteger(source[k]))||source.x<0||source.y<0||source.width<=0||source.height<=0||source.x+source.width>width||source.y+source.height>height)throw Error('Invalid sprite source');
 for(const rect of [image,badge])for(const key of ['x','y','width','height'])if(!Number.isFinite(rect?.[key]))throw Error('Invalid sprite layout');
 if(image.width<=0||image.height<=0||badge.width<0||badge.height<0)throw Error('Invalid sprite dimensions');
 if([image,badge].some(r=>r.x<-.5||r.y<-.5||r.x+r.width>bounds.width+3||r.y+r.height>bounds.height+3))throw Error('Sprite layout outside window');
 const scale=Math.min(image.width/source.width,image.height/source.height),left=image.x+(image.width-source.width*scale)/2,top=image.y+(image.height-source.height*scale)/2;
 const opaque=(x,y)=>{const sx=Math.floor((x-left)/scale),sy=Math.floor((y-top)/scale);return sx>=0&&sy>=0&&sx<source.width&&sy<source.height&&bitmap[((sy+source.y)*width+sx+source.x)*4+3]>16;};
 const rects=[];let previous=new Map();
 for(let y=Math.max(0,Math.floor(top));y<Math.min(bounds.height,Math.ceil(top+source.height*scale));y++){
  const row=new Map();let start=-1;
  const end=Math.min(bounds.width,Math.ceil(left+source.width*scale));
  for(let x=Math.max(0,Math.floor(left));x<=end;x++){
   const solid=x<end&&(opaque(x+.25,y+.25)||opaque(x+.75,y+.75));
   if(solid&&start<0)start=x;
   if(!solid&&start>=0){const key=start+':'+(x-start),old=previous.get(key);if(old&&old.y+old.height===y){old.height++;row.set(key,old);}else{const r={x:start,y,width:x-start,height:1};rects.push(r);row.set(key,r);}start=-1;}
  }
  previous=row;
 }
 if(badge.width&&badge.height){const x=Math.max(0,Math.floor(badge.x)),y=Math.max(0,Math.floor(badge.y));rects.push({x,y,width:Math.max(0,Math.min(bounds.width-x,Math.ceil(badge.width))),height:Math.max(0,Math.min(bounds.height-y,Math.ceil(badge.height)))});}
 return rects;
}
// One stable native region for every pose. Changing SetWindowRgn every frame
// needlessly invalidates the transparent Windows surface and its hit region.
function unionRegions(groups,bounds){
 const width=Math.ceil(bounds.width),height=Math.ceil(bounds.height);
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width*height>1000000)throw Error('Invalid region bounds');
 const mask=new Uint8Array(width*height);
 for(const group of groups)for(const r of group){
  const left=Math.max(0,Math.floor(r.x)),right=Math.min(width,Math.ceil(r.x+r.width)),top=Math.max(0,Math.floor(r.y)),bottom=Math.min(height,Math.ceil(r.y+r.height));
  for(let y=top;y<bottom;y++)mask.fill(1,y*width+left,y*width+right);
 }
 const rects=[];let previous=new Map();
 for(let y=0;y<height;y++){
  const row=new Map();let start=-1;
  for(let x=0;x<=width;x++){
   const solid=x<width&&mask[y*width+x];
   if(solid&&start<0)start=x;
   if(!solid&&start>=0){const key=start+':'+(x-start),old=previous.get(key);if(old){old.height++;row.set(key,old);}else{const r={x:start,y,width:x-start,height:1};rects.push(r);row.set(key,r);}start=-1;}
  }
  previous=row;
 }
 return rects;
}
module.exports={windowShape,unionRegions};
