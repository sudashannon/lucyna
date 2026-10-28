// Shared by the transcript and desktop companion. Native OMP owns settlement.
function settledOutcome(run,event) {
  if(!run)return null;
  if(event.type==='prompt_result'&&event.sessionSettled!==false)return ['completed','aborted','error'].includes(event.status)?event.status:'completed';
  if(event.type==='session_settled'&&run.active)return run.outcome||'completed';
  if(['process_exit','process_error'].includes(event.type)&&run.active)return 'error';
  return null;
}
module.exports={settledOutcome};
