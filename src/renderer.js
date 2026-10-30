const $ = id => document.getElementById(id);
const state = { works: [], work: null, running: false, starting: false, busy: false, assistant: null, resume: null, selection: 0, preview: null };
let terminal, fitAddon, terminalId = null, terminalStarting = false, terminalPendingEvents = [], terminalResizeObserver;
function el(tag, className, text) { const x = document.createElement(tag); if (className) x.className = className; if (text !== undefined) x.textContent = text; return x; }
// Markdown is rendered using DOM nodes and textContent; raw HTML is never executed.
function inlineMarkdown(target, source) { const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g; let offset = 0; for (const match of source.matchAll(pattern)) { const [token] = match; const at = match.index; if (at > offset) target.append(document.createTextNode(source.slice(offset, at))); if (token.startsWith('`')) target.append(el('code', 'inline-code', token.slice(1, -1))); else if (token.startsWith('**')) target.append(el('strong', '', token.slice(2, -2))); else if (token.startsWith('*')) target.append(el('em', '', token.slice(1, -1))); else { const parsed = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/); try { const url = new URL(parsed[2]); if (url.username || url.password) throw new Error('credentials'); const link = el('a', '', parsed[1]); link.href = url.toString(); link.addEventListener('click', event => { event.preventDefault(); window.desktop.openExternal(url.toString()).catch(e => alert(e.message)); }); target.append(link); } catch { target.append(document.createTextNode(token)); } } offset = at + token.length; } if (offset < source.length) target.append(document.createTextNode(source.slice(offset))); }
function markdown(target, source) { target.replaceChildren(); let code = null, list = null, listType = null; for (const line of String(source).split('\n')) { if (/^\s*```/.test(line)) { if (code) code = null; else { const pre = el('pre', 'code-block'); code = el('code'); pre.append(code); target.append(pre); } list = null; continue; } if (code) { code.textContent += line + '\n'; continue; } const heading = line.match(/^(#{1,4})\s+(.+)$/); const item = line.match(/^\s*([-*]|\d+\.)\s+(.+)$/); const quote = line.match(/^\s*>\s?(.*)$/); if (heading) { const node = el(`h${heading[1].length}`); inlineMarkdown(node, heading[2]); target.append(node); list = null; } else if (item) { const type = /^\d/.test(item[1]) ? 'ol' : 'ul'; if (!list || listType !== type) { list = el(type); target.append(list); listType = type; } const node = el('li'); inlineMarkdown(node, item[2]); list.append(node); } else if (quote) { const node = el('blockquote'); inlineMarkdown(node, quote[1]); target.append(node); list = null; } else { list = null; listType = null; if (line.trim()) { const p = el('p'); inlineMarkdown(p, line); target.append(p); } } } }
function log(text) { const target = $('event-log'); if (target.textContent === '等待 OMP 启动') target.textContent = ''; target.prepend(el('div', 'event-item', text)); }
function appendMessage(role, text) { $('empty').hidden = true; $('messages').hidden = false; const row = el('article', `message ${role}`); row.append(el('div', 'message-label', role === 'user' ? '你' : role === 'tool' ? '工具' : 'OMP')); const body = el('div', 'message-body'); if (role === 'assistant' && text) { body.classList.add('markdown'); markdown(body, text); } else body.textContent = text || ''; row.append(body); $('messages').append(row); row.scrollIntoView({ block: 'end' }); return body; }
function renderText(content) { if (typeof content === 'string') return content; if (Array.isArray(content)) return content.map(x => x.text || (x.type === 'image' ? '[图片数据缺失，无法预览]' : '')).filter(Boolean).join('\n'); return ''; }
function imageBlock(block) {
  const mimeMap = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/gif': 'image/gif', 'image/webp': 'image/webp', 'image/bmp': 'image/bmp' };
  const rawMime = block.mimeType || block.mime_type || block.source?.media_type || block.contentType || '';
  const mime = mimeMap[String(rawMime).toLowerCase()];
  if (!mime) return el('div', 'attachment-fallback', `图片类型不支持预览：${rawMime || '未知'}`);
  const rawData = block.data ?? block.base64 ?? (block.source?.type === 'base64' ? block.source.data : undefined);
  if (typeof rawData !== 'string' || !rawData.trim()) return el('div', 'attachment-fallback', '图片数据缺失，无法预览');
  const encoded = rawData.replace(/\s/g, '');
  if (!encoded || encoded.length > 14 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return el('div', 'attachment-fallback', '图片数据无效或超过 10 MiB，无法预览');
  try { if (atob(encoded).length > 10 * 1024 * 1024) return el('div', 'attachment-fallback', '图片超过 10 MiB，无法预览'); }
  catch { return el('div', 'attachment-fallback', '图片数据无效，无法预览'); }
  const image = document.createElement('img'); image.className = 'message-image'; image.loading = 'lazy'; image.decoding = 'async'; image.alt = '消息中的图片'; image.src = `data:${mime};base64,${encoded}`; return image;
}
function appendMessageContent(role, content) {
  if (typeof content === 'string' || !Array.isArray(content)) return appendMessage(role, renderText(content));
  const body = appendMessage(role, '');
  for (const block of content) {
    if (typeof block === 'string') { const segment = el('div', role === 'assistant' ? 'markdown' : 'message-text'); if (role === 'assistant') markdown(segment, block); else segment.textContent = block; body.append(segment); }
    else if (block?.type === 'image') body.append(imageBlock(block));
    else if (typeof block?.text === 'string') { const segment = el('div', role === 'assistant' ? 'markdown' : 'message-text'); if (role === 'assistant') markdown(segment, block.text); else segment.textContent = block.text; body.append(segment); }
    else if (block?.type) body.append(el('div', 'attachment-fallback', `暂不支持此消息内容：${block.type}`));
  }
  if (!body.childNodes.length) body.append(el('div', 'attachment-fallback', '消息内容为空或附件数据缺失'));
  return body;
}
function finishAssistantMessage() { if (!state.assistant) return; const source = state.assistant.textContent; state.assistant.classList.add('markdown'); markdown(state.assistant, source); state.assistant = null; }
function syncControls() { $('input').disabled = !state.running || state.busy; $('send').disabled = !state.running || state.busy; $('stop').disabled = !state.running || !state.busy; const validWork = !!state.work && state.work.kind !== 'invalid'; $('terminal').disabled = !validWork; $('terminal-fallback').disabled = !validWork; $('preview-file').disabled = !validWork; $('choose-preview').disabled = !validWork; }
function setTab(id) { document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === id)); for (const name of ['overview', 'preview', 'memory', 'events']) $(name).hidden = name !== id; }
function renderFilePreview() { const target = $('file-preview'); target.replaceChildren(); if (!state.preview) { target.append(el('div', 'panel-empty', '尚未选择文件')); return; } target.append(el('div', 'preview-name', state.preview.name)); if (state.preview.kind === 'markdown') { const doc = el('div', 'document markdown'); markdown(doc, state.preview.content); target.append(doc); } else if (state.preview.kind === 'image') { const image = document.createElement('img'); image.className = 'preview-image'; image.alt = state.preview.name; image.src = state.preview.dataUrl; target.append(image); } else target.append(el('div', 'error', '不支持的预览类型')); }
async function choosePreviewFile() { if (!state.work || state.work.kind === 'invalid') return; try { const chosen = await window.desktop.choosePreview(state.work.root); if (!chosen) return; state.preview = chosen; renderFilePreview(); setTab('preview'); } catch (e) { alert(e.message); } }
function setTerminalStatus(value) { $('terminal-status').textContent = value; }
function ensureTerminal() {
  if (terminal) return;
  const TerminalClass = typeof window.Terminal === 'function' ? window.Terminal : window.Terminal?.Terminal;
  const FitAddonClass = window.FitAddon?.FitAddon || window.FitAddon;
  if (typeof TerminalClass !== 'function' || typeof FitAddonClass !== 'function') throw new Error('终端界面组件未加载');
  terminal = new TerminalClass({ cursorBlink: true, fontSize: 12, fontFamily: 'Cascadia Mono, Consolas, monospace', scrollback: 5000, theme: { background: '#202124', foreground: '#e5e5e5', cursor: '#f2f2f2', selectionBackground: '#505155' } });
  fitAddon = new FitAddonClass(); terminal.loadAddon(fitAddon); terminal.open($('terminal-view'));
  terminal.onData(data => { if (terminalId) window.desktop.terminalInput(terminalId, data).catch(e => setTerminalStatus(`输入失败：${e.message}`)); });
  terminal.onResize(({ cols, rows }) => { if (terminalId) window.desktop.terminalResize(terminalId, cols, rows).catch(e => setTerminalStatus(`调整大小失败：${e.message}`)); });
  terminalResizeObserver = new ResizeObserver(() => { if (!$('terminal-drawer').hidden && fitAddon) { try { fitAddon.fit(); } catch {} } });
  terminalResizeObserver.observe($('terminal-view'));
}
function applyTerminalEvent(event) {
  if (!terminal || event.id !== terminalId) return;
  if (event.type === 'data' && typeof event.data === 'string') terminal.write(event.data);
  if (event.type === 'exit') { terminal.write(`\r\n[终端结束，退出码 ${event.exitCode ?? '未知'}]\r\n`); terminalId = null; $('terminal-stop').disabled = true; setTerminalStatus('已结束'); }
}
window.desktop.onTerminal(event => {
  if (terminalId) { applyTerminalEvent(event); return; }
  if (terminalStarting) terminalPendingEvents.push(event);
});
async function startEmbeddedTerminal() {
  if (!state.work || state.work.kind === 'invalid' || terminalId || terminalStarting) return;
  terminalStarting = true; terminalPendingEvents = []; setTerminalStatus('正在启动 WSL…');
  try {
    fitAddon.fit();
    const result = await window.desktop.startTerminal(state.work.root, { cols: terminal.cols, rows: terminal.rows });
    terminalId = result.id; terminalStarting = false; $('terminal-stop').disabled = false; setTerminalStatus('运行中');
    for (const event of terminalPendingEvents) if (event.id === terminalId) applyTerminalEvent(event);
    terminalPendingEvents = []; terminal.focus();
  } catch (e) { terminalStarting = false; terminalPendingEvents = []; setTerminalStatus('启动失败，可使用独立窗口'); terminal.write(`\r\n[嵌入式终端启动失败：${e.message}]\r\n`); }
}
async function toggleTerminal() {
  const drawer = $('terminal-drawer');
  if (!drawer.hidden) { drawer.hidden = true; return; }
  if (!state.work || state.work.kind === 'invalid') return;
  drawer.hidden = false; $('terminal-work').textContent = state.work.root;
  try { ensureTerminal(); fitAddon.fit(); if (terminalId) terminal.focus(); else await startEmbeddedTerminal(); }
  catch (e) { setTerminalStatus(e.message); }
}
async function stopEmbeddedTerminal() { if (!terminalId) return; const id = terminalId; $('terminal-stop').disabled = true; setTerminalStatus('正在结束…'); try { await window.desktop.closeTerminal(id); } catch (e) { setTerminalStatus(`结束失败：${e.message}`); $('terminal-stop').disabled = false; } }
function renderHistoryItem(title, detail, actionText, action) { const item = el('div', 'history-item'); const main = el('div', 'history-item-main'); main.append(el('div', 'history-item-title', title || '未命名 session'), el('div', 'history-item-detail', detail || '')); const button = el('button', 'outline-wide history-open', actionText); button.onclick = action; item.append(main, button); return item; }
async function loadHistory(root, selection, target) {
  target.replaceChildren(el('div', 'muted', '正在读取历史 session…'));
  try {
    const result = await window.desktop.listHistory(root);
    if (selection !== state.selection) return;
    target.replaceChildren();
    const managed = Array.isArray(result.managed) ? result.managed : [];
    const wslSessions = Array.isArray(result.sessions) ? result.sessions : [];
    target.append(el('div', 'history-group-title', 'Windows 会话'));
    if (!managed.length) target.append(el('div', 'muted', '暂无客户端新建或已导入的 session'));
    for (const entry of managed) {
      const date = entry.modifiedAt || entry.importedAt;
      const modified = [entry.sourceKind === 'native' ? '本客户端创建' : entry.sourceKind === 'wsl' ? '来自 WSL' : 'Windows 副本', date ? new Date(date).toLocaleString() : ''].filter(Boolean).join(' · ');
      const label = entry.title || entry.sessionFile?.split(/[\\/]/).pop() || '已迁入 session';
      target.append(renderHistoryItem(label, modified, state.running || state.starting ? '当前会话运行中' : '继续', async () => {
        if (state.running || state.starting) return;
        try { await startSession(entry.sessionFile, entry.agentDir); }
        catch (e) { alert(e.message); }
      }));
    }
    target.append(el('div', 'history-group-title', 'WSL 历史 session'));
    if (!wslSessions.length) target.append(el('div', 'muted', '当前 work 中没有发现 session'));
    for (const entry of wslSessions) {
      const detail = [entry.id, entry.cwd, entry.modified].filter(Boolean).join(' · ');
      target.append(renderHistoryItem(entry.title || entry.id || 'WSL session', detail, state.running || state.starting ? '当前会话运行中' : '导入并继续', async () => {
        if (state.running || state.starting) return;
        if (!confirm('将 WSL session 复制为 Windows 管理的独立副本，再从副本继续。WSL 原文件不会修改；引用到 work 根之外的附件可能无法复制。继续吗？')) return;
        const button = target.querySelectorAll('.history-open');
        button.forEach(x => x.disabled = true);
        try {
          const imported = await window.desktop.importSession(entry.path, root);
          if (imported?.warning) alert(`副本已导入，但有需要留意的项目：\n${imported.warning}`);
          await startSession(imported.sessionFile, imported.agentDir);
        } catch (e) { alert(e.message); }
        finally { button.forEach(x => x.disabled = state.running || state.starting); }
      }));
    }
  } catch (e) { if (selection === state.selection) target.replaceChildren(el('div', 'error', `历史 session 读取失败：${e.message}`)); }
}
async function loadWorks() { $('works').replaceChildren(el('div', 'muted', '正在发现工作根…')); try { state.works = await window.desktop.listWorks(); $('work-count').textContent = state.works.length; renderWorks(); } catch (e) { $('works').replaceChildren(el('div', 'error', `无法读取 WSL：${e.message}`)); } }
function renderWorks() { $('works').replaceChildren(); if (!state.works.length) $('works').append(el('div', 'muted', '没有发现 work 根')); for (const work of state.works) { const button = el('button', `work-row ${state.work?.root === work.root ? 'selected' : ''}`); button.append(el('span', 'work-icon', work.kind === 'invalid' ? '!' : '▧')); const labels = el('span', 'work-labels'); labels.append(el('span', 'work-name', work.name), el('span', 'work-state', work.kind === 'invalid' ? '无效 · 请核查' : (work.state || '未标记'))); button.append(labels); button.addEventListener('click', () => selectWork(work)); $('works').append(button); } }
async function selectWork(work) {
  if ((state.running || state.starting) && state.work?.root !== work.root) { alert('请先关闭当前 OMP 会话，再切换工作根。'); return; }
  if ((terminalId || terminalStarting) && state.work?.root !== work.root) { alert('请先结束当前 WSL 终端，再切换工作根。'); return; }
  const changedWork = state.work?.root !== work.root;
  const selection = ++state.selection;
  state.work = work;
  if (changedWork) { state.preview = null; renderFilePreview(); }
  $('work-name').textContent = work.name; $('work-path').textContent = work.root; renderWorks(); syncControls();
  $('overview').replaceChildren(el('div', 'panel-title', '工作根')); $('overview').append(el('div', 'path-box', work.root));
  if (work.kind === 'invalid') { $('overview').append(el('div', 'error', work.error || '工作根验证失败')); return; }
  const buttons = el('div', 'stack');
  const start = el('button', 'primary-wide', state.running ? 'OMP 已启动' : '启动 OMP'); start.disabled = state.running || state.starting; start.onclick = () => startSession(null);
  const resume = el('button', 'outline-wide', '从文件导入 session…'); resume.disabled = state.running || state.starting; resume.onclick = async () => {
    const source = await window.desktop.chooseSession(); if (!source) return;
    if (!confirm('将把此 session 导入 Lucyna 的 Windows 管理目录，再从副本恢复。原文件不会修改；引用到原目录之外的附件可能无法复制。继续吗？')) return;
    resume.disabled = true; resume.textContent = '正在复制 session…'; $('connection').textContent = '正在导入副本';
    try {
      const imported = await window.desktop.importSession(source, work.root);
      if (imported?.warning) alert(`副本已导入，但有需要留意的项目：\n${imported.warning}`);
      await startSession(imported.sessionFile, imported.agentDir);
    } catch (e) { $('connection').textContent = '导入失败'; alert(e.message); }
    finally { resume.disabled = state.running || state.starting; resume.textContent = '从文件导入 session…'; }
  };
  buttons.append(start, resume);
  if (state.running) { const close = el('button', 'outline-wide', '关闭 OMP 会话'); close.onclick = () => window.desktop.close().catch(e => alert(e.message)); buttons.append(close); }
  const historyBox = el('section', 'history-box');
  const historyHeader = el('div', 'history-header'); historyHeader.append(el('div', 'panel-title', '历史 session'));
  const historyRefresh = el('button', 'secondary', '刷新'); const historyList = el('div', 'history-list');
  historyRefresh.onclick = () => loadHistory(work.root, selection, historyList);
  historyHeader.append(historyRefresh); historyBox.append(historyHeader, historyList);
  $('overview').append(buttons, el('div', 'hint', 'WSL 历史先导入为 Windows 管理的副本；已迁入的 session 可直接续聊。'), historyBox);
  loadHistory(work.root, selection, historyList);
  try { const content = await window.desktop.readWork(work.root); if (selection !== state.selection) return; const doc = el('div', 'document markdown'); markdown(doc, content); $('overview').append(el('div', 'divider'), el('div', 'panel-title', 'SESSION.md'), doc); }
  catch (e) { if (selection === state.selection) $('overview').append(el('div', 'error', e.message)); }
}
async function startSession(resume, agentDir) { if (state.starting || state.running) return; state.starting = true; $('connection').textContent = '启动中'; state.resume = resume; selectWork(state.work); try { await window.desktop.start({ root: state.work.root, resume, agentDir }); log('已启动 Windows OMP，等待 RPC ready'); } catch (e) { state.starting = false; $('connection').textContent = '启动失败'; log(e.message); alert(e.message); selectWork(state.work); } }
async function onReady() {
  $('messages').replaceChildren(); $('messages').hidden = true; $('empty').hidden = false; state.assistant = null;
  try {
    const result = await window.desktop.request('get_messages');
    for (const item of result?.messages || []) {
      const role = item.role || item.message?.role;
      const content = item.content ?? item.message?.content;
      if (['user', 'assistant', 'toolResult'].includes(role) && content != null) appendMessageContent(role === 'toolResult' ? 'tool' : role, content);
    }
  } catch (e) { log(`恢复历史：${e.message}`); }
  state.starting = false; state.running = true; $('connection').textContent = 'OMP 已连接'; syncControls();
  if (state.work) selectWork(state.work);
}
const dialogs = []; let dialogActive = false;
function uiRequest(event) { dialogs.push(event); showDialog(); }
function showDialog() { if (dialogActive || !dialogs.length) return; dialogActive = true; const event = dialogs.shift(); const m = $('modal'); $('modal-title').textContent = event.title || 'OMP 需要确认'; $('modal-message').textContent = event.message || ''; const options = $('modal-options'); options.replaceChildren(); const send = async value => { m.hidden = true; try { await window.desktop.respond({ type: 'extension_ui_response', id: event.id, ...value }); } catch (e) { log(e.message); } finally { dialogActive = false; showDialog(); } }; if (event.method === 'confirm') { const no = el('button','secondary','取消'); no.onclick = () => send({confirmed:false}); const yes = el('button','send','确认'); yes.onclick = () => send({confirmed:true}); options.append(no,yes); } else if (event.method === 'select') { for (const option of event.options || []) { const b=el('button','outline-wide',option); b.onclick=()=>send({value:option}); options.append(b); } const cancel=el('button','secondary','取消'); cancel.onclick=()=>send({cancelled:true}); options.append(cancel); } else if (['input','editor'].includes(event.method)) { const input=el('textarea','dialog-input'); options.append(input); const yes=el('button','send','提交'); yes.onclick=()=>send({value:input.value}); const no=el('button','secondary','取消'); no.onclick=()=>send({cancelled:true}); options.append(no,yes); } else if (event.method === 'ask') { const questions = event.questions || []; const forms = []; for (const question of questions) { const group = el('div', 'question'); group.append(el('strong', '', question.question || question.header || '请选择')); const inputs=[]; for (const option of question.options || []) { const label=el('label','question-option'); const input=document.createElement('input'); input.type=question.multi?'checkbox':'radio'; input.name=`q-${event.id}-${question.id}`; input.value=option.label; label.append(input,document.createTextNode(` ${option.label}${option.description ? ' — '+option.description : ''}`)); group.append(label); inputs.push(input); } const custom=el('input','question-custom'); custom.placeholder='其他回答（可选）'; group.append(custom); options.append(group); forms.push({question,inputs,custom}); } const no=el('button','secondary','取消'); no.onclick=()=>send({cancelled:true}); const yes=el('button','send','提交'); yes.onclick=()=>{ const answers=[]; for(const form of forms) { const selected=form.inputs.filter(i=>i.checked).map(i=>i.value); const custom=form.custom.value.trim(); if(!form.question.multi && custom && selected.length) { alert('单选题请选择选项或输入其他回答。'); return; } if(!form.question.multi && !custom && !selected.length) { alert('请回答每个问题。'); return; } answers.push({id:form.question.id,selectedOptions:selected,...(custom ? {customInput:custom} : {})}); } send({answers}); }; options.append(no,yes); } else { const close=el('button','secondary','取消'); close.onclick=()=>send({cancelled:true}); options.append(close); $('modal-message').textContent += `\n尚未支持的交互：${event.method}`; } m.hidden = false; }
window.desktop.onEvent(async event => { if (event.type === 'ready') { await onReady(); return; } if (event.type === 'process_exit' || event.type === 'process_error') { finishAssistantMessage(); state.starting=false; state.running=false; state.busy=false; $('connection').textContent='OMP 已退出'; syncControls(); log(event.message || `进程退出：${event.code}`); if(state.work) selectWork(state.work); return; } if (event.type === 'stderr' || event.type === 'diagnostic') { log(event.message); return; } if (event.type === 'extension_ui_request') { if (['confirm','select','input','editor','ask'].includes(event.method)) uiRequest(event); else if(event.method === 'notify') log(event.message || event.method); return; } if (event.type === 'agent_start') { state.busy=true; syncControls(); } if (event.type === 'agent_end' || event.type === 'prompt_result') { finishAssistantMessage(); state.busy=false; syncControls(); } if (event.type === 'command_output') { finishAssistantMessage(); appendMessage('assistant',event.text || ''); state.busy=false; syncControls(); } if (event.type === 'message_update') { const delta = event.assistantMessageEvent || event.delta || {}; if (typeof delta.delta === 'string' && (delta.type === 'text_delta' || !delta.type)) { if (!state.assistant) state.assistant=appendMessage('assistant',''); state.assistant.textContent += delta.delta; state.assistant.scrollIntoView({block:'end'}); } } if (event.type === 'tool_execution_start') { finishAssistantMessage(); appendMessage('tool', `${event.toolName || '工具'} · 执行中`); } if (event.type === 'tool_execution_end') log(`${event.toolName || '工具'} · ${event.isError ? '失败' : '完成'}`); });
$('send').onclick = async () => { const text=$('input').value.trim(); if(!text || !state.running) return; $('input').value=''; appendMessage('user',text); state.assistant=null; state.busy=true; syncControls(); try { await window.desktop.request('prompt',{message:text}); } catch(e) { state.busy=false; syncControls(); appendMessage('assistant',`请求失败：${e.message}`); } };
$('input').onkeydown = e => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send').click(); } };
$('stop').onclick = async () => { try { await window.desktop.request('abort'); } catch(e) { log(e.message); } };
$('refresh').onclick = loadWorks;
$('terminal').onclick = toggleTerminal;
$('terminal-fallback').onclick = () => window.desktop.terminal(state.work.root).catch(e => alert(e.message));
$('terminal-stop').onclick = stopEmbeddedTerminal;
$('terminal-hide').onclick = () => { $('terminal-drawer').hidden = true; };
window.addEventListener('resize', () => { if (!$('terminal-drawer').hidden && fitAddon) { try { fitAddon.fit(); } catch {} } });
$('preview-file').onclick = choosePreviewFile;
$('choose-preview').onclick = choosePreviewFile;
$('right-toggle').onclick = () => { $('right').classList.toggle('collapsed'); };
$('preview-web').onclick = () => { $('web-url').value = ''; $('web-modal').hidden = false; $('web-url').focus(); };
$('web-cancel').onclick = () => { $('web-modal').hidden = true; };
async function openWeb() { const url = $('web-url').value.trim(); if (!url) { $('web-url').focus(); return; } try { await window.desktop.openExternal(url); $('web-modal').hidden = true; } catch (e) { alert(e.message); } }
$('web-open').onclick = openWeb;
$('web-url').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); openWeb(); } if (e.key === 'Escape') $('web-modal').hidden = true; };
for(const tab of document.querySelectorAll('.tab')) tab.onclick=()=>setTab(tab.dataset.tab);
$('search').onclick=async()=>{ const q=$('query').value.trim(); if(!q) return; $('memory-result').textContent='正在查询…'; try { const result=await window.desktop.context(q); $('memory-result').textContent=(result.content || []).map(x=>x.text || '').join('\n') || '没有返回内容'; } catch(e) { $('memory-result').textContent=`查询失败：${e.message}`; } };
loadWorks();
