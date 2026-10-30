const test=require('node:test'),assert=require('node:assert/strict');
const {WorkRunner}=require('../src/work-runner.cjs');
const make=connections=>new WorkRunner({listWorks:async()=>[{root:'/works/a',kind:'gitless'}],connections:()=>connections||[]});
test('native execution policy blocks global memory, MCP, shell and goal budget replacement',async()=>{
 const {guard}=await import('../tools/work-runner/policy.mjs');
 for(const toolName of ['learn','manage_skill','bash','write','mcp__stele_wiki_claim_upsert'])assert.equal(guard({toolName,input:{}}).block,true);
 for(const op of ['create','drop','resume'])assert.equal(guard({toolName:'goal',input:{op}}).block,true);
 assert.equal(guard({toolName:'goal',input:{op:'complete'}}),undefined);assert.equal(guard({toolName:'read_work_file'}),undefined);
});
test('policy restores registered Work tools lost from an OMP resumed active set',async()=>{
 const {default:policy}=await import('../tools/work-runner/policy.mjs');const handlers={};let active=['goal','mcp__late'];
 policy({on:(name,fn)=>handlers[name]=fn,registerCommand:()=>{},getAllTools:()=>['goal','read_work_file','write_work_file','mcp__late'].map(name=>({name})),setActiveTools:names=>{active=names;}});
 await handlers.before_agent_start();assert.deepEqual(active,['goal','read_work_file','write_work_file']);
});
test('runner admits only known Work and narrow operations before spawning',async()=>{
 const runner=make();await assert.rejects(runner.call('shell',{}),/无效/);await assert.rejects(runner.call('create',{root:'/else'}),/有效/);
 await assert.rejects(runner.call('create',{root:'/works/a',env:{TOKEN:'never-send'}}),/参数/);
 await assert.rejects(runner.call('resume',{runId:'a',executable:'/evil'}),/参数/);
});
test('background and interactive Work admission are mutually exclusive, including in-flight startup',async()=>{
 const runner=make([{root:'/works/a',id:'native'}]);runner.ensure=async()=>{throw Error('must not start');};
 await assert.rejects(runner.call('create',{root:'/works/a'}),/普通会话/);
 runner.inspect=async()=>[{root:'/works/a',state:'interrupted'}];await assert.rejects(runner.interactive('/works/a',async()=>{}),/未结束/);
 runner.inspect=async()=>[];let release;const started=runner.interactive('/works/a',()=>new Promise(r=>release=r));
 await new Promise(r=>setImmediate(r));await assert.rejects(runner.admit('/works/a',async()=>{}),/启动操作/);release();await started;
 assert.equal(await runner.admit('/works/a',async()=>42),42);
});
test('offline inspection neither installs nor starts service, completed work permits interaction',async()=>{
 const runner=make();runner.ensure=()=>{throw Error('unexpected install');};runner.inspect=async()=>[{id:'one',root:'/works/a',state:'completed'},{id:'two',root:'/other',state:'running'}];
 assert.deepEqual((await runner.call('list',{root:'/works/a'})).map(r=>r.id),['one']);
 assert.equal(await runner.interactive('/works/a',async()=>true),true);
});

test('cancelled foreground inspection terminates its launcher without waiting for close',async()=>{
 const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');let child,killed=false;
 const runner=new WorkRunner({execute:()=>{child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{killed=true;};return child;}});
 const controller=new AbortController(),pending=runner.interactive('/works/a',()=>{throw Error('must not launch');},controller.signal);
 const rejected=assert.rejects(pending,/cancel test/);controller.abort(Error('cancel test'));await rejected;
 assert.ok(killed);assert.ok(child.stdout.destroyed);assert.equal(runner.admissions.size,0);
});

test('automatic experiments do not block foreground work; renderer cannot forge automatic triggers',async()=>{
 const runner=make();runner.inspect=async()=>[{root:'/works/a',state:'running',mode:'evolution',automatic:{trigger:'work_changed_idle'}}];
 assert.equal(await runner.interactive('/works/a',async()=>42),42);
 await assert.rejects(runner.call('automatic-sync',{clientId:'fake',works:[]}),/无效/);
 await assert.rejects(runner.call('create',{root:'/works/a',automatic:true}),/参数/);
 await assert.rejects(runner.call('automatic-configure',{root:'/else',enabled:true}),/有效/);
});

test('automatic heartbeat reports prompt admission immediately and releases only after foreground shutdown',async()=>{
 const connections=[{root:'/works/a',id:'native',ready:true,busy:false,questions:[]}],runner=make(connections),requests=[];
 runner.ensure=async()=>{};runner.request=async data=>{requests.push(data);return {};};runner.disconnect=()=>{};
 runner.observe({type:'client_prompt',clientSessionId:'native'});await runner.syncAutomatic();
 assert.equal(requests.at(-1).works[0].busy,true);
 runner.observe({type:'session_settled',clientSessionId:'native'});await runner.syncAutomatic();assert.equal(requests.at(-1).works[0].busy,false);
 connections.length=0;await runner.stopAutomatic();assert.equal(requests.at(-1).works[0].connected,false);
});
