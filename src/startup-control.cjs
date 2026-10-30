// Cancellation must settle even when a WSL launcher never closes its pipes.
function waitForStartup(promise,signal){
  if(!signal)return Promise.resolve(promise);
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
module.exports={waitForStartup};
