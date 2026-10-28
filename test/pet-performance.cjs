// Measures event projection only; not a whole-app CPU/memory benchmark.
const {PetState,defaults}=require('../src/pet/state.cjs'),{performance}=require('node:perf_hooks'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const model=new PetState();for(let i=0;i<8;i++)model.ingest({type:'agent_start',clientSessionId:'session-'+i,workRoot:'/test/'+i});
const before=performance.now();let repaints=0;for(let i=0;i<100000;i++)repaints+=Number(model.ingest({type:'message_update',clientSessionId:'session-'+i%8,assistantMessageEvent:{type:'text_delta',delta:'A'.repeat(100)}}));
const elapsedMs=performance.now()-before,snapshotBytes=Buffer.byteLength(JSON.stringify(model.snapshot(defaults())));assert.equal(repaints,0);assert.ok(snapshotBytes<6000);assert.equal(model.notices.size,0);
const out=path.resolve('.runtime/pet-performance.json');fs.writeFileSync(out,JSON.stringify({scope:'state projection only; not system CPU or renderer memory',events:100000,sessions:8,elapsedMs,requestedRepaints:repaints,snapshotBytes},null,2));console.log(fs.readFileSync(out,'utf8'));
