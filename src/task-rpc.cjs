'use strict';
const commands=new Set(['get_subagents','set_subagent_subscription','get_subagent_messages','cancel_subagent','get_background_tasks','get_background_task_output','cancel_background_task']);
function validateTaskRequest(type,data={}){
  if(!commands.has(type))return false;
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid task request');
  const id=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\0\r\n]/.test(value);
  if(type==='set_subagent_subscription'&&!['off','progress','events'].includes(data.level))throw Error('Invalid subscription');
  if(['get_subagent_messages','cancel_subagent'].includes(type)&&(!id(data.subagentId)||data.sessionFile!==undefined))throw Error('A session-owned subagent ID is required');
  if(data.fromByte!==undefined&&(!Number.isSafeInteger(data.fromByte)||data.fromByte<0))throw Error('Invalid transcript cursor');
  if(['get_background_task_output','cancel_background_task'].includes(type)&&(!id(data.taskId)||!['job','daemon'].includes(data.kind)||!Number.isFinite(data.startedAt)))throw Error('A task instance is required');
  // Do not allow caller-supplied native frame IDs or arbitrary filesystem paths.
  for(const key of ['expectedSessionFile','expectedParentToolCallId'])if(data[key]!==undefined&&!id(data[key]))throw Error('Invalid expected task identity');
  const allowed={set_subagent_subscription:['level'],get_subagent_messages:['subagentId','fromByte','expectedSessionFile'],cancel_subagent:['subagentId','expectedSessionFile','expectedParentToolCallId'],get_background_task_output:['taskId','kind','startedAt'],cancel_background_task:['taskId','kind','startedAt']}[type]||[];
  if(Object.keys(data).some(key=>!allowed.includes(key)))throw Error('Unsupported task request field');
  return true;
}
module.exports={validateTaskRequest};
