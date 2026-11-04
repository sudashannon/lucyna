const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {planLayout}=require('../src/knowledge-layout-plan.cjs');
test('plans readable libraries and fixed document types without modifying identity',()=>{
 const input={libraries:[{id:'l1',name:'WSL · rx101',alias:'wsl-rx101'}],documents:[{id:'12345678-1234',library:'l1',libraryPath:path.resolve('legacy'),relative:'openspec/plans/example.md'},{id:'abcdefgh-1234',library:'l1',libraryPath:path.resolve('legacy'),relative:'images/figure.png'}],index:[{path:path.resolve('legacy/openspec/plans/example.md'),type:'plan'}]};
 const plan=planLayout(input);assert.equal(plan.libraries[0].folder,'rx101');assert.deepEqual(plan.items.map(x=>x.to).sort(),['rx101/计划/example.md','rx101/资料/figure.png']);assert.equal(plan.items.find(x=>x.type==='plan').id,'12345678-1234');
});
test('plan handles case-insensitive filename conflicts and rejects unsafe library names',()=>{
 const base={libraries:[{id:'l',name:'x',alias:'x'}],documents:[{id:'12345678-x',library:'l',libraryPath:'legacy',relative:'a/README.md'},{id:'abcdef12-x',library:'l',libraryPath:'legacy',relative:'b/readme.md'}],index:[]};
 assert.deepEqual(planLayout(base).items.map(x=>x.to),['x/待分类/README.md','x/待分类/readme-abcdef12.md']);assert.throws(()=>planLayout({...base,libraries:[{id:'l',alias:'../bad'}]}),/目录/);
});
