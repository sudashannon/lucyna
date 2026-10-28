import type { OmpEvent } from './types';
import {settledOutcome} from '../run-outcome.cjs';

export type Message = { id: string; role: string; content: any; title?: string; intent?: string; args?: any; status?: string; startedAt?: number; endedAt?: number; streaming?: boolean; thinkingActive?: boolean; optimistic?: boolean; skill?: {name: string; path?: string} };
export type Run = { active: boolean; phase: string; startedAt: number; updatedAt: number; endedAt?: number; detail?: string; tools: number; outcome?: 'completed' | 'aborted' | 'error' };
export type Queued = { queue: 'steering' | 'followUp'; message: string };
export type SessionView = { messages: Message[]; run: Run | null; queued: Queued[] };
export const emptyView = (): SessionView => ({ messages: [], run: null, queued: [] });
export function textContent(content: any): string {
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x?.type === 'text').map(x => x.text || '').join('\n') : '';
}
export function answerContent(content: any): any {
  return Array.isArray(content) ? content.filter(x => x?.type === 'text' || x?.type === 'image' || typeof x === 'string') : content;
}
// Some providers emit a single period alongside tool calls. Keep it in the
// native transcript, but do not give that placeholder a separate answer bubble.
export function hasVisibleAnswer(message: Message): boolean {
  if(message.role!=='assistant')return true;
  const blocks=Array.isArray(message.content)?message.content:[];
  if(blocks.some(x=>x?.type==='image'))return true;
  const text=textContent(message.content).trim();
  return !!text && !(text==='.' && (message.streaming || blocks.some(x=>x?.type==='toolCall')));
}
export function thinkingContent(content: any): string {
  return Array.isArray(content) ? content.filter(x => x?.type === 'thinking' && !x.redacted).map(x => x.thinking || x.text || '').join('\n\n') : '';
}
export function toolSummary(message: Message): string {
  if (message.intent) return message.intent;
  const a = message.args || {}, name = message.title || '工具';
  const target = a.path || a.file_path || a.filePath || a.pattern || a.query || a.command || a.cmd || '';
  const verb: Record<string, string> = { read: '读取', glob: '查找文件', grep: '搜索', bash: '执行', python: '执行 Python', edit: '编辑', write: '写入', fetch: '读取网页' };
  return `${verb[name] || name}${typeof target === 'string' && target ? ` · ${target.replace(/\s+/g, ' ').slice(0, 180)}` : ''}`;
}
export function nativeQueue(value: OmpEvent = {}): Queued[] {
  return (['steering', 'followUp'] as const).flatMap(queue => (Array.isArray(value[queue]) ? value[queue] : []).filter((message: any) => typeof message === 'string').map((message: string) => ({queue, message})));
}
// OMP records explicit skill invocations as user-attributed custom messages,
// not role=user. Keep the original draft and skill identity in live and history UI.
export function userMessage(message: OmpEvent): {content: any; skill?: Message['skill']} | null {
  if (message.role === 'user') return {content: message.content};
  if (message.role !== 'custom' || message.customType !== 'skill-prompt' || message.attribution !== 'user' || message.display === false || typeof message.details?.name !== 'string') return null;
  const {name, path, prompt, args} = message.details;
  const text = typeof prompt === 'string' ? prompt : `/skill:${name}${typeof args === 'string' && args ? ` ${args}` : ''}`;
  return {content: [{type: 'text', text}, ...(Array.isArray(message.content) ? message.content.filter(x => x.type === 'image') : [])], skill: {name, path: typeof path === 'string' ? path : undefined}};
}
export function restoreMessages(items: OmpEvent[]): Message[] {
  const result: Message[] = [];
  for (const [index, item] of items.entries()) {
    const m = item.message ?? item, id = item.id || `history-${index}`;
    const user = userMessage(m);
    if (user || m.role === 'assistant') {
      result.push(user ? {id, role: 'user', ...user} : {id, role: m.role, content: m.content});
      if (m.role === 'assistant' && Array.isArray(m.content)) for (const block of m.content) {
        if (block.type === 'toolCall') result.push({id: block.id || `${id}-tool`, role: 'tool', title: block.name, args: block.arguments, intent: block.intent, content: '', status: '历史记录'});
      }
    } else if (m.role === 'toolResult') {
      const previous = result.find(x => x.id === m.toolCallId && x.role === 'tool');
      if (previous) Object.assign(previous, {content: m.content, status: m.isError ? '失败' : '完成'});
      else result.push({id: m.toolCallId || id, role: 'tool', title: m.toolName, content: m.content, status: m.isError ? '失败' : '完成'});
    }
  }
  return result;
}
// This is a projection of OMP events, not a second agent loop. Queue membership,
// retries, compaction and settlement are always decided by the native process.
export function projectEvent(view: SessionView, event: OmpEvent, now = Date.now()): SessionView {
  let {messages, run, queued} = view;
  const progress = (phase: string, detail?: string) => {
    if (run?.phase === 'stopping') { run = {...run, updatedAt: now}; return; }
    run = {...(run?.active ? run : {startedAt: now, tools: 0}), active: true, phase, detail, updatedAt: now};
  };
  const finish = (outcome: Run['outcome']) => {
    if (run) run = {...run, active: false, outcome, phase: outcome || 'completed', endedAt: now, updatedAt: now};
    messages = messages.map(m => m.streaming || m.status === '执行中' ? {...m, streaming: false, thinkingActive: false, endedAt: now, status: m.role === 'tool' ? (outcome === 'completed' ? '完成' : '已中断') : m.status} : m);
  };
  const upsert = (message: Message) => { messages = messages.some(x => x.id === message.id) ? messages.map(x => x.id === message.id ? {...x, ...message} : x) : [...messages, message]; };
  if (event.type === 'local_send') {
    messages = [...messages, {id: event.id, role: 'user', content: event.images?.length?[{type:'text',text:event.text},...event.images]:event.text, optimistic: true}];
    run = {active: true, phase: event.connecting ? 'connecting' : 'waiting', startedAt: now, updatedAt: now, tools: 0};
  }
  if (event.type === 'local_send_failed') { messages = messages.filter(x => x.id !== event.id || !x.optimistic); finish('error'); }
  if (event.type === 'local_command_complete') { messages = messages.map(m => m.id === event.id ? {...m, optimistic: false} : m); if (run?.active) finish('completed'); }
  if (event.type === 'local_stop') progress('stopping');
  if (event.type === 'local_stop_failed' && run) run = {...run, phase: 'waiting', updatedAt: now};
  if (event.type === 'agent_start') progress('waiting');
  const user = event.type === 'message_start' && event.message ? userMessage(event.message) : null;
  if (user) {
    const id = event.messageId || `user-${now}`, {content, skill} = user;
    const optimistic = messages.find(x => x.optimistic && textContent(x.content) === textContent(content));
    if (optimistic) messages = messages.map(x => x === optimistic ? {...x, id, content, skill, optimistic: false} : x);
    else { upsert({id, role: 'user', content, skill}); run = {active: true, phase: 'waiting', startedAt: now, updatedAt: now, tools: 0}; }
  }
  if (event.type === 'message_update') {
    const d = event.assistantMessageEvent || event.delta || {}, index = d.contentIndex ?? 0;
    const id = event.messageId || [...messages].reverse().find(x => x.role === 'assistant' && x.streaming)?.id || `assistant-${now}`;
    const previous = messages.find(x => x.id === id);
    let content = Array.isArray(previous?.content) ? [...previous.content] : [];
    if (Array.isArray(d.partial?.content)) content = d.partial.content;
    else if (/^(text|thinking)_(start|delta|end)$/.test(d.type || '')) {
      const thinking = d.type.startsWith('thinking'), key = thinking ? 'thinking' : 'text';
      content[index] = {type: key, [key]: d.type.endsWith('_end') && typeof d.content === 'string' ? d.content : (content[index]?.[key] || '') + (d.delta || '')};
    }
    upsert({id, role: 'assistant', content, streaming: true, thinkingActive: d.type?.startsWith('thinking') && d.type !== 'thinking_end', startedAt: previous?.startedAt || now});
    if (d.type?.startsWith('thinking')) progress('thinking');
    else if (d.type?.startsWith('text')) progress('writing');
    else if (d.type?.startsWith('toolcall')) progress('preparing');
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const id = event.messageId || [...messages].reverse().find(x => x.role === 'assistant' && x.streaming)?.id || `assistant-${now}`;
    upsert({id, role: 'assistant', content: event.message.content, streaming: false, thinkingActive: false, endedAt: now});
  }
  if (event.type === 'tool_execution_start') {
    const m: Message = {id: event.toolCallId || `tool-${now}`, role: 'tool', title: event.toolName, args: event.args, intent: event.intent, content: '', status: '执行中', startedAt: now};
    upsert(m); progress('tool', toolSummary(m)); if (run) run = {...run, tools: run.tools + 1};
  }
  if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
    const ended = event.type === 'tool_execution_end', result = ended ? event.result : event.partialResult;
    messages = messages.map(m => m.id === event.toolCallId ? {...m, content: result?.content ?? result ?? m.content, status: ended ? event.isError ? '失败' : '完成' : '执行中', endedAt: ended ? now : undefined} : m);
    const running = messages.find(x => x.role === 'tool' && x.status === '执行中');
    progress(running ? 'tool' : 'waiting', running ? toolSummary(running) : undefined);
  }
  if (event.type === 'auto_retry_start') progress('retrying', `第 ${event.attempt ?? 1} 次重试${event.maxAttempts ? ` / ${event.maxAttempts}` : ''}${event.delayMs ? ` · ${Math.ceil(event.delayMs / 1000)} 秒后` : ''}`);
  if (event.type === 'auto_compaction_start') progress('compacting');
  if (event.type === 'auto_compaction_end' || event.type === 'auto_retry_end') progress('waiting');
  if (event.type === 'agent_end' && run?.active) progress('settling');
  if (event.type === 'prompt_result') {
    if (event.sessionSettled === false) { progress('background'); if (run) run = {...run, outcome: event.status}; }
  }
  const outcome=settledOutcome(run,event);if(outcome)finish(outcome);
  if (event.type === 'command_output') { upsert({id: `command-${now}`, role: 'assistant', content: event.text || ''}); finish('completed'); }
  if (event.type === 'queue_update') queued = nativeQueue(event);
  if (event.type === 'process_exit' || event.type === 'process_error') { queued = []; }
  return messages===view.messages&&run===view.run&&queued===view.queued?view:{messages, run, queued};
}
export const phaseLabels: Record<string, string> = {connecting: '正在连接 OMP', waiting: '等待模型响应', thinking: '正在思考', preparing: '正在准备工具调用', tool: '正在执行工具', writing: '正在回答', retrying: 'OMP 正在重试', compacting: '正在整理上下文', settling: '正在确认完成状态', background: '等待 OMP 后续任务', stopping: '正在停止', completed: '已完成', aborted: '已停止', error: '本次运行未完成'};

