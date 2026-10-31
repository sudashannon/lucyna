const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function buildBundle(){
  const files={};
  for(const name of ['host.py','install.py','host_runtime.py','artifacts.py','sessions.py','protocol.py']){
    const bytes=Buffer.from((await fs.readFile(path.join(__dirname,name==='protocol.py'?'work-runner':'lucyna-host',name),'utf8')).replaceAll('\r\n','\n'));
    files[name]={sha256:digest(bytes),data:bytes.toString('base64')};
  }
  const release=digest(Object.keys(files).sort().map(name=>name+'\0'+files[name].sha256+'\n').join(''));
  return {version:1,release,files};
}
if(require.main===module)buildBundle().then(async bundle=>{
  const destination=path.resolve(process.argv[2]||'.runtime/remote-host/bundle.json');
  await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,JSON.stringify(bundle)+'\n');
  process.stdout.write(JSON.stringify({destination,release:bundle.release})+'\n');
}).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
module.exports={buildBundle,digest};
