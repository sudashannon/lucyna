const {Worker,isMainThread,parentPort}=require('node:worker_threads');
const {createHash}=require('node:crypto');
if(!isMainThread){
 const parser=Promise.all([import('unified'),import('remark-parse')]).then(([{unified},{default:parse}])=>unified().use(parse));
 parentPort.on('message',async({id,content,excludeQuotes})=>{try{
  const urls=[],definitions=new Map(),refs=[];
  function visit(node){if(excludeQuotes&&node.type==='blockquote')return;if(node.type==='definition')definitions.set(node.identifier,node.url);if(node.type==='link'||node.type==='image')urls.push(node.url);if(node.type==='linkReference'||node.type==='imageReference')refs.push(node.identifier);for(const child of node.children||[])visit(child);}
  visit((await parser).parse(content));for(const ref of refs)if(definitions.has(ref))urls.push(definitions.get(ref));parentPort.postMessage({id,urls:[...new Set(urls)]});
 }catch{parentPort.postMessage({id,error:true});}});
}else{
 let worker=null,sequence=0;const pending=new Map(),cache=new Map();
 function launch(){
  const created=new Worker(__filename);worker=created;
  created.on('message',message=>{const task=pending.get(message.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error('Markdown 引用解析失败，原文未修改')):task.resolve(message.urls);if(!pending.size)created.unref();});
  const failed=()=>{if(worker!==created)return;worker=null;for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error('Markdown 引用解析中断，原文未修改'));}pending.clear();};created.on('error',failed);created.on('exit',failed);return created;
 }
 async function links(content,{excludeQuotes=false}={}){
  const key=(excludeQuotes?'quotes:':'all:')+createHash('sha256').update(content).digest('hex');
  if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return [...value];}
  const active=worker||launch();active.ref();const id=++sequence;
  const urls=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Markdown 引用解析超时，原文未修改'));if(!pending.size)active.unref();},60000);pending.set(id,{resolve,reject,timer});active.postMessage({id,content,excludeQuotes});});
  cache.set(key,urls);if(cache.size>2048)cache.delete(cache.keys().next().value);return [...urls];
 }
 module.exports={links};
}
