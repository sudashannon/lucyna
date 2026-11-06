// Native abort stops the foreground turn. Subagents and background jobs have
// separate, session-owned cancellation RPCs; never replay a failed mutation.
const stopping = new WeakMap();
const unsupported = error => /unknown command|unsupported command|not supported/i.test(error?.message||String(error));
function stopSession(session, type, data) {
  if (stopping.has(session)) return stopping.get(session);
  const task = (async () => {
    const abort = session.request(type, data);
    const seenChildren = new Set();
    const seenBackground = new Set();
    let backgroundUnsupported=false;
    const cancelChildren = async () => {
      const snapshot = await session.request('get_subagents');
      const ids = [...new Set((snapshot?.subagents || [])
        .filter(s => ['running', 'pending'].includes(s.status) && typeof s.id === 'string' && s.id && !seenChildren.has(s.id))
        .map(s => s.id))];
      const results = await Promise.allSettled(ids.map(subagentId => {seenChildren.add(subagentId);return session.request('cancel_subagent', {subagentId});}));
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
    };
    const cancelBackgroundTasks = async () => {
      if(backgroundUnsupported)return;
      let snapshot;
      try{snapshot=await session.request('get_background_tasks');}
      catch(error){if(unsupported(error)){backgroundUnsupported=true;return;}throw error;}
      const tasks = [...new Map((snapshot?.tasks || [])
        .filter(task => ['job', 'daemon'].includes(task.kind)
          && ['running', 'pending', 'ready', 'starting', 'restarting'].includes(task.status)
          && typeof task.id === 'string' && task.id
          && Number.isFinite(task.startedAt)
          && task.cancellable !== false
          && !seenBackground.has(`${task.kind}\0${task.id}\0${task.startedAt}`))
        .map(task => [`${task.kind}\0${task.id}\0${task.startedAt}`, task])).values()];
      const results = await Promise.allSettled(tasks.map(task => {
        const key = `${task.kind}\0${task.id}\0${task.startedAt}`;
        seenBackground.add(key);
        return session.request('cancel_background_task', {taskId:task.id,kind:task.kind,startedAt:task.startedAt});
      }));
      const failed = results.find(r => r.status === 'rejected'&&!/Task has ended, changed instance, or is outside this session/i.test(r.reason?.message||String(r.reason)));
      if (failed) throw failed.reason;
    };
    const cancellations = Promise.allSettled([cancelChildren(), cancelBackgroundTasks()]);
    const [result, cancelled] = await Promise.allSettled([abort, cancellations]);
    if (result.status === 'rejected') throw result.reason;
    const stopErrors=[];
    if(cancelled.status==='rejected')stopErrors.push(cancelled.reason?.message||String(cancelled.reason));
    else for(const result of cancelled.value)if(result.status==='rejected')stopErrors.push(result.reason?.message||String(result.reason));
    // Foreground tools may admit a child or background task while abort is in
    // flight. Sweep once more after abort; instance keys prevent replaying a
    // cancellation even when native confirmation was lost.
    if(!stopErrors.length){
      const final=await Promise.allSettled([cancelChildren(),cancelBackgroundTasks()]);
      for(const result of final)if(result.status==='rejected')stopErrors.push(result.reason?.message||String(result.reason));
    }
    // Preserve the native queue even when a child or background task refuses cancellation.
    const stopError=[...new Set(stopErrors)].join('; ');
    return {...result.value, ...(stopError ? {stopError} : {})};
  })();
  stopping.set(session, task);
  task.finally(() => {if (stopping.get(session) === task) stopping.delete(session);}).catch(() => {});
  return task;
}
module.exports = {stopSession};
