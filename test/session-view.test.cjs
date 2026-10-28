const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const filename = path.resolve(__dirname, '../src/renderer/session-view.ts');
const mod = new Module(filename, module);
mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, filename);
const {emptyView, projectEvent: step, restoreMessages, thinkingContent, textContent, answerContent, toolSummary} = mod.exports;
const start = () => step(emptyView(), {type:'local_send',id:'optimistic',text:'Status?'}, 1000);
test('tool-only period is presentation noise, while literal final/user periods and images remain visible',()=>{
  const {hasVisibleAnswer}=mod.exports;
  const message={id:'native-dot',role:'assistant',content:[{type:'text',text:'.'},{type:'toolCall',name:'bash',id:'tool',arguments:{}}]};
  assert.equal(hasVisibleAnswer(message),false);
  assert.equal(hasVisibleAnswer({...message,content:'.'}),true);
  assert.equal(hasVisibleAnswer({...message,content:'.',streaming:true}),false);
  assert.equal(hasVisibleAnswer({...message,role:'user'}),true);
  assert.equal(hasVisibleAnswer({...message,content:[...message.content,{type:'image',data:'AAAA',mimeType:'image/png'}]}),true);
  assert.equal(hasVisibleAnswer({...message,content:[{type:'text',text:'Checking.'},message.content[1]]}),true);
  assert.equal(message.content[0].text,'.');
});
test('native skill custom messages reconcile the original draft and survive history restore without dumping skill instructions', () => {
  const prompt='/skill:worktree-session check status';
  const message={role:'custom',customType:'skill-prompt',attribution:'user',display:true,content:'EXPANDED SKILL INSTRUCTIONS',details:{name:'worktree-session',path:'/skills/work/SKILL.md',prompt,args:'check status'}};
  let v=step(emptyView(),{type:'local_send',id:'pending',text:prompt},1000);
  v=step(v,{type:'message_start',messageId:'native-skill',message},1100);
  assert.equal(v.messages.length,1);assert.equal(v.messages[0].optimistic,false);assert.equal(v.messages[0].skill.name,'worktree-session');assert.equal(textContent(v.messages[0].content),prompt);
  const restored=restoreMessages([message]);assert.equal(restored[0].role,'user');assert.equal(textContent(restored[0].content),prompt);
  assert.equal(restoreMessages([{...message,attribution:'agent',display:false}]).length,0);
});
test('native user echo reconciles optimistic prompt; thinking is visible before text and authoritative ends replace deltas', () => {
  let v = start();
  v = step(v,{type:'message_start',messageId:'u1',message:{role:'user',content:[{type:'text',text:'Status?'}]}},1100);
  assert.equal(v.messages.length,1);assert.equal(v.messages[0].id,'u1');assert.equal(v.messages[0].optimistic,false);
  v = step(v,{type:'message_update',messageId:'a1',assistantMessageEvent:{type:'thinking_delta',contentIndex:0,delta:'Checking context'}},2000);
  assert.equal(v.run.phase,'thinking');assert.equal(thinkingContent(v.messages[1].content),'Checking context');assert.equal(textContent(v.messages[1].content),'');
  v = step(v,{type:'message_update',messageId:'a1',assistantMessageEvent:{type:'thinking_end',contentIndex:0,content:'Checked context'}},2200);
  assert.equal(thinkingContent(v.messages[1].content),'Checked context');
  v = step(v,{type:'message_end',messageId:'a1',message:{role:'assistant',content:[{type:'text',text:'Ready'}]}},2500);
  assert.equal(v.messages.filter(x=>x.role==='assistant').length,1);assert.equal(textContent(v.messages[1].content),'Ready');
});
test('tool progress snapshots replace partial output, preserve arguments and report parallel activity', () => {
  let v=start();
  v=step(v,{type:'tool_execution_start',toolCallId:'t1',toolName:'read',args:{path:'/work/SESSION.md'},intent:'检查工作状态'},2000);
  v=step(v,{type:'tool_execution_start',toolCallId:'t2',toolName:'bash',args:{command:'pwd'}},2100);
  for(const text of ['part','full output']) v=step(v,{type:'tool_execution_update',toolCallId:'t1',partialResult:{content:[{type:'text',text}]}},2200);
  assert.equal(textContent(v.messages[1].content),'full output');assert.equal(toolSummary(v.messages[1]),'检查工作状态');
  v=step(v,{type:'tool_execution_end',toolCallId:'t1',isError:false,result:{content:[{type:'text',text:'done'}]}},2400);
  assert.equal(v.run.phase,'tool');assert.match(v.run.detail,/pwd/);assert.equal(v.run.tools,2);
  assert.equal(v.messages[1].args.path,'/work/SESSION.md');assert.equal(v.messages[1].endedAt,2400);
});
test('agent_end is not settlement; background work stays busy until native session_settled', () => {
  let v=step(start(),{type:'agent_end'},2000);assert.equal(v.run.active,true);
  v=step(v,{type:'prompt_result',status:'completed',sessionSettled:false},2100);assert.equal(v.run.phase,'background');assert.equal(v.run.active,true);
  v=step(v,{type:'session_settled'},3000);assert.equal(v.run.active,false);assert.equal(v.run.outcome,'completed');
});
test('native queue snapshots determine membership; queued input appears only on native user echo', () => {
  let v=step(start(),{type:'queue_update',steering:[],followUp:['next','next']},1100);
  assert.equal(v.queued.length,2);assert.equal(v.messages.length,1);
  v=step(v,{type:'queue_update',steering:[],followUp:['next']},1200);assert.equal(v.queued.length,1);
  v=step(v,{type:'message_start',messageId:'u2',message:{role:'user',content:'next'}},1300);
  assert.equal(v.messages.filter(x=>textContent(x.content)==='next').length,1);
});
test('stop remains visibly pending through late deltas; terminal native result completes it', () => {
  let v=step(start(),{type:'local_stop'},1200);
  v=step(v,{type:'message_update',messageId:'a',assistantMessageEvent:{type:'text_delta',delta:'late'}},1300);
  assert.equal(v.run.phase,'stopping');
  v=step(v,{type:'prompt_result',status:'aborted',sessionSettled:true},1400);assert.equal(v.run.active,false);assert.equal(v.run.outcome,'aborted');
  v=step(v,{type:'session_settled'},1500);assert.equal(v.run.outcome,'aborted');
});
test('restored history links tool arguments/results without duplicate assistant tool announcements or redacted reasoning', () => {
  const messages=restoreMessages([{id:'a',message:{role:'assistant',content:[{type:'thinking',thinking:'original'},{type:'toolCall',id:'t',name:'read',arguments:{path:'README.md'}}]}},{message:{role:'toolResult',toolCallId:'t',toolName:'read',content:[{type:'text',text:'File body'}],isError:false}}]);
  assert.equal(messages.length,2);assert.equal(messages[1].status,'完成');assert.equal(messages[1].args.path,'README.md');
  assert.deepEqual(answerContent(messages[0].content),[]);
  assert.equal(thinkingContent([{type:'thinking',redacted:true,thinking:'hidden'}]),'');
});
test('retry/compaction progress and process failure are distinct; startup failure removes only unsent optimistic message', () => {
  let v=step(start(),{type:'auto_retry_start',attempt:2,maxAttempts:3,delayMs:4000},1200);assert.equal(v.run.phase,'retrying');assert.match(v.run.detail,/2/);
  v=step(v,{type:'auto_compaction_start'},1300);assert.equal(v.run.phase,'compacting');
  v=step(v,{type:'process_error'},1400);assert.equal(v.run.active,false);assert.equal(v.run.outcome,'error');
  v=step(v,{type:'local_send_failed',id:'optimistic'},1500);assert.equal(v.messages.length,0);
});
