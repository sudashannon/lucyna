const {TerminalSession}=require('./terminal.cjs');
const {clientId}=require('./session-manager.cjs');
const {randomUUID}=require('node:crypto');
class TerminalManager {
  constructor(options){this.options=options;this.records=new Map();}
  async start(root,dimensions={}){
    const id=clientId(dimensions.requestId||randomUUID());
    if(this.records.has(id))throw new Error('终端已启动');
    const terminal=new TerminalSession({...this.options,send:event=>{this.options.send(event);if(event.type==='exit'&&this.records.get(id)===terminal)this.records.delete(id);}});
    this.records.set(id,terminal);
    try{return await terminal.start(root,{...dimensions,requestId:id});}catch(e){if(this.records.get(id)===terminal)this.records.delete(id);throw e;}
  }
  input(id,data){const terminal=this.records.get(id);if(!terminal)throw new Error('终端会话已结束');return terminal.input(id,data);}
  resize(id,cols,rows){return this.records.get(id)?.resize(id,cols,rows)||false;}
  close(id){return this.records.get(id)?.close(id)||Promise.resolve(false);}
  dispose(){for(const terminal of this.records.values())terminal.dispose();this.records.clear();}
}
module.exports={TerminalManager};
