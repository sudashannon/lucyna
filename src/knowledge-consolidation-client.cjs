// Only the main process can register Work roots or synchronize decrypted credentials.
class ConsolidationClient{
 constructor({knowledge,listWorks,wslUnc,auxiliary,busy=()=>false}){Object.assign(this,{knowledge,listWorks,wslUnc,auxiliary,busy});this.error='';}
 async sync(){
  if(this.pending)return this.pending;
  if(this.upgradeWaitUntil>Date.now())throw Error(this.error);
  this.pending=(async()=>{
   const connection=await this.knowledge.runtime.ensure();
   if(!connection.health?.capabilities?.includes('knowledge-consolidation')){this.upgradeWaitUntil=Date.now()+16*60000;throw Error('当前知识服务尚未加载知识沉淀功能；下次服务启动后生效，现有任务保持运行');}
   const works=(await this.listWorks()).filter(w=>w.kind!=='invalid').map(w=>({root:w.root,directory:this.wslUnc(w.root),busy:this.busy(w.root)}));
   await this.knowledge.runtime.call('/api/consolidation/sync',{method:'POST',body:{works,auxiliary:await this.auxiliary().catch(()=>null)}});this.error='';
  })().catch(e=>{this.error=e.message;throw e;}).finally(()=>{this.pending=null;});return this.pending;
 }
 start(){void this.sync().catch(()=>{});this.timer=setInterval(()=>void this.sync().catch(()=>{}),30000);this.timer.unref();}
 async stop(){clearInterval(this.timer);await this.pending?.catch(()=>{});}
 async call(kind,args={}){
  if(!['consolidationStatus','consolidationConfigure','consolidationRead'].includes(kind)||!args||Object.keys(args).some(k=>!['root','enabled','retry'].includes(k)))throw Error('无效知识沉淀请求');
  if(!(await this.listWorks()).some(w=>w.root===args.root&&w.kind!=='invalid'))throw Error('请选择有效 Work');
  await this.sync();
  if(kind==='consolidationConfigure')return this.knowledge.runtime.call('/api/consolidation/configure',{method:'POST',body:args});
  const status=await this.knowledge.runtime.call('/api/consolidation/status?'+new URLSearchParams({root:args.root}));
  if(kind==='consolidationRead'){if(!status.document)throw Error('此 Work 尚无已沉淀知识');return this.knowledge('libraryRead',{document:status.document.id});}
  return status;
 }
}
module.exports={ConsolidationClient};
