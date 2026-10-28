const test=require('node:test'),assert=require('node:assert/strict');
const {validateRuntime}=require('../src/runtime-config.cjs');
test('machine settings accept a different WSL installation without embedding credentials',()=>{
 const value=validateRuntime({distro:'Debian',user:'alice',home:'/home/alice',workRoot:'/srv/works',wslAgentDir:'/srv/omp-profile',wslExecutable:'/opt/omp/bin/omp'});
 assert.equal(value.workRoot,'/srv/works');assert.equal(value.wslAgentDir,'/srv/omp-profile');assert.equal(value.windowsProviderHook,false);assert.equal(value.defaultRuntime,'wsl');
 for(const patch of [{user:'user;command'},{distro:'../bad'},{workRoot:'/home/a/../private'},{wslAgentDir:'relative'}])assert.throws(()=>validateRuntime(patch));
});
