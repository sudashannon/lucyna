import type { Desktop } from './types';
export const previewMode = !window.desktop;
const unavailable = async (): Promise<any> => { throw new Error('这是浏览器中的界面预览。请在 OMP 桌面客户端使用此功能。'); };
// The browser preview is deliberately empty; it never fabricates a WSL or model connection.
const defaults: Desktop = {
  workRun:unavailable,
  knowledgeCatalog: unavailable, knowledgeDocument: unavailable, knowledgeCandidates: unavailable, knowledgeReviews: unavailable, knowledgeImage: unavailable,
  knowledgeRequest:unavailable,knowledgeSaveFile:unavailable,onKnowledge:()=>()=>{},
  getSettings: unavailable, checkSettings: unavailable, saveSettings: unavailable,
  copyText: text => navigator.clipboard.writeText(text),
  listWorks: async () => [], readWork: unavailable, context: unavailable, start: unavailable,
  request: unavailable, respond: unavailable, close: unavailable, chooseSession: unavailable,
  listHistory: unavailable, importSession: unavailable, terminal: unavailable,
  startTerminal: unavailable, terminalInput: unavailable, terminalResize: unavailable, closeTerminal: unavailable,
  onTerminal: () => () => {}, onEvent: () => () => {}, choosePreview: unavailable, readPreview: unavailable, listFiles: unavailable, webPreview: unavailable,
};
// Supply safe fallbacks when an already running window has an older preload.
export const api: Desktop = {...defaults,...window.desktop};
for(const key of Object.keys(defaults) as (keyof Desktop)[]){if(typeof api[key]!=='function')(api as any)[key]=defaults[key];}
