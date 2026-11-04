'use strict';
const commands=new Set(['get_subagents','set_subagent_subscription','get_subagent_messages','cancel_subagent','get_background_tasks','get_background_task_output','cancel_background_task','get_background_task_history']);
function validateTaskRequest(type,data={}){
  if(!commands.has(type))return false;
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid task request');
  const id=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\0\r\n]/.test(value);
  if(type==='set_subagent_subscription'&&!['off','progress','events'].includes(data.level))throw Error('Invalid subscription');
  if(['get_subagent_messages','cancel_subagent'].includes(type)&&(!id(data.subagentId)||data.sessionFile!==undefined))throw Error('A session-owned subagent ID is required');
  if(data.fromByte!==undefined&&(!Number.isSafeInteger(data.fromByte)||data.fromByte<0))throw Error('Invalid transcript cursor');
  if(['get_background_task_output','cancel_background_task'].includes(type)&&(!id(data.taskId)||!['job','daemon'].includes(data.kind)||!Number.isFinite(data.startedAt)))throw Error('A task instance is required');
  if(type==='get_background_task_history'&&(!Array.isArray(data.taskIds)||!data.taskIds.length||data.taskIds.length>80||!data.taskIds.every(id)))throw Error('Invalid background task history request');
  // Do not allow caller-supplied native frame IDs or arbitrary filesystem paths.
  for(const key of ['expectedSessionFile','expectedParentToolCallId'])if(data[key]!==undefined&&!id(data[key]))throw Error('Invalid expected task identity');
  const allowed={set_subagent_subscription:['level'],get_subagent_messages:['subagentId','fromByte','expectedSessionFile'],cancel_subagent:['subagentId','expectedSessionFile','expectedParentToolCallId'],get_background_task_output:['taskId','kind','startedAt'],cancel_background_task:['taskId','kind','startedAt'],get_background_task_history:['taskIds']}[type]||[];
  if(Object.keys(data).some(key=>!allowed.includes(key)))throw Error('Unsupported task request field');
  return true;
}

// get_messages is the compacted context. get_entries includes the old results
// and sibling branches. Return only requested job evidence from the active path.
function selectTaskHistory({entries,leafId},taskIds){
  if(!Array.isArray(entries)||!leafId)return {messages:[]};
  const byId=new Map(entries.filter(entry=>entry?.type!=='session'&&entry?.id).map(entry=>[entry.id,entry]));
  const pending=new Set(taskIds),messages=[];
  while(leafId&&pending.size){
    const entry=byId.get(leafId);
    if(!entry)return {messages:[]};
    byId.delete(leafId);
    leafId=entry.parentId;
    const message=entry.type==='message'?entry.message:entry.type==='custom_message'?entry:null;
    const details=message?.details;
    const asyncResult=message?.customType==='async-result';
    const report=message?.role==='toolResult'&&!message.isError&&['wait','cancel'].includes(message.toolName)&&details?.op===message.toolName;
    if((asyncResult||report)&&Array.isArray(details?.jobs)){
      const jobs=[];
      for(const job of details.jobs){
        const id=asyncResult?job?.jobId:job?.id;
        if(!pending.delete(id))continue;
        const {label,intent,type,status,durationMs,exitCode}=job;
        const output=job.resultText??job.errorText;
        jobs.push({[asyncResult?'jobId':'id']:id,label,intent,type,status,durationMs,exitCode,
          resultText:typeof output==='string'?output.slice(-4096):undefined});
      }
      if(jobs.length)messages.push({role:message.role,customType:message.customType,toolName:message.toolName,
        timestamp:message.timestamp??entry.timestamp,details:{op:details.op,jobs}});
    }
    if(message?.role==='toolResult'&&details?.async?.state==='running')pending.delete(details.async.jobId);
  }
  return {messages:messages.reverse()};
}
module.exports={validateTaskRequest,selectTaskHistory};
