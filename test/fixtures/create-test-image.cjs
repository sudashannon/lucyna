// Deterministic synthetic pixels, never a user's clipboard or screenshot.
const fs=require('node:fs'),zlib=require('node:zlib');
function crc(b){let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([name,data])),8+data.length);return out;}
const width=240,height=160,raw=Buffer.alloc(height*(width*3+1),255);for(let y=0;y<height;y++){raw[y*(width*3+1)]=0;for(let x=0;x<width;x++){const i=y*(width*3+1)+1+x*3;if(x>20&&x<100&&y>40&&y<120){raw[i]=235;raw[i+1]=30;raw[i+2]=30;}else if((x-175)**2+(y-80)**2<40**2){raw[i]=30;raw[i+1]=70;raw[i+2]=235;}}}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;fs.writeFileSync(process.argv[2],Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
