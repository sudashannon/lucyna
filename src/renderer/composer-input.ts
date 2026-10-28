export type PromptImage={type:'image';data:string;mimeType:string};
export type DraftImage=PromptImage&{id:string;name:string};
export const MAX_TEXT_BYTES=4*1024*1024,MAX_IMAGE_BYTES=10*1024*1024,MAX_IMAGES_BYTES=20*1024*1024,MAX_IMAGES=8;
export function validateInput(text:string,images:PromptImage[]){
 if(new TextEncoder().encode(text).length>MAX_TEXT_BYTES)throw Error('单条文本最多 4 MiB，请拆分后发送；原文保留在草稿中。');
 let spaces=0;for(let i=0;i<text.length;i++){spaces=text[i]===' '||text[i]==='\t'?spaces+1:0;if(spaces>65536)throw Error('文本含有超过 64 KiB 的连续空白，会阻塞当前原生 OMP；请编辑移除空白后再发送。');}
 if(images.length>MAX_IMAGES)throw Error('单条消息最多附加 8 张图片。');
 let bytes=0;
 for(const image of images){if(!/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType))throw Error('支持 PNG、JPEG、WebP 和 GIF 图片。');const size=Math.floor(image.data.length*3/4);if(size>MAX_IMAGE_BYTES)throw Error('单张图片最多 10 MiB。');bytes+=size;}
 if(bytes>MAX_IMAGES_BYTES)throw Error('图片总大小最多 20 MiB，请分批发送。');
}
export async function readImage(file:File):Promise<DraftImage>{
 if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type))throw Error('支持 PNG、JPEG、WebP 和 GIF 图片。');
 if(file.size>MAX_IMAGE_BYTES)throw Error('单张图片最多 10 MiB。');
 const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('读取图片失败，请重新粘贴。'));reader.readAsDataURL(file);});
 return {id:crypto.randomUUID(),name:file.name||'粘贴的图片',type:'image',mimeType:file.type,data};
}
export const nativeImages=(images:DraftImage[]):PromptImage[]=>images.map(({type,data,mimeType})=>({type,data,mimeType}));
