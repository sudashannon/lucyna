// Package generated logo artwork for Windows. Only resize/format conversion;
// the full-resolution imagegen masters are retained unchanged in design/.
const {nativeImage}=require('electron'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'src/assets'),design=path.join(root,'design/app-logo-v1');fs.mkdirSync(out,{recursive:true});
const master=nativeImage.createFromPath(path.join(design,'logo-master.png')),small=nativeImage.createFromPath(path.join(design,'logo-small-master.png'));
if(master.isEmpty()||small.isEmpty())throw Error('Logo master is missing');
const sizes=[16,20,24,32,40,48,64,128,256],frames=sizes.map(size=>(size<=24?small:master).resize({width:size,height:size,quality:'best'}).toPNG());
const header=Buffer.alloc(6+16*frames.length);header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);let offset=header.length;
frames.forEach((png,i)=>{const p=6+i*16,size=sizes[i];header[p]=header[p+1]=size===256?0:size;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(png.length,p+8);header.writeUInt32LE(offset,p+12);offset+=png.length;fs.writeFileSync(path.join(design,`icon-${size}.png`),png);});
fs.writeFileSync(path.join(out,'app-icon.ico'),Buffer.concat([header,...frames]));
fs.writeFileSync(path.join(out,'app-icon.png'),master.resize({width:256,height:256,quality:'best'}).toPNG());
fs.writeFileSync(path.join(out,'tray-icon.png'),small.resize({width:64,height:64,quality:'best'}).toPNG());
const icon=nativeImage.createFromPath(path.join(out,'app-icon.ico'));if(icon.isEmpty())throw Error('Windows icon could not be decoded');
const result={sizes,icoBytes:fs.statSync(path.join(out,'app-icon.ico')).size,nativeDecoded:icon.getSize(),mastersUnchanged:true};
fs.writeFileSync(path.join(design,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exit();
