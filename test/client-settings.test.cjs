const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {defaults,validateSettings,SettingsStore,wslArgs,toWslPath,historyLocations,sessionDirectory,windowsSessionPath,wslSessionPath}=require('../src/client-settings.cjs');
test('settings survive relaunch with rollback copy and reject malformed edits without changing disk',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omp-settings-'));
 try {const store=new SettingsStore(dir);assert.equal((await store.get()).runtime,'windows');const first={...defaults(),runtime:'wsl',model:'example/test-model',thinking:'low'};await store.save(first);await store.save({...first,thinking:'inherit'});
 assert.equal((await new SettingsStore(dir).get()).thinking,'inherit');const backup=(await fs.readdir(dir)).find(x=>x.endsWith('.bak'));assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,backup),'utf8')),first);
 const before=await fs.readFile(store.file,'utf8');await assert.rejects(store.save({...first,wslAgentDir:'relative'}));assert.equal(await fs.readFile(store.file,'utf8'),before);
 await fs.writeFile(store.file,'{broken');await assert.rejects(new SettingsStore(dir).get(),/原文件已保留/);assert.equal(await fs.readFile(store.file,'utf8'),'{broken');
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('runtime paths are literal arguments and Windows journal paths roundtrip through WSL',()=>{
 const s={...defaults(),runtime:'wsl',wslExecutable:'/home/user/my omp/bin/omp',wslAgentDir:'/home/user/profile name'};validateSettings(s);
 const args=wslArgs(s,['--mode','rpc-ui']);assert.ok(args.includes(s.wslExecutable));assert.equal(args[args.indexOf('--agent-dir')+1],s.wslAgentDir);assert.equal(args.includes('bash'),false);assert.ok(args.some(arg=>arg.endsWith('/tools/launch_wsl.py')));assert.equal(args[args.indexOf('--cd')+1],'/home/user');
 const file='C:\\Users\\test user\\客户端\\history.jsonl';assert.equal(windowsSessionPath(toWslPath(file)),file);assert.throws(()=>validateSettings({...s,wslExecutable:'/home/x/../omp'}));assert.throws(()=>validateSettings({...s,model:'not a model'}));assert.throws(()=>validateSettings({...s,thinking:'superfast'}));
});
test('separate runtime stores and root buckets cannot accidentally share a writer',()=>{
 const root='C:\\profile';const win=historyLocations(root,'windows'),wsl=historyLocations(root,'wsl');assert.notEqual(win.agentDir,wsl.agentDir);assert.notEqual(win.historyDir,wsl.historyDir);assert.notEqual(sessionDirectory(wsl.agentDir,'/a'),sessionDirectory(wsl.agentDir,'/b'));assert.ok(sessionDirectory(wsl.agentDir,'/a').startsWith(path.join(wsl.agentDir,'sessions')+path.sep));
});
test('native work-derived Linux journals and old Windows copies roundtrip without changing their store',()=>{
 const native='/home/user/.omp/agent/sessions/-develop-example/Session.jsonl';
 assert.equal(wslSessionPath(windowsSessionPath(native)),native);
 assert.equal(wslSessionPath(native),native);
 assert.equal(wslSessionPath('\\\\wsl$\\Ubuntu-22.04\\home\\user\\example.jsonl'),'/home/user/example.jsonl');
 assert.equal(wslSessionPath('C:\\client\\sessions\\old.jsonl'),'/mnt/c/client/sessions/old.jsonl');
 assert.throws(()=>wslSessionPath('\\\\wsl.localhost\\Other\\home\\file.jsonl'));
 assert.throws(()=>wslSessionPath('\\\\wsl.localhost\\Ubuntu-22.04\\home\\..\\file.jsonl'));
});
