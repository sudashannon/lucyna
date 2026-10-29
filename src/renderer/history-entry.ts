import type {HistoryEntry} from './types';

// Windows file names are case-insensitive; Linux paths retain their case even
// when accessed through either WSL UNC spelling.
export function historyFileKey(value=''){
  const file=value.replaceAll('\\','/');
  const drive=/^\/mnt\/([a-z])\/(.*)$/i.exec(file);
  if(drive)return `${drive[1]}:/${drive[2]}`.toLowerCase();
  const unc=/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)$/i.exec(file);
  if(unc)return 'wsl:'+unc[1];
  return file.startsWith('/')&&!file.startsWith('//')?'wsl:'+file:file.toLowerCase();
}
export function copiesHistory(entry:HistoryEntry,runtime:string,copy=false){
  return copy||!!entry.runtime&&entry.runtime!==runtime||!entry.sessionFile;
}
export function historyLabel(entry:HistoryEntry,runtime:string){
  const engine=entry.runtime==='windows'?'Windows OMP':'WSL OMP';
  const origin=entry.sourceKind==='native-wsl'?'WSL 原生'+(runtime==='wsl'?' · 原地续聊':''):entry.sourceKind==='native'?engine+(entry.runtime==='wsl'?' · Windows 历史存储':' · 客户端原生'):entry.importedAt||['windows','wsl'].includes(entry.sourceKind||'')?engine+' · 已有副本':entry.sessionFile?engine+' · 已有会话':'历史会话';
  return origin+(entry.runtime&&entry.runtime!==runtime?' · 将创建跨环境副本':'');
}
