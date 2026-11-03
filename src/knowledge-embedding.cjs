const {parentPort,workerData}=require('node:worker_threads');
try{
 const {embed}=require(workerData.module);
 // Loading the packaged WASM is part of readiness, before admitting searches.
 embed('Lucyna readiness');parentPort.postMessage({ready:true});
 parentPort.on('message',({id,input})=>{try{if(!Array.isArray(input)||input.length>5000)throw Error('Invalid embedding batch');const output=input.map(item=>{if(typeof item.id!=='string'||typeof item.text!=='string'||item.text.length>128000)throw Error('Invalid embedding input');return {id:item.id,vector:Array.from(embed(item.text))};});parentPort.postMessage({id,output});}catch(error){parentPort.postMessage({id,error:error.message});}});
}catch(error){parentPort.postMessage({error:error.message});}
