import type { Desktop } from './types';
export const previewMode = !window.desktop;
export const demoMode = window.desktop?.mode==='demo';
const unavailable = async (): Promise<any> => { throw new Error(previewMode?'这是浏览器中的界面预览。请在 Lucyna 桌面客户端使用此功能。':demoMode?'此演示窗口尚未接入这项功能。请在 Lucyna 客户端连接自己的工作区。':'当前窗口的客户端接口尚未就绪。请在运行任务结束后重新打开 Lucyna，已有会话和草稿会保留。'); };
// The browser preview is deliberately empty; it never fabricates a WSL or model connection.
const defaults: Desktop = {
  workRun:unavailable, workDetails:unavailable, workGit:unavailable, openExternal:unavailable,
  knowledgeCatalog: unavailable, knowledgeDocument: unavailable, knowledgeCandidates: unavailable, knowledgeReviews: unavailable, knowledgeImage: unavailable,
  knowledgeRequest:unavailable,knowledgeSaveFile:unavailable,onKnowledge:()=>()=>{},
  getSettings: unavailable, checkSettings: unavailable, saveSettings: unavailable,
  copyText: text => navigator.clipboard.writeText(text),
  listWorks: async () => [], readWork: unavailable, context: unavailable, start: unavailable,
  request: unavailable, respond: unavailable, close: unavailable, chooseSession: unavailable,
  listHistory: unavailable, previewHistoryDeletion:unavailable, deleteHistory:unavailable, restoreHistory:unavailable, importSession: unavailable, terminal: unavailable,
  startTerminal: unavailable, terminalInput: unavailable, terminalResize: unavailable, closeTerminal: unavailable,
  onTerminal: () => () => {}, onEvent: () => () => {}, choosePreview: unavailable, readPreview: unavailable, listFiles: unavailable, webPreview: unavailable,
};
// A partial or older preload must never leave a clickable action as undefined.
export const api: Desktop = {...defaults,...window.desktop};
for(const key of Object.keys(defaults) as (keyof Desktop)[]){if(typeof api[key]!=='function')(api as any)[key]=defaults[key];}
