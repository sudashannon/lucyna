const test=require('node:test'),assert=require('node:assert/strict');
const {canAccessWorkRoot,requireWorkRoot}=require('../src/work-access.cjs');
test('Git and manifest failures do not deny an accessible discovered Work root',()=>{
 for(const code of ['git_top','common_mismatch','base_sha_format','manifest_schema','manifest_read','session_read']){
  const work={root:'/works/a',kind:'invalid',rootAvailable:true,issues:[{code,severity:'error'}]};
  assert.equal(canAccessWorkRoot(work),true);assert.equal(requireWorkRoot([work],work.root),work);
 }
});
test('unknown, missing, linked and failed root discovery remain inaccessible',()=>{
 assert.equal(canAccessWorkRoot(null),false);assert.equal(canAccessWorkRoot({root:''}),false);
 assert.throws(()=>requireWorkRoot([], '/works/a'),/不在当前工作区/);
 for(const work of [{root:'/works/a',rootAvailable:false},{root:'/works/a',issues:[{code:'root_invalid'}]},{root:'/works/a',issues:[{code:'scan_failed'}]}]){
  assert.equal(canAccessWorkRoot(work),false);assert.throws(()=>requireWorkRoot([work],work.root),/不可访问/);
 }
 assert.throws(()=>requireWorkRoot([{root:'/works/a',hostId:'ssh'}],'/works/a'),/不在当前工作区/);
});
