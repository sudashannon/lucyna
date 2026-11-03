const http=require('node:http'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {spawn}=require('node:child_process'),{Worker}=require('node:worker_threads'),{randomUUID,randomBytes,timingSafeEqual}=require('node:crypto');
const {KnowledgeLibrary,hash,inside,failure}=require('./knowledge-library.cjs');
let standalone=false;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const json=(response,value,status=200)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(value));};
async function body(request,limit=32*1024*1024){const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>limit)throw failure('请求内容超过大小限制',413);chunks.push(chunk);}return Buffer.concat(chunks);}
const tools=[
 {name:'work_material_list',description:'List saved materials for one explicitly selected Work. These are not shared knowledge and are excluded from global search.',inputSchema:{type:'object',properties:{root:{type:'string'},query:{type:'string'}},required:['root']},annotations:{readOnlyHint:true}},
 {name:'work_material_read',description:'Read a saved Work-scoped text snapshot or evidence metadata. Must supply its owning Work root.',inputSchema:{type:'object',properties:{root:{type:'string'},id:{type:'string'}},required:['root','id']},annotations:{readOnlyHint:true}},
 {name:'library_list',description:'List Lucyna-managed internal knowledge libraries.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}},
 {name:'library_documents',description:'List stable document IDs, revisions and native Stele paths in a library.',inputSchema:{type:'object',properties:{library:{type:'string'}},required:['library']},annotations:{readOnlyHint:true}},
 {name:'library_read',description:'Read a managed document with its revision and ETag before editing.',inputSchema:{type:'object',properties:{document:{type:'string'}},required:['document']},annotations:{readOnlyHint:true}},
 {name:'library_write',description:'Create or update a Markdown document. Updates require the revision/ETag returned by library_read; use expected=new only for a new path. operationId makes retries idempotent.',inputSchema:{type:'object',properties:{library:{type:'string'},document:{type:'string'},relative:{type:'string'},content:{type:'string'},expected:{type:'string'},operationId:{type:'string'}},required:['content','expected','operationId']},annotations:{readOnlyHint:false}},
 {name:'library_history',description:'List immutable document revisions.',inputSchema:{type:'object',properties:{document:{type:'string'}},required:['document']},annotations:{readOnlyHint:true}},
];
async function startKnowledgeHost({directory,engineDirectory=process.resourcesPath&&fs.existsSync(path.join(process.resourcesPath,'knowledge-engine/manifest.json'))?path.join(process.resourcesPath,'knowledge-engine'):path.resolve(__dirname,'../resources/knowledge-engine'),idleMs=15*60*1000}={}){
 if(!directory||!path.isAbsolute(directory))throw Error('Knowledge data directory must be absolute');
 const root=path.resolve(directory),runtime=path.join(root,'runtime');fs.mkdirSync(runtime,{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(engineDirectory,'manifest.json'),'utf8')),binary=path.join(engineDirectory,manifest.binary);
 if(path.basename(manifest.binary)!==manifest.binary||hash(fs.readFileSync(binary))!==manifest.sha256)throw Error('内置 Stele 运行包校验失败，请重新构建知识引擎');
 for(const [relative,digest] of Object.entries(manifest.embeddingFiles||{})){const target=path.resolve(__dirname,'../third_party/ternlight-base',relative);if(!inside(path.resolve(__dirname,'../third_party/ternlight-base'),target)||hash(fs.readFileSync(target))!==digest)throw Error('内置向量运行包校验失败，请重新构建知识引擎');}
 const store=new KnowledgeLibrary(root),instanceId=randomUUID(),token=randomBytes(32).toString('hex');let engineURL='',child,ready=false,closing=false,lastUsed=Date.now(),embeddingReady=false,activeRequests=0;
 const pending=new Map();let sequence=0;
 const worker=new Worker(path.join(__dirname,'knowledge-embedding.cjs'),{workerData:{module:path.resolve(__dirname,'../third_party/ternlight-base/src/index.js')}});
 const workerReady=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('向量运行时初始化超时')),20000);worker.on('message',message=>{if(message.ready){embeddingReady=true;clearTimeout(timer);resolve();}else if(message.id){const task=pending.get(message.id);if(task){pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error(message.error)):task.resolve(message.output);}}else if(message.error){clearTimeout(timer);reject(Error(message.error));}});worker.on('error',reject);});
 worker.on('exit',()=>{embeddingReady=false;for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error('向量工作进程已退出'));}pending.clear();if(ready&&!closing)setImmediate(()=>void stop().then(()=>{if(standalone)process.exit(1);}));});
 const embed=input=>new Promise((resolve,reject)=>{if(pending.size>=16)return reject(failure('索引队列繁忙，请稍后重试',429));const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('向量计算超时'));},120000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,input});});
 async function native(route,{method='GET',bytes,headers={},signal}={}){
  const mcpToken=route.startsWith('/mcp')?fs.readFileSync(path.join(root,'engine-state/mcp-write-token'),'utf8').trim():'';
  return fetch(new URL(route,engineURL),{method,body:bytes,headers:{...headers,'X-Lucyna-Engine-Token':token,...(mcpToken?{Authorization:'Bearer '+mcpToken}:{})},signal:signal||AbortSignal.timeout(180000),redirect:'error'});
 }
 async function nativeJSON(route,options){const r=await native(route,options);if(!r.ok)throw failure('知识引擎请求失败（'+r.status+'）：'+(await r.text()).slice(0,800),r.status);return r.status===204?null:r.json();}
 async function register(library){const lib=store.get(library);if(!lib.documents)return;const spaces=await nativeJSON('/api/workspaces');if(!spaces.some(s=>s.alias===lib.alias))await nativeJSON('/api/workspaces',{method:'POST',bytes:JSON.stringify({alias:lib.alias,path:lib.path,type:'docs'}),headers:{'content-type':'application/json'}});await nativeJSON('/api/wiki/rebuild',{method:'POST'});}
 function managedPath(file){for(const lib of store.list())if(inside(lib.path,path.resolve(file)))return {library:lib.id,relative:path.relative(lib.path,path.resolve(file)).split(path.sep).join('/')};throw failure('只允许写入内部知识库文档',403);}
 async function write(input){const result=await store.write(input);await register(result.library);return result;}
 async function mcp(message){
  if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string')throw failure('无效 MCP 请求');
  if(message.method==='tools/list'){const original=await nativeJSON('/mcp',{method:'POST',bytes:JSON.stringify(message),headers:{'content-type':'application/json'}});if(original.result)original.result.tools=[...original.result.tools,...tools];return original;}
  if(message.method==='tools/call'&&tools.some(tool=>tool.name===message.params?.name)){
   const input=message.params.arguments||{};try{
    let result;switch(message.params.name){case 'work_material_list':result=store.listWork(input.root,input.query);break;case 'work_material_read':{result=store.readWork(input.root,input.id);delete result.base64;break;}case 'library_list':result=store.list();break;case 'library_documents':result=store.db.prepare("SELECT id,relative,revision FROM documents WHERE library=? AND (lower(relative) LIKE '%.md' OR lower(relative) LIKE '%.markdown')").all(store.get(input.library).id).map(d=>store.describe({...d,library:store.get(input.library).id}));break;case 'library_read':result=store.read(input.document);break;case 'library_history':result=store.history(input.document);break;case 'library_write':if(!/\.(md|markdown)$/i.test(input.relative||store.doc(input.document)?.relative||''))throw failure('MCP 写入仅支持 Markdown 文档');result=await write({...input,origin:'mcp'});break;}
    return {jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:JSON.stringify(result)}]}};
   }catch(error){return {jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:error.message}]}};}
  }
  return nativeJSON('/mcp',{method:'POST',bytes:JSON.stringify(message),headers:{'content-type':'application/json'}});
 }
 const server=http.createServer(async(request,response)=>{
  activeRequests++;response.once('finish',()=>{activeRequests--;lastUsed=Date.now();});response.once('close',()=>{if(!response.writableFinished)activeRequests--;});
  try{
   const authorization=request.headers.authorization||'',expected='Bearer '+token;if(authorization.length!==expected.length||!timingSafeEqual(Buffer.from(authorization),Buffer.from(expected)))throw failure('Unauthorized',401);
   if(request.headers.origin)throw failure('Browser origins are not allowed on the knowledge control API',403);
   lastUsed=Date.now();const url=new URL(request.url,'http://localhost');
   if(url.pathname==='/internal/embed'){return json(response,await embed(JSON.parse((await body(request)).toString())));}
   if(url.pathname==='/internal/write'){const input=JSON.parse((await body(request)).toString());return json(response,await store.write({...managedPath(input.path),content:input.content,expected:input.expected,origin:'stele'}));}
   if(url.pathname==='/internal/shutdown'){json(response,{stopping:true});setImmediate(()=>void stop().then(()=>{if(standalone)process.exit(0);}));return;}
   if(url.pathname==='/api/health')return json(response,{instanceId,ready,embeddingReady,sourceHash:manifest.sourceHash,storageSchema:1,pid:process.pid,capabilities:['managed-libraries','directory-import','document-revisions','mcp','semantic-search']});
   if(!ready)throw failure('内置知识引擎正在启动',503);
   if(url.pathname==='/api/library/libraries'){if(request.method==='POST'){const input=JSON.parse((await body(request)).toString());return json(response,store.create(input.name,input.alias));}return json(response,store.list());}
   if(url.pathname==='/api/workspaces'&&request.method==='GET'){const names=new Map(store.list().map(lib=>[lib.alias,lib.name]));return json(response,(await nativeJSON('/api/workspaces')).map(space=>({...space,name:names.get(space.alias)||space.alias})));}
   if(url.pathname==='/api/work-material/list')return json(response,store.listWork(url.searchParams.get('root'),url.searchParams.get('query')||''));
   if(url.pathname==='/api/work-material/read')return json(response,store.readWork(url.searchParams.get('root'),url.searchParams.get('id')));
   if(url.pathname==='/api/work-material/capture'){const input=JSON.parse((await body(request)).toString());if(input.base64){input.bytes=Buffer.from(input.base64,'base64');delete input.base64;}return json(response,await store.captureWork(input));}
   if(url.pathname==='/api/library/batch'){
    const input=JSON.parse((await body(request)).toString());if(!Array.isArray(input.items)||input.items.length>128)throw failure('迁移批次无效');const items=[],libraries=new Set();
    for(const entry of input.items){try{const bytes=entry.base64?Buffer.from(entry.base64,'base64'):undefined;const existing=store.db.prepare('SELECT id,hash FROM documents WHERE library=? AND relative=?').get(entry.library,entry.relative);if(existing&&existing.hash===hash(bytes||Buffer.from(entry.content||''))){items.push({...store.describe(store.doc(existing.id)),status:'skipped'});libraries.add(entry.library);continue;}const saved=await store.write({...entry,bytes,origin:'legacy-migration'});items.push({...saved,status:'imported'});libraries.add(saved.library);}catch(error){items.push({relative:entry.relative,status:'failed',error:error.message});}}
    for(const library of libraries)await register(library);return json(response,{items});
   }
   if(url.pathname==='/api/library/scan'){const input=JSON.parse((await body(request)).toString());return json(response,await store.scan(input.path,input.library));}
   if(url.pathname==='/api/library/import'){const input=JSON.parse((await body(request)).toString()),result=await store.executeImport(input.id);await register(result.library);return json(response,result);}
   if(url.pathname==='/api/library/write')return json(response,await write({...JSON.parse((await body(request)).toString()),origin:'ui'}));
   if(url.pathname==='/api/library/read')return json(response,store.read(url.searchParams.get('document')));
   if(url.pathname==='/api/library/history')return json(response,store.history(url.searchParams.get('document')));
   if(url.pathname==='/api/artifact'&&request.method==='PUT'){const bytes=await body(request,2*1024*1024),result=await write({...managedPath(url.searchParams.get('path')),bytes,expected:request.headers['if-match']});response.setHeader('etag',result.etag);return json(response,result);}
   if(url.pathname==='/mcp')return json(response,await mcp(JSON.parse((await body(request)).toString())));
   if(url.pathname==='/api/workspaces'&&!['GET','PATCH'].includes(request.method))throw failure('请通过内部知识库管理来源；外部路径请使用文件夹导入',409);
   if(['/api/wiki/delete','/api/wiki/fix-dead-links','/api/sync','/api/recovery/restore'].includes(url.pathname)||url.pathname.startsWith('/api/sources/')&&request.method==='DELETE')throw failure('此操作尚未接入受管文档版本服务；原内容保持不变',409);
   const bytes=['GET','HEAD'].includes(request.method)?undefined:await body(request),headers={};for(const name of ['content-type','if-match'])if(request.headers[name])headers[name]=request.headers[name];
   const abort=new AbortController();response.on('close',()=>{if(!response.writableEnded)abort.abort();});
   const upstream=await native(url.pathname+url.search,{method:request.method,bytes,headers,signal:abort.signal});response.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([key])=>['content-type','etag','cache-control'].includes(key))));
   if(upstream.body){for await(const chunk of upstream.body){if(response.destroyed)break;if(!response.write(Buffer.from(chunk)))await new Promise(resolve=>response.once('drain',resolve));}}response.end();
  }catch(error){if(!response.headersSent)json(response,{error:error.message},error.status||500);else response.destroy();}
 });
 const stop=async()=>{if(closing)return;closing=true;ready=false;clearInterval(idleTimer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));child?.kill();await worker.terminate();store.close();try{const file=path.join(runtime,'connection.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.instanceId===instanceId)fs.unlinkSync(file);}catch{};};
 let idleTimer;
 try{
  await workerReady;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
  fs.mkdirSync(path.join(root,'empty'),{recursive:true});fs.mkdirSync(path.join(root,'engine-state'),{recursive:true});
  child=spawn(binary,['--bind','127.0.0.1','--port','0','--share-port','0','--dir',path.join(root,'empty'),'--sessions-dir','','--worktree-status-script',''],{cwd:root,windowsHide:true,env:{...process.env,STELE_DATA_DIR:path.join(root,'engine-state'),LUCYNA_ENGINE_CALLBACK:url,LUCYNA_ENGINE_TOKEN:token},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-12000);});
  await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('内置 Stele 启动超时')),30000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(Error('内置 Stele 退出（'+code+'）：'+stderr.slice(-2000)));});child.stdout.on('data',chunk=>{output+=chunk.toString();const match=/LUCYNA_ENGINE_READY (127\.0\.0\.1:\d+)/.exec(output);if(match){engineURL='http://'+match[1];clearTimeout(timer);resolve();}output=output.slice(-8192);});});
  for(const lib of store.list())await register(lib.id);
  ready=true;child.on('exit',()=>{ready=false;if(!closing)setImmediate(()=>void stop().then(()=>{if(standalone)process.exit(1);}));});
  const connection={version:1,instanceId,url,token,pid:process.pid,root,sourceHash:manifest.sourceHash};store.atomic(path.join(runtime,'connection.json'),Buffer.from(JSON.stringify(connection)));
  idleTimer=setInterval(()=>{if(!activeRequests&&Date.now()-lastUsed>idleMs)void stop().then(()=>{if(standalone)process.exit(0);});},10000);idleTimer.unref();
  return {...connection,stop,store,mcp,nativeJSON};
 }catch(error){await stop();throw error;}
}
function main(){
 standalone=true;
 const run=async()=>{const directory=process.env.LUCYNA_KNOWLEDGE_HOME;if(!directory)throw Error('Missing knowledge profile');const instance=await startKnowledgeHost({directory});process.stdout.write('LUCYNA_KNOWLEDGE_READY\n');process.on('SIGTERM',()=>void instance.stop().then(()=>process.exit()));};
 if(process.versions.electron&&!process.env.ELECTRON_RUN_AS_NODE){const {app}=require('electron');const profile=path.join(process.env.LUCYNA_KNOWLEDGE_HOME,'runtime/electron');app.setPath('userData',profile);if(!app.requestSingleInstanceLock())app.exit();else app.whenReady().then(run).catch(error=>{process.stderr.write(error.stack+'\n');app.exit(1);});}
 else run().catch(error=>{process.stderr.write(error.stack+'\n');process.exit(1);});
}
module.exports={startKnowledgeHost,tools,main};
if(require.main===module)main();
