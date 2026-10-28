// Optional private migration hook; never distributed with provider credentials.
const path=require('node:path'),fs=require('node:fs');
async function prepare(agentDir){
 if(require('./runtime-config.cjs').windowsProviderHook){
  const hook=path.resolve(__dirname,'../tools/model-wsl-auth.cjs');
  if(!fs.existsSync(hook))throw Error('Private Windows provider hook is unavailable. Disable windowsProviderHook or configure your native Windows OMP profile.');
  return require(hook).prepare(agentDir);
 }
 return{status:{model:undefined},env:{},release(){}};
}
module.exports={prepare};
