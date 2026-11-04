const path=require('node:path'),{randomUUID}=require('node:crypto');
const {KnowledgeRuntime}=require('./knowledge-runtime.cjs');
const {createKnowledgeService}=require('./knowledge-service.cjs');
function createManagedKnowledge({directory,chooseDirectory,executable=process.execPath,workAssets}={}){
 const runtime=new KnowledgeRuntime(directory,{executable}),service=createKnowledgeService(runtime.fetch.bind(runtime)),selections=new Map();
 const knowledge=async(kind,args={},progress)=>{
  switch(kind){
   case 'governanceStatus':case 'governanceGet':case 'governanceConfigure':case 'governanceAction':{
    const state=await runtime.ensure();if(!state.health?.capabilities?.includes('knowledge-governance'))throw Error('当前知识服务尚未加载重复与冲突检查；请在现有任务结束后重启知识服务');
    if(kind==='governanceStatus')return runtime.call('/api/governance/status');
    if(kind==='governanceGet')return runtime.call('/api/governance/get?'+new URLSearchParams({id:args.id}));
    if(kind==='governanceConfigure')return runtime.call('/api/governance/configure',{method:'POST',body:{enabled:args.enabled,scan:args.scan}});
    return runtime.call('/api/governance/action',{method:'POST',body:{id:args.id,action:args.action,version:args.version,note:args.note}});
   }
   case 'maintenanceStatus':case 'maintenanceGet':case 'maintenanceConfigure':case 'maintenanceAction':{
    const state=await runtime.ensure();if(!state.health?.capabilities?.includes('knowledge-maintenance'))throw Error('当前知识服务尚未加载自动维护；请在现有任务结束后重启知识服务');
    if(kind==='maintenanceStatus')return runtime.call('/api/maintenance/status');
    if(kind==='maintenanceGet')return runtime.call('/api/maintenance/get?'+new URLSearchParams({id:args.id}));
    if(kind==='maintenanceConfigure')return runtime.call('/api/maintenance/configure',{method:'POST',body:{enabled:args.enabled,autoApply:args.autoApply,scan:args.scan}});
    return runtime.call('/api/maintenance/action',{method:'POST',body:{id:args.id,action:args.action}});
   }
   case 'document':{const state=await runtime.ensure(),result=await service(kind,args,progress);if(state.health?.capabilities?.includes('knowledge-maintenance'))result.maintenance=await runtime.call('/api/maintenance/document?'+new URLSearchParams({document:args.id}));return result;}
   case 'workAssetList':{if(!workAssets)throw Error('当前窗口未接入 Work 资料');await workAssets.validate(args.root);return runtime.call('/api/work-material/list?'+new URLSearchParams({root:args.root,query:args.query||''}));}
   case 'workAssetCapture':{if(!workAssets)throw Error('当前窗口未接入 Work 资料');const input=await workAssets.capture(args.root,args.path);return runtime.call('/api/work-material/capture',{method:'POST',body:input});}
   case 'workAssetRead':{if(!workAssets)throw Error('当前窗口未接入 Work 资料');await workAssets.validate(args.root);return runtime.call('/api/work-material/read?'+new URLSearchParams({root:args.root,id:args.id}));}
   case 'libraryStatus':{const state=await runtime.ensure(),engineRoot=process.resourcesPath&&require('node:fs').existsSync(path.join(process.resourcesPath,'knowledge-engine/manifest.json'))?path.join(process.resourcesPath,'knowledge-engine'):path.resolve(__dirname,'../resources/knowledge-engine'),manifest=JSON.parse(require('node:fs').readFileSync(path.join(engineRoot,'manifest.json'),'utf8'));return {managed:true,ready:state.health.ready,embeddingReady:state.health.embeddingReady,unified:state.health.unified===true,directory:runtime.directory,sourceHash:state.sourceHash,mcp:{command:path.join(engineRoot,manifest.binary),args:['--lucyna-mcp','--knowledge-data',runtime.directory,'--write']}};}
   case 'libraryRestart':{await runtime.restart();await service('catalog',{refresh:true});return {ready:true};}
   case 'libraryList':return runtime.call('/api/library/libraries');
   case 'librarySyncStatus':return runtime.call('/api/library/sync/status');
   case 'librarySyncConfigure':return runtime.call('/api/library/sync/config',{method:'POST',body:{remote:args.remote}});
   case 'librarySyncAutomatic':return runtime.call('/api/library/sync/automatic',{method:'POST',body:{enabled:args.enabled}});
   case 'librarySyncRun':{const result=await runtime.call('/api/library/sync/run',{method:'POST',body:{}});if(result.imported)await service('catalog',{refresh:true});return result;}
   case 'libraryCreate':return runtime.call('/api/library/libraries',{method:'POST',body:{name:args.name}});
   case 'libraryChooseDirectory':{const selected=await chooseDirectory();if(!selected)return null;const id=randomUUID();if(selections.size>=32)selections.delete(selections.keys().next().value);selections.set(id,{path:selected,expires:Date.now()+30*60*1000});return {sourceToken:id,path:selected};}
   case 'libraryScan':{const selected=selections.get(args.sourceToken);if(!selected||selected.expires<Date.now())throw Error('导入目录选择已过期，请重新选择');return runtime.call('/api/library/scan',{method:'POST',body:{path:selected.path,library:args.library}});}
   case 'libraryImport':{const result=await runtime.call('/api/library/import',{method:'POST',body:{id:args.id}});await service('catalog',{refresh:true});return result;}
   case 'libraryWrite':{const result=await runtime.call('/api/library/write',{method:'POST',body:{library:args.library,relative:args.relative,category:args.category,document:args.document,content:args.content,expected:args.expected,operationId:args.operationId}});await service('catalog',{refresh:true});return result;}
   case 'libraryRead':return runtime.call('/api/library/read?'+new URLSearchParams({document:args.document}));
   case 'libraryHistory':return runtime.call('/api/library/history?'+new URLSearchParams({document:args.document}));
   // Start the host before the operation-specific request timeout begins. A
   // large first index build can legitimately take longer than a normal read.
   default:await runtime.ensure();return service(kind,args,progress);
  }
 };
 knowledge.runtime=runtime;return knowledge;
}
module.exports={createManagedKnowledge};
