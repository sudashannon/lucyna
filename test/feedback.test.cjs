const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {FeedbackPolicy}=require('../src/feedback/policy.cjs');
const {defaults,validate,FeedbackPreferences}=require('../src/feedback/settings.cjs');
const {PetState}=require('../src/pet/state.cjs');
function fixture(){const model=new PetState(),policy=new FeedbackPolicy();let locked=false,quiet=false;return{model,policy,send(id,type,fields={}){model.ingest({clientSessionId:id,type,...fields});this.publish();},publish(){policy.observe({sequence:model.sequence,notices:[...model.notices.values()],settings:{quiet},locked});},quiet(value){quiet=value;this.publish();},lock(value){locked=value;this.publish();policy.context({locked:value});}};}
test('parallel OMP settlements coalesce; agent_end, retries and recoverable tool failures do not sound',()=>{
 const f=fixture();for(let i=0;i<20;i++){const id='s'+i;f.send(id,'agent_start');f.send(id,'tool_execution_end',{isError:true});f.send(id,'auto_retry_start');f.send(id,'agent_end');}assert.equal(f.policy.flush(),null);
 for(let i=0;i<20;i++){f.send('s'+i,'prompt_result',{status:'completed',sessionSettled:false});f.send('s'+i,'session_settled');}
 const batch=f.policy.flush();assert.equal(batch.kind,'completed');assert.equal(batch.count,20);assert.equal(f.policy.flush(),null);f.publish();assert.equal(f.policy.flush(),null);
});
test('focus quiets only the visible foreground session; companion mode also includes it',()=>{
 const f=fixture();f.policy.context({focused:true,visibleId:'a'});f.send('a','agent_start');f.send('b','agent_start');f.send('a','session_settled');f.send('b','session_settled');assert.deepEqual(f.policy.flush().ids,['b:completed:1']);
 f.policy.context({focused:false});f.publish();assert.equal(f.policy.flush(),null);
 f.policy.context({focused:true,settings:{...defaults(),mode:'companion'}});f.send('a','agent_start');f.send('a','session_settled');assert.equal(f.policy.flush().count,1);
});
test('attention wins the batch; resolved/cancelled questions are removed before playback',()=>{
 const f=fixture();f.send('a','agent_start');f.send('a','session_settled');f.send('b','agent_start');f.send('b','prompt_result',{status:'error'});f.send('c','extension_ui_request',{id:'q',method:'ask'});
 assert.equal(f.policy.flush().kind,'attention');f.send('c','extension_ui_request',{id:'q',method:'ask'});assert.equal(f.policy.flush(),null);
 f.send('c','extension_ui_request',{id:'q2',method:'ask'});f.send('c','question_resolved',{id:'q2'});assert.equal(f.policy.flush(),null);
 f.send('c','extension_ui_request',{id:'q3',method:'input'});f.send('c','extension_ui_request',{method:'cancel',targetId:'q3'});assert.equal(f.policy.flush(),null);
});
test('native abort and intentional close never produce a completion or failure cue',()=>{
 const f=fixture();f.send('a','agent_start');f.send('a','client_stopping');f.send('a','prompt_result',{status:'aborted'});f.send('a','session_settled');f.send('a','client_closing');f.send('a','process_exit',{code:1});assert.equal(f.policy.flush(),null);
});
test('focus is checked again before flush; session switching never replays an old cue',()=>{
 const f=fixture();f.send('a','agent_start');f.send('a','session_settled');f.policy.context({focused:true,visibleId:'a'});assert.equal(f.policy.flush(),null);f.policy.context({visibleId:'b'});f.publish();assert.equal(f.policy.flush(),null);
});
test('quiet, lock, mute and event switches discard sound without losing visible notices or replaying later',()=>{
 for(const mode of ['quiet','lock','silent','volume','completed']){const f=fixture();if(mode==='quiet')f.quiet(true);else if(mode==='lock')f.lock(true);else f.policy.context({settings:{...defaults(),...(mode==='silent'?{mode:'silent'}:mode==='volume'?{volume:0}:{completed:false})}});
  f.send('a','agent_start');f.send('a','session_settled');assert.equal(f.policy.flush(),null,mode);assert.equal(f.model.notices.size,1);f.quiet(false);f.lock(false);f.policy.context({settings:defaults()});f.publish();assert.equal(f.policy.flush(),null,mode+' replay');
 }
 const f=fixture();f.send('a','agent_start');f.send('a','session_settled');f.lock(true);f.lock(false);f.publish();assert.equal(f.policy.flush(),null);
});
test('settings round-trip both styles, merge patches, preserve a rollback copy and reject invalid input',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lucyna-feedback-'));
 try{const p=new FeedbackPreferences(dir);await p.load(true);assert.equal(p.value.reducedMotion,true);
  await p.save({style:'pixel'});await Promise.all([p.save({volume:37}),p.save({mode:'silent'})]);const reread=new FeedbackPreferences(dir);await reread.load();assert.equal(reread.value.style,'pixel');assert.equal(reread.value.volume,37);assert.equal(reread.value.mode,'silent');assert.equal(JSON.parse(await fs.readFile(p.file+'.bak')).mode,'focus');
  await reread.save({style:'soft'});assert.equal(reread.value.style,'soft');
  for(const value of [{style:'unknown'},{volume:Infinity},{volume:-1},{volume:20.3},{error:'true'},JSON.parse('{"__proto__":{}}')])assert.throws(()=>validate(value));
  await fs.writeFile(p.file,'broken');const broken=new FeedbackPreferences(dir);await broken.load();assert.equal(broken.value.mode,'silent');assert.equal(await fs.readFile(p.file,'utf8'),'broken');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('original local audio has bounded duration/headroom and no discontinuous start/end',async()=>{
 for(const style of ['soft','pixel'])for(const kind of ['completed','attention','error']){const wav=await fs.readFile(path.resolve('src/feedback/assets',style+'-'+kind+'.wav'));assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),48000);assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt16LE(34),16);const duration=(wav.length-44)/96000;assert.ok(duration>=.45&&duration<=.65);let peak=0;for(let i=44;i<wav.length;i+=2)peak=Math.max(peak,Math.abs(wav.readInt16LE(i)));assert.ok(peak>15000&&peak<20000);assert.equal(wav.readInt16LE(44),0);assert.equal(wav.readInt16LE(wav.length-2),0);}
});
