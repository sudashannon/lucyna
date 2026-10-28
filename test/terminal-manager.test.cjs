const test=require('node:test'),assert=require('node:assert/strict');
const {TerminalManager}=require('../src/terminal-manager.cjs');
test('multiple terminals retain separate input, output, cwd and lifetime',async()=>{
 const processes=[],events=[],roots=['/work/a','/work/b'];
 const manager=new TerminalManager({listWorks:async()=>roots.map(root=>({root,kind:'work'})),send:e=>events.push(e),createPty:root=>{const p={root,onData(f){this.output=f;},onExit(f){this.exit=f;},write(v){this.input=v;},resize(){},kill(){this.exit({exitCode:0});}};processes.push(p);return p;}});
 await Promise.all(roots.map((root,i)=>manager.start(root,{requestId:'terminal-'+i})));
 manager.input('terminal-0','A');manager.input('terminal-1','B');processes[0].output('A OUT');processes[1].output('B OUT');
 assert.deepEqual(processes.map(p=>p.input),['A','B']);assert.deepEqual(events.map(e=>e.id),['terminal-0','terminal-1']);
 await manager.close('terminal-0');assert.equal(manager.records.size,1);manager.input('terminal-1','still alive');assert.equal(processes[1].input,'still alive');manager.dispose();
});
