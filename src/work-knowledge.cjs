const fs=require('node:fs/promises'),path=require('node:path');
const {classifyWorkAsset,sensitiveDocument}=require('./work-knowledge-policy.cjs');
const {hash,inside}=require('./knowledge-library.cjs');
function createWorkKnowledge({listWorks,details,wslUnc,distro}){
 async function validate(root){if(!(await listWorks()).some(work=>work.root===root))throw Error('请选择当前登记的 Work');}
 async function capture(root,relative){
  await validate(root);const detail=await details(root),asset=detail.assets.find(a=>a.path===relative);if(!asset||asset.unavailable)throw Error('请从当前 Work 资产清单选择可读项目');
  const realRoot=await fs.realpath(wslUnc(root)),file=path.resolve(realRoot,...relative.split('/')),resolved=await fs.realpath(file);if(!inside(realRoot,resolved))throw Error('资产越出 Work 根目录，保留原件');
  const stat=await fs.stat(resolved),policy=classifyWorkAsset({...asset,size:stat.size,directory:stat.isDirectory()});if(!policy.allowed)throw Error(policy.reason);
  let bytes=null,content,sourceHash=null;
  if(stat.isFile()&&stat.size<=10*1024*1024){const handle=await fs.open(resolved,'r');try{const chunks=[];let length=0;for(;;){const buffer=Buffer.alloc(Math.min(64*1024,10*1024*1024-length+1));const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;length+=bytesRead;if(length>10*1024*1024)throw Error('读取期间资产超过上限，请重试');chunks.push(buffer.subarray(0,bytesRead));}bytes=Buffer.concat(chunks);}finally{await handle.close();}sourceHash=hash(bytes);}
  if(policy.snapshot&&['note','log'].includes(asset.kind)){
   if(!bytes||bytes.length>2*1024*1024)throw Error('文本超过 2 MiB；请先选择必要片段，原文保留在 Work');
   try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('工作笔记必须使用 UTF-8 编码');}
   if(sensitiveDocument(content))throw Error('内容含疑似访问凭据或私钥，请脱敏后再保存为资料');
  }
  return {root,relative,title:asset.title||asset.name,kind:asset.kind,policy,sourceHash,sourceSize:stat.size,content,...(policy.snapshot&&content===undefined&&bytes?{base64:bytes.toString('base64')}:{}) ,locator:{distro,root,relative,modifiedAt:stat.mtime.toISOString(),verification:sourceHash?'sha256':'metadata-only'}};
 }
 return {validate,capture};
}
module.exports={createWorkKnowledge};
