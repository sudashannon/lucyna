import {useState} from 'react';
import {Button} from '@cindy/components/ui/button';
import {Input} from '@cindy/components/ui/input';
import {api} from '../api';
import {errorText} from '../errors';
import type {AuxiliaryInput,AuxiliaryCheck} from '../types';

export function AuxiliarySettings({value,onChange,disabled,onChecking}:{value:AuxiliaryInput;onChange:(value:AuxiliaryInput)=>void;disabled:boolean;onChecking:(checking:boolean)=>void}){
  const [checking,setChecking]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<AuxiliaryCheck|null>(null);
  const update=(patch:Partial<AuxiliaryInput>)=>{onChange({...value,...patch});setError('');setResult(null);};
  const test=async()=>{if(!api.checkAuxiliary)return;setChecking(true);onChecking(true);setError('');setResult(null);try{setResult(await api.checkAuxiliary(value));}catch(e){setError(errorText(e));}finally{setChecking(false);onChecking(false);}};
  return <>
    <p className="settings-effect">用于自动命名，独立于 OMP 的 API 和会话模型。保存后立即用于后续命名。</p>
    <label className="settings-field">API 协议<select aria-label="辅助模型 API 协议" value={value.protocol} disabled={disabled} onChange={e=>update({protocol:e.target.value as AuxiliaryInput['protocol']})}><option value="chat-completions">Chat Completions（兼容接口）</option><option value="responses">Responses</option></select></label>
    <label className="settings-field">API 地址<Input aria-label="辅助模型 API 地址" placeholder="https://api.example.com/v1" value={value.baseURL} disabled={disabled} onChange={baseURL=>update({baseURL})}/><small>填写基础地址，通常以 /v1 结尾；无需填写 /chat/completions 或 /responses。</small></label>
    <label className="settings-field">API Key<Input aria-label="辅助模型 API Key" secret autoComplete="off" spellCheck={false} placeholder={value.hasApiKey&&!value.clearApiKey?'已配置，留空保留原密钥':'填写密钥；无需认证的本地服务可留空'} value={value.apiKey||''} disabled={disabled} onChange={apiKey=>update({apiKey,clearApiKey:false})}/><small>密钥加密保存在本机。连接测试会向上方地址发送一次简短请求。</small></label>
    {value.hasApiKey&&<label className="pet-option"><input type="checkbox" aria-label="清除已保存的辅助模型密钥" checked={!!value.clearApiKey} disabled={disabled} onChange={e=>update({clearApiKey:e.target.checked,apiKey:''})}/>保存时清除已有密钥</label>}
    <label className="settings-field">模型名称<Input aria-label="辅助模型名称" placeholder="填写服务提供的完整模型 ID" value={value.model} disabled={disabled} onChange={model=>update({model})}/><small>建议使用响应快、擅长概括的轻量模型。</small></label>
    <label className="settings-field">请求超时<select aria-label="辅助模型请求超时" value={value.timeoutSeconds} disabled={disabled} onChange={e=>update({timeoutSeconds:Number(e.target.value)})}>{[10,20,30,60,120].map(seconds=><option key={seconds} value={seconds}>{seconds} 秒</option>)}</select></label>
    <label className="pet-option"><input type="checkbox" aria-label="自动生成会话名称" checked={value.autoTitle} disabled={disabled} onChange={e=>update({autoTitle:e.target.checked})}/>自动生成会话名称</label>
    <p className="settings-caption">打开或恢复未命名的历史会话时自动补名；新会话在首轮有效回复后命名。仅发送有限长度的任务描述和回复摘要，已有名称始终保留。每次命名通常增加一次 API 调用。</p>
    <Button variant="secondary" loading={checking} disabled={disabled||!api.checkAuxiliary} onClick={()=>void test()}>测试辅助模型连接</Button>
    {error&&<p role="alert" className="error-text">{error}</p>}
    {result&&<div className="environment-result" role="status"><strong>辅助模型连接成功</strong><small>{result.model} · {result.elapsedMs} 毫秒 · 输入 {result.usage.inputTokens} / 输出 {result.usage.outputTokens} tokens</small></div>}
  </>;
}
