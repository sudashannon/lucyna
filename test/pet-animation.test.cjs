const test=require('node:test'),assert=require('node:assert/strict');
const {clipFor,sample,placement}=require('../src/pet/animation.js'),atlases=require('../src/pet/animation-data.js');
const {validate,defaults}=require('../src/pet/state.cjs');
test('animation follows aggregate native status, never celebrating stop or masking a pending question',()=>{
 assert.equal(clipFor({phase:'completed',activeCount:1}),'working');
 assert.equal(clipFor({phase:'working',activeCount:2,pendingCount:1}),'attention');
 assert.equal(clipFor({phase:'aborted'}),'idle');assert.equal(clipFor({phase:'error'}),'attention');
 assert.equal(clipFor({phase:'completed'}),'completed');
});
test('blink holds rest pose, activity loops, celebration returns to idle and reduced motion has no timer',()=>{
 assert.equal(sample('idle',2500).frame,0);assert.equal(sample('idle',2650).frame,1);assert.equal(sample('idle',2800).frame,2);
 assert.equal(sample('working',1420).frame,4);
 assert.equal(sample('completed',100).frame,12);assert.ok(sample('completed',1900).frame<4);
 assert.equal(sample('completed',4600).frame,2);assert.equal(sample('attention',999,true).delay,0);
});
test('every source frame is valid and shares a fixed baseline at all desktop sizes',()=>{
 for(const atlas of Object.values(atlases)){
  assert.equal(atlas.frames.length,16);
  for(const width of [126,168,224,280])for(let i=0;i<16;i++){
   const {source:s,image:r}=placement(atlas,i,width,width);
   assert.ok(s.x>=0&&s.y>=0&&s.x+s.width<=atlas.width&&s.y+s.height<=atlas.height);
   assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=width+.001);
   assert.ok(Math.abs(r.y+r.height-(width-6))<.001);
  }
 }
});
test('older saved pet settings migrate to animation without losing disabled/reduced motion preferences',()=>{
 const old=defaults();delete old.animated;old.enabled=false;old.reducedMotion=true;
 assert.equal(validate(old).animated,true);assert.equal(validate(old).enabled,false);assert.equal(validate(old).reducedMotion,true);
 assert.equal(validate({animated:false}).animated,false);assert.throws(()=>validate({animated:'yes'}));
});
