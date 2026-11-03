const path=require('node:path'),{randomUUID}=require('node:crypto');
const {KnowledgeRuntime}=require('./knowledge-runtime.cjs');
const {createKnowledgeService}=require('./knowledge-service.cjs');
function createManagedKnowledge({directory,chooseDirectory,executable=process.execPath,workAssets}={}){
 const runtime=new KnowledgeRuntime(directory,{executable}),service=createKnowledgeService(runtime.fetch.bind(runtime)),selections=new Map();
 const knowledge=async(kind,args={},progress)=>{
  switch(kind){
   case 'workAssetList':{if(!workAssets)throw Error('当前窗口未接入 Work 资料');await workAssets.validate(args.root);return runtime.call('/api/work-material/list?'+new URLSearchParams({root:args.root,query:args.query||''}));}
   case 'workAssetCapture':{if(!workAssets)throw Error('当前窗口未接入 Work 资料');const input=await workAssets.capture(args.root,args.path);return runtime.call('/api/work-material/capture',{method:'POST',body:input});}
   case 'workAssetRead':{if(!workAssets)throw Error('当前窗口未接入 Work 资料');await workAssets.validate(args.root);return runtime.call('/api/work-material/read?'+new URLSearchParams({root:args.root,id:args.id}));}
   case 'libraryStatus':{const state=await runtime.ensure(),engineRoot=process.resourcesPath&&require('node:fs').existsSync(path.join(process.resourcesPath,'knowledge-engine/manifest.json'))?path.join(process.resourcesPath,'knowledge-engine'):path.resolve(__dirname,'../resources/knowledge-engine'),manifest=JSON.parse(require('node:fs').readFileSync(path.join(engineRoot,'manifest.json'),'utf8'));return {managed:true,ready:state.health.ready,embeddingReady:state.health.embeddingReady,directory:runtime.directory,sourceHash:state.sourceHash,mcp:{command:path.join(engineRoot,manifest.binary),args:['--lucyna-mcp','--knowledge-data',runtime.directory,'--write']}};}
   case 'libraryList':return runtime.call('/api/library/libraries');
   case 'libraryCreate':return runtime.call('/api/library/libraries',{method:'POST',body:{name:args.name}});
   case 'libraryChooseDirectory':{const selected=await chooseDirectory();if(!selected)return null;const id=randomUUID();if(selections.size>=32)selections.delete(selections.keys().next().value);selections.set(id,{path:selected,expires:Date.now()+30*60*1000});return {sourceToken:id,path:selected};}
   case 'libraryScan':{const selected=selections.get(args.sourceToken);if(!selected||selected.expires<Date.now())throw Error('导入目录选择已过期，请重新选择');return runtime.call('/api/library/scan',{method:'POST',body:{path:selected.path,library:args.library}});}
   case 'libraryImport':{const result=await runtime.call('/api/library/import',{method:'POST',body:{id:args.id}});await service('catalog',{refresh:true});return result;}
   case 'libraryWrite':{const result=await runtime.call('/api/library/write',{method:'POST',body:{library:args.library,relative:args.relative,document:args.document,content:args.content,expected:args.expected,operationId:args.operationId}});await service('catalog',{refresh:true});return result;}
   case 'libraryRead':return runtime.call('/api/library/read?'+new URLSearchParams({document:args.document}));
   case 'libraryHistory':return runtime.call('/api/library/history?'+new URLSearchParams({document:args.document}));
   default:return service(kind,args,progress);
  }
 };
 knowledge.runtime=runtime;return knowledge;
}
module.exports={createManagedKnowledge};
