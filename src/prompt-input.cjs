// Validate transport inputs without modifying the text or image payload.
function validatePrompt(data){
 if(!data||typeof data.message!=='string')throw Error('请输入消息文本');
 if(Buffer.byteLength(data.message)>4*1024*1024)throw Error('单条文本最多 4 MiB，请拆分发送');
 let spaces=0;for(let i=0;i<data.message.length;i++){spaces=data.message[i]===' '||data.message[i]==='\t'?spaces+1:0;if(spaces>65536)throw Error('文本含有超过 64 KiB 的连续空白，请移除后再发送');}
 if(data.images!==undefined&&!Array.isArray(data.images))throw Error('无效图片附件');
 const images=data.images||[];if(images.length>8)throw Error('单条消息最多 8 张图片');let total=0;
 for(const image of images){
  if(image?.type!=='image'||!/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType)||typeof image.data!=='string'||!image.data.length||image.data.length%4||/[^A-Za-z0-9+/=]/.test(image.data))throw Error('图片数据或格式无效');
  const size=Buffer.byteLength(image.data,'base64');if(size>10*1024*1024)throw Error('单张图片最多 10 MiB');total+=size;
 }
 if(total>20*1024*1024)throw Error('图片总大小最多 20 MiB');
 if(!data.message.trim()&&!images.length)throw Error('请输入文本或添加图片');
 return data;
}
module.exports={validatePrompt};
