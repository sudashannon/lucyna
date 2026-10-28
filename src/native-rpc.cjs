// OMP v2 transport adapter. Protocol reference (v18.13.2):
// packages/coding-agent/src/modes/rpc/{rpc-frame,rpc-messages}.ts
// Keeps OMP responsible for session selection, branching and pagination.
const MAX_BYTES = 64 * 1024 * 1024;
class FrameDecoder {
  constructor() { this.pending = null; }
  push(frame) {
    const fail = message => {this.pending=null;throw new Error(message);};
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return fail('无效 OMP 协议帧');
    if (frame.type !== 'rpc_chunk') {
      if (this.pending) return fail('OMP 分块传输被中断');
      return frame;
    }
    const {chunkId,index,count,byteLength,data}=frame;
    if (typeof chunkId!=='string'||!chunkId||chunkId.length>128||!Number.isSafeInteger(index)||!Number.isSafeInteger(count)||!Number.isSafeInteger(byteLength)||index<0||index>=count||count<2||count>256||byteLength<1024*1024||byteLength>MAX_BYTES||typeof data!=='string'||data.length>350000) return fail('无效 OMP 分块参数');
    const bytes=Buffer.from(data,'base64');
    if (!bytes.length||bytes.length>256*1024||bytes.toString('base64')!==data) return fail('无效 OMP 分块数据');
    if (!this.pending) {
      if(index!==0)return fail('OMP 分块起点错误');
      this.pending={chunkId,count,byteLength,next:0,size:0,chunks:[]};
    }
    const p=this.pending;
    if(p.chunkId!==chunkId||p.count!==count||p.byteLength!==byteLength||p.next!==index)return fail('OMP 分块顺序错误');
    p.chunks.push(bytes);p.next++;p.size+=bytes.length;
    if(p.size>byteLength)return fail('OMP 分块超过声明长度');
    if(p.next<count)return undefined;
    if(p.size!==byteLength)return fail('OMP 分块长度不完整');
    this.pending=null;
    const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(p.chunks,p.size)));
    if(!result||typeof result!=='object'||Array.isArray(result)||result.type==='rpc_chunk')return fail('无效 OMP 完整消息');
    return result;
  }
}
async function readMessages(request) {
  // A startup extension may append a message between pages; retry one fresh
  // native snapshot instead of combining two different histories.
  for(let attempt=0;attempt<2;attempt++) {
    let cursor,total,size=0;const messages=[],seen=new Set();
    try {
      do {
        const page=await request('get_messages_page',{...(cursor?{cursor}:{}),limit:100});
        if(!Array.isArray(page?.messages)||!Number.isSafeInteger(page.totalMessages)||page.totalMessages<0)throw new Error('OMP 历史分页格式无效');
        total??=page.totalMessages;
        if(total!==page.totalMessages)throw new Error('OMP 历史分页总数发生变化');
        size+=Buffer.byteLength(JSON.stringify(page.messages));
        if(size>MAX_BYTES)throw new Error('历史显示内容超过 64 MiB，请在原生 OMP 中查看；原会话已保留');
        messages.push(...page.messages);cursor=page.nextCursor;
        if(cursor && (typeof cursor!=='string'||!page.messages.length||seen.has(cursor)))throw new Error('OMP 历史分页没有前进');
        if(cursor)seen.add(cursor);
      } while(cursor);
      if(messages.length!==total)throw new Error('OMP 历史分页不完整');
      return {messages};
    } catch(error) {if(attempt===0&&error.code==='stale_cursor')continue;throw error;}
  }
}
module.exports={FrameDecoder,readMessages};
