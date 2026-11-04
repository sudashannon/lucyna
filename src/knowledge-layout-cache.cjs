const path=require('node:path');
function remapEmbeddingCache(input,mapping){
 const bytes=Buffer.from(input);if(bytes.length<10||bytes.subarray(0,4).toString()!=='CPEM'||bytes.readUInt16LE(4)!==2)throw Error('知识向量缓存格式不兼容');
 const count=bytes.readUInt32LE(6);if(count>1000000)throw Error('知识向量缓存条目过多');let pos=10,changed=0;const entries=[],seen=new Set();
 for(let i=0;i<count;i++){
  if(pos+4>bytes.length)throw Error('知识向量缓存不完整');const n=bytes.readUInt32LE(pos);pos+=4;if(!n||n>1048576||pos+n+36>bytes.length)throw Error('知识向量缓存不完整');
  const old=bytes.subarray(pos,pos+n).toString('utf8');pos+=n;const metadata=pos,len=bytes.readUInt16LE(pos+34);if(!len||len>4096||pos+36+len*4>bytes.length)throw Error('知识向量缓存不完整');pos+=36+len*4;
  const next=mapping.get(path.resolve(old).toLowerCase())||old;if(next!==old)changed++;if(seen.has(next.toLowerCase()))throw Error('知识向量缓存映射冲突');seen.add(next.toLowerCase());const id=Buffer.from(next),head=Buffer.alloc(4);head.writeUInt32LE(id.length);entries.push(Buffer.concat([head,id,bytes.subarray(metadata,pos)]));
 }
 if(pos!==bytes.length)throw Error('知识向量缓存尾部无效');return {bytes:Buffer.concat([bytes.subarray(0,10),...entries]),entries:count,remapped:changed};
}
module.exports={remapEmbeddingCache};
