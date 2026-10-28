import {useEffect, useState} from 'react';
import {Check, Monitor, TerminalSquare, RefreshCw} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {Input} from '@cindy/components/ui/input';
import {Spinner} from '@cindy/components/ui/spinner';
import {Modal} from './Modal';
import {api} from '../api';
import {errorText} from '../errors';
import type {ClientSettings, EnvironmentCheck, SettingsInfo,PetSettings} from '../types';

export function SettingsDialog({onClose,onApply,locked,theme}: {onClose:()=>void; onApply:(settings:ClientSettings,theme:string,changed:boolean)=>Promise<void>; locked:boolean; theme:string}) {
  const [info,setInfo]=useState<SettingsInfo|null>(null),[draft,setDraft]=useState<ClientSettings|null>(null),[appearance,setAppearance]=useState(theme);
  const [error,setError]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[checking,setChecking]=useState(false),[check,setCheck]=useState<EnvironmentCheck|null>(null),[revision,setRevision]=useState(0);
  const [pet,setPet]=useState<PetSettings|null>(null),[initialPet,setInitialPet]=useState<PetSettings|null>(null),[petError,setPetError]=useState('');
  useEffect(()=>{let alive=true;void api.getPet?.().then(value=>{if(alive){setPet(value.settings);setInitialPet(value.settings);setPetError(value.warning);}}).catch(e=>{if(alive)setPetError(errorText(e));});return()=>{alive=false;};},[]);
  const petUpdate=(patch:Partial<PetSettings>)=>setPet(value=>value?{...value,...patch}:value);
  useEffect(()=>{let alive=true;setLoading(true);setError('');void api.getSettings().then(value=>{if(alive){setInfo(value);setDraft(value.settings);}}).catch(e=>{if(alive)setError(errorText(e));}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[revision]);
  const update=(patch:Partial<ClientSettings>)=>{setDraft(prev=>prev?{...prev,...patch}:prev);setCheck(null);setError('');};
  const changed=JSON.stringify(draft)!==JSON.stringify(info?.settings), disabled=saving||checking;
  const test=async()=>{if(!draft)return;setChecking(true);setError('');setCheck(null);try{setCheck(await api.checkSettings(draft));}catch(e){setError(errorText(e));}finally{setChecking(false);}};
  const save=async()=>{if(!draft)return;setSaving(true);setError('');try{await onApply(draft,appearance,changed);if(pet&&initialPet){const patch=Object.fromEntries(Object.entries(pet).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(initialPet[key as keyof PetSettings])));if(Object.keys(patch).length)await api.savePet?.(patch);}onClose();}catch(e){setError(errorText(e));}finally{setSaving(false);}};
  return <Modal open title="设置" description="选择 OMP 的运行环境，管理客户端偏好。" onClose={()=>{if(!disabled)onClose();}} className="settings-modal">
    {loading?<div className="inline-loading"><Spinner size={15}/>读取设置…</div>:!draft?<div className="settings-body"><p role="alert" className="error-text">{error}</p><Button onClick={()=>setRevision(x=>x+1)}>重新读取</Button></div>:<>
      <div className="settings-body">
        <section aria-labelledby="settings-runtime-title"><h3 id="settings-runtime-title">运行环境</h3><p className="settings-caption">代码与工作区保留在 WSL。WSL 新会话由原生 OMP 按 work 路径归档。</p>
          <div className="runtime-options" role="radiogroup" aria-label="OMP 运行环境" onKeyDown={event=>{
            if(disabled||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
            event.preventDefault();
            const next=event.key==='Home'?'wsl':event.key==='End'?'windows':draft.runtime==='wsl'?'windows':'wsl';
            update({runtime:next});event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next==='wsl'?0:1].focus();
          }}>
            {([{id:'wsl',name:'WSL OMP',description:'使用现有 Linux 配置、技能与扩展',Icon:TerminalSquare},{id:'windows',name:'Windows OMP',description:'使用客户端独立配置，兼容当前模式',Icon:Monitor}] as const).map(({id,name,description,Icon})=>
              <button type="button" role="radio" aria-checked={draft.runtime===id} tabIndex={draft.runtime===id?0:-1} key={id} disabled={disabled} className={draft.runtime===id?'selected':''} onClick={()=>update({runtime:id})}>
                <Icon size={19}/><span><strong>{name}</strong><small>{description}</small></span>{draft.runtime===id&&<Check size={15}/>}</button>)}
          </div>
          <div className="settings-environment">{info?.workspace.distro} · {info?.workspace.user}<small>当前支持的工作区：{info?.workspace.root}</small></div>
          {draft.runtime==='wsl'?<><label className="settings-field">WSL OMP 路径<Input aria-label="WSL OMP 路径" value={draft.wslExecutable} disabled={disabled} onChange={v=>update({wslExecutable:v})}/></label><label className="settings-field">WSL OMP 配置目录<Input aria-label="WSL OMP 配置目录" value={draft.wslAgentDir} disabled={disabled} onChange={v=>update({wslAgentDir:v})}/><small>直接交给原生 OMP 加载，不复制或合并整套配置。技能与扩展按该目录和项目配置发现。</small></label></>:<label className="settings-field">Windows OMP 路径<Input aria-label="Windows OMP 路径" value={draft.windowsExecutable} disabled={disabled} onChange={v=>update({windowsExecutable:v})}/><small>使用客户端独立 agent 目录，请在该目录中配置原生 OMP 的模型与认证。</small></label>}
          <Button variant="secondary" disabled={disabled} onClick={()=>void test()}>{checking?<Spinner size={13}/>:<RefreshCw size={13}/>}检测环境</Button>
          {check&&<div className="environment-result" role="status"><strong><Check size={14}/>{check.version} · 检测完成</strong>{check.configFiles.length>0&&<p>发现：{check.configFiles.join('、')}</p>}<small>{check.note}</small></div>}
        </section>
        <section aria-labelledby="settings-model-title"><h3 id="settings-model-title">模型与速度</h3><label className="settings-field">默认模型<Input aria-label="默认模型" placeholder="留空，跟随 OMP 默认模型" value={draft.model} disabled={disabled} onChange={v=>update({model:v})}/><small>可填写 provider/model。临时切换模型仍使用会话输入框旁的模型菜单。</small></label><label className="settings-field">思考强度<select aria-label="默认思考强度" value={draft.thinking} disabled={disabled} onChange={e=>update({thinking:e.target.value})}>{[['inherit','跟随 OMP 配置'],['off','关闭'],['minimal','最低'],['low','低'],['medium','中'],['high','高'],['xhigh','很高'],['max','最高'],['auto','自动']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><small>较低强度通常适合简单任务；支持情况和实际耗时取决于模型。仅对新连接生效。</small></label></section>
        <section><h3>外观</h3><label className="settings-field">主题<select aria-label="外观主题" value={appearance} disabled={disabled} onChange={e=>setAppearance(e.target.value)}><option value="light">浅色</option><option value="dark">深色</option></select></label></section>
        <section aria-labelledby="settings-pet-title" className="pet-settings"><h3 id="settings-pet-title">桌面伙伴</h3><p className="settings-caption">汇总原生 OMP 的状态与待办，不额外调用模型。保存后生效，无需重连会话。</p>{petError&&<p className="error-text" role="alert">{petError}</p>}{pet&&<>
          <label className="pet-option"><input type="checkbox" aria-label="启用桌面伙伴" checked={pet.enabled} disabled={disabled} onChange={e=>petUpdate({enabled:e.target.checked})}/>启用桌面伙伴</label>
          <div className="pet-settings-grid"><label className="settings-field">角色<select aria-label="桌宠角色" value={pet.appearance} disabled={disabled} onChange={e=>petUpdate({appearance:e.target.value as PetSettings['appearance']})}><option value="duo">女孩与黑猫</option><option value="cat">只显示黑猫</option></select></label><label className="settings-field">大小<select aria-label="桌宠大小" value={pet.size} disabled={disabled} onChange={e=>petUpdate({size:e.target.value as PetSettings['size']})}><option value="small">小</option><option value="medium">中</option><option value="large">大</option></select></label></div>
          {([['animated','播放角色逐帧动画'],['alwaysOnTop','始终显示在普通窗口前方'],['quiet','勿扰：只保留待办，不主动弹出'],['privacy','隐藏工作区与会话名称'],['reducedMotion','减少动态效果'],['closeToTray','关闭主窗口时收至托盘，保持任务运行'],['notifyCompletion','任务完成时提醒'],['notifyError','需要处理的错误提醒']] as const).map(([key,label])=><label className="pet-option" key={key}><input type="checkbox" aria-label={label} checked={pet[key]} disabled={disabled} onChange={e=>petUpdate({[key]:e.target.checked})}/>{label}</label>)}
          <div className="panel-buttons"><Button variant="secondary" disabled={disabled} onClick={()=>petUpdate({position:null})}>重置桌宠位置</Button><Button variant="secondary" disabled={disabled||!pet.pinnedSessionId} onClick={()=>petUpdate({pinnedSessionId:''})}>关注所有会话</Button></div>
          <p className="settings-caption">待机眨眼、工作操作终端、待办招手、完成庆祝；减少动态效果会暂停播放。点击角色查看待办，拖动移动。隐藏后可从托盘恢复；关闭此开关会移除桌宠。退出应用仍会结束客户端连接。</p>
        </>}</section>
        <section className="settings-storage"><h3>数据与回退</h3><p>{draft.runtime==='wsl'?`新会话保存在 ${draft.wslAgentDir}/sessions 下，由 OMP 根据当前 work 路径选择子目录；客户端不覆盖此路径。`:'Windows 会话使用客户端独立历史库。'}设置、草稿和旧版会话副本保存在下方 Windows 目录。已有会话继续使用原路径；跨模式继续时创建副本。</p><code>{info?.storage}</code><small>保存运行时设置会保留上一份 client-settings.json 备份。WSL 原生 OMP 仍自行管理其配置目录中的缓存和运行数据。</small></section>
      </div>
      <div className="settings-bottom">{error&&<p role="alert" className="error-text">{error}</p>}<div className="modal-actions"><span>{changed?'用于下一次新连接；已连接的会话继续运行。':'运行环境不变。'}</span><Button variant="secondary" disabled={disabled} onClick={onClose}>取消</Button><Button variant="cta" loading={saving} disabled={disabled} onClick={()=>void save()}>{changed?'保存默认设置':'保存'}</Button></div></div>
    </>}
  </Modal>;
}
