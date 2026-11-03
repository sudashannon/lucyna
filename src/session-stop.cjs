// Native abort stops the foreground turn. Detached subagents have their own
// cancellation RPC; query only this harness and never replay a failed mutation.
const stopping = new WeakMap();
function stopSession(session, type, data) {
  if (stopping.has(session)) return stopping.get(session);
  const task = (async () => {
    const abort = session.request(type, data);
    const seen = new Set();
    const cancelChildren = async () => {
      const snapshot = await session.request('get_subagents');
      const ids = [...new Set((snapshot?.subagents || [])
        .filter(s => ['running', 'pending'].includes(s.status) && typeof s.id === 'string' && s.id && !seen.has(s.id))
        .map(s => s.id))];
      const results = await Promise.allSettled(ids.map(subagentId => {seen.add(subagentId);return session.request('cancel_subagent', {subagentId});}));
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
    };
    const children = cancelChildren();
    const [result, cancelled] = await Promise.allSettled([abort, children]);
    if (result.status === 'rejected') throw result.reason;
    let stopError=cancelled.status==='rejected'?cancelled.reason?.message||String(cancelled.reason):'';
    // Foreground tools may have admitted a child while the first snapshot was
    // being read. Sweep once after abort; never resend a child's cancellation.
    if(!stopError){try{await cancelChildren();}catch(error){stopError=error.message||String(error);}}
    // Preserve the native queue even when a child refuses cancellation.
    return {...result.value, ...(stopError ? {stopError} : {})};
  })();
  stopping.set(session, task);
  task.finally(() => {if (stopping.get(session) === task) stopping.delete(session);}).catch(() => {});
  return task;
}
module.exports = {stopSession};
