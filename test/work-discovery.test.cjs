const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function backend(){
 let calls=0,fail=false;const module={exports:{}};
 const execute=(_file,_args,_options,callback)=>{calls++;setImmediate(()=>callback(fail?Error('probe unavailable'):null,JSON.stringify([{name:'work-'+calls,root:'/home/user/develop/work-'+calls}]),''));return {kill(){}};};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../src/backend.cjs'),'utf8'),{
  module,process,Buffer,setTimeout,clearTimeout,__dirname:path.resolve(__dirname,'../src'),
  require:name=>name==='./bounded-exec.cjs'?{boundedExec:(file,args,options)=>require('../src/bounded-exec.cjs').boundedExec(file,args,{...options,execute})}:require(name.startsWith('./')?path.resolve(__dirname,'../src',name):name)
 });
 return{list:module.exports.listWorks,calls:()=>calls,fail:value=>fail=value};
}
test('explicit work refresh discovers changes immediately while ordinary validation reuses cached data',async()=>{const b=backend();assert.equal((await b.list())[0].name,'work-1');assert.equal((await b.list())[0].name,'work-1');assert.equal(b.calls(),1);assert.equal((await b.list({refresh:true}))[0].name,'work-2');assert.equal((await b.list())[0].name,'work-2');});
test('failed work refresh is actionable, preserves prior validation cache and can be retried',async()=>{const b=backend();await b.list();b.fail(true);await assert.rejects(b.list({refresh:true}),/检查 runtime.local.json 和 WSL.*\nprobe unavailable/);assert.equal((await b.list())[0].name,'work-1');b.fail(false);assert.equal((await b.list({refresh:true}))[0].name,'work-3');});
