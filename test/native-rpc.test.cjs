const test=require('node:test'),assert=require('node:assert/strict');
const {FrameDecoder,readMessages}=require('../src/native-rpc.cjs');
function chunks(value){const bytes=Buffer.from(JSON.stringify(value)),size=256*1024,count=Math.ceil(bytes.length/size);return Array.from({length:count},(_,index)=>({type:'rpc_chunk',chunkId:'test',index,count,byteLength:bytes.length,data:bytes.subarray(index*size,(index+1)*size).toString('base64')}));}
test('native v2 reassembles large Unicode history and tool messages without truncation',()=>{
  const value={type:'response',data:{messages:[{role:'assistant',content:'跨平台历史 '.repeat(100000)}]}},frames=chunks(value),decoder=new FrameDecoder();
  for(const frame of frames.slice(0,-1))assert.equal(decoder.push(frame),undefined);
  assert.deepEqual(decoder.push(frames.at(-1)),value);
  assert.deepEqual(decoder.push({type:'ready'}),{type:'ready'});
});
test('native v2 rejects malformed, reordered and interrupted chunks',()=>{
  const frames=chunks({type:'message_end',text:'a'.repeat(1200000)});
  assert.throws(()=>new FrameDecoder().push(frames[1]),/起点/);
  assert.throws(()=>new FrameDecoder().push({...frames[0],byteLength:65*1024*1024}),/参数/);
  assert.throws(()=>new FrameDecoder().push({...frames[0],data:'!'}),/数据/);
  const d=new FrameDecoder();d.push(frames[0]);assert.throws(()=>d.push(frames[2]),/顺序/);d.push(frames[0]);assert.throws(()=>d.push({type:'ready'}),/中断/);
});
test('message pagination uses opaque native cursors and restarts a stale snapshot',async()=>{
  let calls=0;const request=async(type,args)=>{assert.equal(type,'get_messages_page');calls++;if(calls===1)return {messages:['old'],totalMessages:2,nextCursor:'first'};if(calls===2){assert.equal(args.cursor,'first');throw Object.assign(new Error('stale'),{code:'stale_cursor'});}if(calls===3){assert.equal(args.cursor,undefined);return {messages:['new'],totalMessages:2,nextCursor:'second'};}assert.equal(args.cursor,'second');return {messages:['tail'],totalMessages:2};};
  assert.deepEqual(await readMessages(request),{messages:['new','tail']});assert.equal(calls,4);
  await assert.rejects(readMessages(async()=>({messages:[],totalMessages:10,nextCursor:'loop'})),/没有前进/);
});
