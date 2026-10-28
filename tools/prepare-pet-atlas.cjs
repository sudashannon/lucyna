// Metadata only: inspect original generated PNG alpha; never rewrite pixels.
const {nativeImage}=require('electron'),fs=require('node:fs'),path=require('node:path');
const directory=path.resolve(__dirname,'../src/pet'),atlases={};
for(const [name,file,rows,columns] of [
 ['duo','companions-atlas-v3.png',[0,333,642,944,1254],[0,323,638,952,1254]],
 ['cat','cat-atlas-v2.png',[0,320,620,929,1254],[0,321,631,948,1254]],
]){
 const img=nativeImage.createFromPath(path.join(directory,'assets',file)),{width,height}=img.getSize(),pixels=img.toBitmap();
 if(width!==1254||height!==1254)throw Error('Unexpected atlas dimensions: '+file);
 const frames=[];
 for(let row=0;row<4;row++)for(let col=0;col<4;col++){
  let left=width,top=height,right=0,bottom=0,count=0;
  for(let y=rows[row];y<rows[row+1];y++)for(let x=columns[col];x<columns[col+1];x++)if(pixels[(y*width+x)*4+3]>32){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);count++;}
  if(count<1000)throw Error('Empty animation frame');
  frames.push({x:left,y:top,width:right-left+1,height:bottom-top+1});
 }
 atlases[name]={file:'assets/'+file,width,height,frames,maxWidth:Math.max(...frames.map(f=>f.width)),maxHeight:Math.max(...frames.map(f=>f.height))};
}
fs.writeFileSync(path.join(directory,'animation-data.js'),'// Generated metadata; original artwork is retained unchanged.\n(function(root){const data='+JSON.stringify(atlases)+';if(typeof module!=="undefined"&&module.exports)module.exports=data;else root.CindyPetAtlas=data;})(globalThis);\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(atlases).map(([k,a])=>[k,{frames:a.frames.length,maxWidth:a.maxWidth,maxHeight:a.maxHeight}]))));
process.exit();
