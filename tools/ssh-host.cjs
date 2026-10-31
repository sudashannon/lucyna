// Development entry point for the same deploy API the desktop will consume.
const fs=require('node:fs/promises');
const {buildBundle}=require('./build-host-bundle.cjs');
const {deploy}=require('../src/hosts/ssh-bootstrap.cjs');
const {deployFrozen}=require('../src/hosts/ssh-frozen.cjs');
const path=require('node:path');
async function main(){
  const file=process.argv[2];if(!file)throw Error('用法：node tools/ssh-host.cjs <主机配置.json> [--bundle=index.json | --source] [--connection] [--prefix=/绝对/隔离路径]');
  const options=process.argv.slice(3);
  if(options.some(x=>!['--connection','--source'].includes(x)&&!x.startsWith('--prefix=')&&!x.startsWith('--bundle=')))throw Error('未知参数');
  if(options.includes('--source')&&options.some(x=>x.startsWith('--bundle=')))throw Error('不能同时选择源码与 frozen 制品');
  const config=JSON.parse(await fs.readFile(file,'utf8'));
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort(Error('已取消')));
  const settings={signal:controller.signal,mode:options.includes('--connection')?'connection':'user-service',prefix:options.find(x=>x.startsWith('--prefix='))?.slice(9),onProgress:p=>process.stderr.write(JSON.stringify(p)+'\n')};
  const value=options.includes('--source')?await deploy(config,await buildBundle(),settings):await deployFrozen(config,
    options.find(x=>x.startsWith('--bundle='))?.slice(9)||path.join(__dirname,'../resources/remote-host/index.json'),settings);
  process.stdout.write(JSON.stringify(value,null,2)+'\n');
}
if(require.main===module)main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
