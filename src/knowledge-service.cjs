const {createKnowledgeReader}=require('./knowledge.cjs');
const {createHash}=require('node:crypto');

// The renderer names operations; it cannot choose hosts, methods or filesystem paths.
function createKnowledgeService(fetchImpl=fetch,{origin='http://127.0.0.1:18989'}={}) {
  const legacy=createKnowledgeReader(fetchImpl,{origin}),running=new Map(),capturedIdentities=new Map();
  const text=(value,name,max=4096,optional=false)=>{
    if(optional&&(value===undefined||value===''))return '';
    if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`无效的${name}`);
    return value;
  };
  const id=value=>encodeURIComponent(text(value,'标识'));
  const fields=(args,keys)=>Object.fromEntries(keys.filter(k=>args[k]!==undefined).map(k=>[k,args[k]]));
  const file=value=>{
    if(!value||typeof value.name!=='string'||value.name.length>255)throw Error('无效的文件');
    const bytes=value.bytes instanceof ArrayBuffer?new Uint8Array(value.bytes):value.bytes;
    if(!(bytes instanceof Uint8Array)||bytes.length>32*1024*1024)throw Error('文件超过 32 MiB 或内容无效');
    return new File([bytes],value.name.replace(/^.*[\\/]/,''),{type:typeof value.type==='string'?value.type:'application/octet-stream'});
  };
  async function call(route,{method='GET',params,body,form,raw,headers={},snapshot=false,binary=false,timeout=20000,requestId,progress}={}) {
    const url=new URL(route,origin);
    for(const [key,value] of Object.entries(params||{}))if(value!==undefined&&value!=='')url.searchParams.set(key,String(value));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    if(requestId)running.set(requestId,controller);
    try {
      const response=await fetchImpl(url,{method,redirect:'error',signal:controller.signal,
        headers:{...(body?{'content-type':'application/json'}:{}),...headers},body:form||raw||(body?JSON.stringify(body):undefined)});
      if(!response.ok){const detail=(await response.text()).slice(0,1200);let message=detail;try{const parsed=JSON.parse(detail);message=parsed.error||parsed.message||detail;}catch{}throw Error([409,412].includes(response.status)?`内容在操作期间发生变化，请刷新后重新核对。${message}`:`Stele 请求失败（${response.status}）：${message}`);}
      if(response.status===204)return null;
      if(progress)return await readChat(response,progress);
      const reader=response.body.getReader(),chunks=[],limit=snapshot?2*1024*1024:binary?64*1024*1024:16*1024*1024;let length=0;
      for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();throw Error(`Stele 返回内容超过 ${limit/1024/1024} MiB`);}chunks.push(Buffer.from(value));}
      const bytes=Buffer.concat(chunks);
      if(snapshot)return {content:bytes.toString('utf8'),etag:response.headers.get('etag'),version:'doc-v1:'+createHash('sha256').update(bytes).digest('hex')};
      return binary?{bytes:new Uint8Array(bytes),mime:response.headers.get('content-type')}:bytes.length?JSON.parse(bytes.toString('utf8')):null;
    } catch(error) {
      if(controller.signal.aborted)throw Error('请求已取消或超时；请刷新确认服务中的实际结果。');
      if(error.message==='fetch failed')throw Error('无法连接 Stele，请检查 WSL 服务（18989）');
      throw error;
    } finally {clearTimeout(timer);if(requestId)running.delete(requestId);}
  }
  async function readChat(response,onProgress){
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',answer='',thinking='',references=[],done=false,total=0;
    const receive=line=>{if(!line.startsWith('data:'))return;const event=JSON.parse(line.slice(5).trim());if(event.type==='error')throw Error(event.error||event.content||'问答处理失败');if(event.type==='delta')answer+=event.content||'';if(event.type==='thinking')thinking+=event.content||'';if(event.references)references=event.references;if(event.type==='done')done=true;onProgress(event);};
    try {for(;;){const result=await reader.read();if(result.done)break;total+=result.value.length;if(total>8*1024*1024)throw Error('问答内容超过大小限制');buffer+=decoder.decode(result.value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop()||'';for(const line of lines)receive(line.trimEnd());}buffer+=decoder.decode();if(buffer.trim())receive(buffer.trimEnd());if(!done)throw Error('问答连接提前结束，回复未完成');return {answer,thinking,references};}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  return async function knowledge(kind,args={},onProgress=()=>{}) {
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('无效的知识库请求');
    if(['catalog','document','image','candidates','reviews'].includes(kind))return legacy(kind,args);
    const workspace=()=>text(args.workspace,'知识来源');
    const revision=()=>text(args.revision,'内容版本',1024);
    const scoped=()=>({workspace:workspace()});
    switch(kind){
      case 'graph':return call('/api/wiki/graph');
      case 'search':return call('/api/wiki/search-semantic',{method:'POST',timeout:120000,body:{query:text(args.query,'查询',2000),topK:50}});
      case 'evidence':return call('/api/wiki/evidence',{method:'POST',body:{id:text(args.id,'文档'),workspace:workspace(),query:text(args.query,'查询',1000,true)}});
      case 'snapshot':case 'artifactWrite':{
        const catalog=await legacy('catalog'),doc=catalog.documents.find(d=>d.id===args.id);
        if(!doc||doc.type==='session')throw Error('请选择已索引的文档');
        const params={path:doc.path,workspace:doc.workspace};
        if(kind==='snapshot'){const snapshot=await call('/api/artifact',{params,snapshot:true});return {...snapshot,id:doc.id,workspace:doc.workspace};}
        const etag=text(args.etag,'来源版本',256);if(!/^"[a-zA-Z0-9:_-]+"$/.test(etag))throw Error('无效的来源版本');
        return call('/api/artifact',{method:'PUT',params,raw:text(args.content,'文档内容',2*1024*1024),headers:{'content-type':'text/markdown; charset=utf-8','if-match':etag}});
      }
      case 'summary':return call('/api/wiki/summarize',{params:{id:text(args.id,'文档')},timeout:600000});
      case 'overview':if(!Number.isInteger(args.community))throw Error('无效社区');return call('/api/wiki/overview',{params:{community:args.community},timeout:600000});
      case 'artifactVersion': {const catalog=await legacy('catalog');const doc=catalog.documents.find(d=>d.id===args.id);if(!doc)throw Error('文档未被索引');const result=await fetchImpl(new URL('/api/artifact?'+new URLSearchParams({path:doc.path,workspace:doc.workspace}),origin),{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(15000)});if(!result.ok)throw Error(`来源校验失败（${result.status}）`);return {etag:result.headers.get('etag')};}
      case 'candidateCreate':return call('/api/wiki/candidates',{method:'POST',body:{workspace:workspace(),componentId:text(args.componentId,'文档'),title:text(args.title,'标题',500),text:text(args.text,'候选内容',256000),references:args.references||[]}});
      case 'candidateAction':if(!['edit','adopt','reject'].includes(args.action))throw Error('无效的候选操作');return call('/api/wiki/candidates/'+id(args.id),{method:'POST',timeout:120000,body:{...fields(args,['action','title','text','reason']),revision:revision()}});
      case 'reviewAction':if(!['reverify','retract','dismiss','todo'].includes(args.action))throw Error('无效的复核操作');return call('/api/wiki/reviews/'+id(args.id),{method:'POST',body:{...fields(args,['action','reason','title']),workspace:workspace(),revision:revision()}});
      case 'sessions':return call('/api/wiki/sessions');
      case 'session':return call('/api/wiki/session',{params:{id:text(args.id,'会话')}});
      case 'calendarMonth':return call('/api/wiki/calendar/month',{params:{year:args.year,month:args.month}});
      case 'calendarDay':if(!/^\d{4}-\d{2}-\d{2}$/.test(args.date||''))throw Error('无效日期');return call('/api/wiki/calendar/day',{params:{date:args.date}});
      case 'sources':return call('/api/sources',{params:scoped()});
      case 'source':{
        const scope=workspace(),result=await call('/api/sources/'+id(args.id),{params:{workspace:scope}});
        // Saved-source metadata contains a relative storage path. Resolve identity
        // through the authoritative index instead of guessing workspace layouts.
        const catalog=await legacy('catalog',{refresh:true});
        const matches=catalog.documents.filter(doc=>doc.workspace===scope&&(doc.path===result.source.path||doc.path.endsWith('/'+result.source.path)));
        const captured=capturedIdentities.get(scope+'\0'+args.id);
        if(matches.length!==1&&!captured)throw Error('来源尚未完成索引，请稍后刷新重试。');
        result.source.path=captured||matches[0].path;result.source.componentId=captured||matches[0].id;
        result.text=result.text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'').trim();
        return result;
      }
      case 'sourceDelete':return call('/api/sources/'+id(args.id),{method:'DELETE',params:scoped()});
      case 'sourceCapture':{const form=new FormData(),scope=workspace();form.set('workspace',scope);if(args.title)form.set('title',text(args.title,'标题',500));if(args.file)form.set('file',file(args.file));else if(args.url)form.set('url',text(args.url,'网页地址',4096));else form.set('text',text(args.text,'资料内容',2*1024*1024));const result=await call('/api/sources/capture',{method:'POST',form,timeout:120000});const identity=result.candidates?.[0]?.componentId;if(identity){if(capturedIdentities.size>=1000)capturedIdentities.delete(capturedIdentities.keys().next().value);capturedIdentities.set(scope+'\0'+result.id,identity);}return result;}
      case 'todos':return call('/api/todos',{params:fields(args,['workspace','status','q'])});
      case 'todoCreate':return call('/api/todos',{method:'POST',body:{...fields(args,['notes','status','priority','dueAt','wikiRefs']),workspace:workspace(),title:text(args.title,'待办标题',1000)}});
      case 'todoUpdate':return call('/api/todos/'+id(args.id),{method:'PATCH',body:fields(args,['title','notes','status','priority','dueAt','wikiRefs'])});
      case 'todoDelete':return call('/api/todos/'+id(args.id),{method:'DELETE'});
      case 'reports':return call('/api/reports');
      case 'report':return call('/api/reports/get',{params:{name:text(args.name,'报告名')}});
      case 'reportGenerate':if(!['weekly','monthly'].includes(args.type))throw Error('无效的报告类型');return call('/api/report',{method:'POST',body:fields(args,['type','start','end','workspace']),timeout:600000});
      case 'activity':return call('/api/activity');
      case 'activityCancel':return call('/api/activity',{method:'POST',params:{cancel:text(args.id,'活动')}});
      case 'config':return call('/api/chat/config');
      case 'configUpdate':return call('/api/chat/config',{method:'PUT',body:fields(args,['active_provider','task_models','task_providers','context_chars'])});
      case 'workspaceUpdate':return call('/api/workspaces',{method:'PATCH',params:{alias:workspace()},body:fields(args,['purpose','modelProvider'])});
      case 'workspaceAdd':return call('/api/workspaces',{method:'POST',body:{alias:text(args.alias,'来源名称',128),path:text(args.path,'WSL 目录'),...(args.type?{type:args.type}:{})}});
      case 'rebuild':return call('/api/wiki/rebuild',{method:'POST',timeout:180000});
      case 'recoveryExport':return call('/api/recovery/export',{binary:true,timeout:60000});
      case 'recoveryPreview':case 'recoveryRestore':{const form=new FormData();form.set('archive',file(args.file));if(kind==='recoveryRestore'){if(!['skip','replace'].includes(args.conflictPolicy))throw Error('无效的恢复策略');form.set('conflictPolicy',args.conflictPolicy);}return call(kind==='recoveryPreview'?'/api/recovery/preview':'/api/recovery/restore',{method:'POST',form,timeout:120000});}
      case 'chatSession':return call('/api/chat/session',{params:{workspace:workspace(),componentId:text(args.componentId,'文档'),change:text(args.change,'对话标识')}});
      case 'chat':return call('/api/chat/message',{method:'POST',body:{workspace:workspace(),componentId:text(args.componentId,'文档'),change:text(args.change,'对话标识'),message:text(args.message,'问题',32000),context_files:[],evidenceOnly:args.evidenceOnly===true,includeGraph:false},timeout:600000,requestId:text(args.requestId,'请求标识',128),progress:onProgress});
      case 'chatCancel':running.get(text(args.requestId,'请求标识',128))?.abort();return null;
      default:throw Error('不支持的知识库操作');
    }
  };
}
module.exports={createKnowledgeService};
