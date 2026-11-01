import {useEffect,useState} from 'react';
import {Plus,Server,RefreshCw,Unplug} from 'lucide-react';
import {Button} from '@cindy/components/ui/button';
import {Input} from '@cindy/components/ui/input';
import {Spinner} from '@cindy/components/ui/spinner';
import {api} from '../api';
import {errorText} from '../errors';
import type {SshHost} from '../types';
import '../ssh-hosts.css';

const labels:Record<string,string>={disconnected:'未连接',probing:'检测 SSH',transferring:'正在上传远端组件',verifying:'正在校验安装',connecting:'正在连接 OMP 环境',ready:'已连接',reconnecting:'正在重连',error:'连接失败'};
const working=(phase='')=>['probing','transferring','verifying','connecting','reconnecting'].includes(phase);
const fresh=():SshHost=>({id:'',name:'',root:'',omp:'',agentDir:'',ssh:{destination:'',executor:{kind:'windows-openssh'}}});
export function HostSettings(){
  const [hosts,setHosts]=useState<SshHost[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [draft,setDraft]=useState<SshHost|null>(null),[saving,setSaving]=useState(false),[notice,setNotice]=useState('');
  const [removing,setRemoving]=useState('');
  useEffect(()=>{
    let alive=true;
    const load=()=>api.listHosts?.().then(items=>{if(alive)setHosts(items);}).catch(e=>{if(alive)setError(errorText(e));}).finally(()=>{if(alive)setLoading(false);});
    if(!api.listHosts){setLoading(false);setError('当前窗口尚未加载 SSH 主机接口，请在任务结束后重新打开客户端。');return;}
    void load();const off=api.onHosts?.(()=>void load());return()=>{alive=false;off?.();};
  },[]);
  const act=async(action:()=>Promise<unknown>)=>{setError('');setNotice('');try{await action();setHosts(await api.listHosts!());}catch(e){setError(errorText(e));}};
  const update=(patch:Partial<SshHost>)=>setDraft(value=>value?{...value,...patch}:value);
  const ssh=(patch:Partial<SshHost['ssh']>)=>setDraft(value=>value?{...value,ssh:{...value.ssh,...patch}}:value);
  const save=async()=>{
    if(!draft)return;setSaving(true);setError('');setNotice('');
    try{const saved=await api.saveHost!({...draft,id:draft.id||undefined});setDraft(null);setHosts(await api.listHosts!());setSaving(false);await api.connectHost!(saved.id);setNotice(`${saved.name} 已连接，可从左侧选择远端工作区。`);}
    catch(e){setError(errorText(e));}finally{setSaving(false);void api.listHosts!().then(setHosts).catch(()=>{});}
  };
  return <section data-settings-section="ssh" aria-labelledby="settings-ssh-title" className="ssh-settings">
    <div className="ssh-section-heading"><h3 id="settings-ssh-title">SSH 主机</h3><Button compact variant="secondary" disabled={!!draft||loading||!api.saveHost} onClick={()=>setDraft(fresh())}><Plus size={14}/>添加主机</Button></div>
    <p className="settings-caption">使用已配置的 SSH 连接。首次连接会自动安装远端组件，无需 Python；OMP 与模型配置沿用远端环境。</p>
    {error&&!hosts.some(host=>host.error===error)&&<p role="alert" className="error-text">{error}</p>}{notice&&<p role="status" className="settings-caption">{notice}</p>}
    {loading?<p className="inline-loading"><Spinner size={14}/>读取主机…</p>:!hosts.length&&!draft?<p className="ssh-empty">添加主机并填写远端工作目录，连接后即可在工作台开始会话。</p>:null}
    <ul className="ssh-host-list">{hosts.map(host=><li key={host.id} data-host-id={host.id}>
      <div className="ssh-host-identity"><Server size={17}/><div><strong>{host.name}</strong><span title={host.ssh.destination+' · '+host.root}>{host.ssh.destination} · {host.root}</span></div><span className="ssh-host-state" role="status">{working(host.phase)&&<Spinner size={12}/>} {labels[host.phase||'disconnected']||host.phase}</span></div>
      {host.error&&<p role="alert" className="error-text">{host.error}</p>}
      <div className="ssh-host-actions">{working(host.phase)?<Button compact variant="secondary" onClick={()=>void act(()=>api.cancelHost!(host.id))}>取消连接</Button>:host.phase==='ready'?<Button compact variant="secondary" onClick={()=>void act(()=>api.disconnectHost!(host.id))}><Unplug size={13}/>断开连接</Button>:<Button compact variant="secondary" onClick={()=>void act(()=>api.connectHost!(host.id))}><RefreshCw size={13}/>{host.installed?'重新连接':'连接并安装'}</Button>}
        {host.installed&&api.updateHost&&<Button compact variant="secondary" disabled={working(host.phase)} onClick={()=>void act(()=>api.updateHost!(host.id))}>更新主机组件</Button>}<Button compact variant="secondary" disabled={!!draft||working(host.phase)} onClick={()=>{setDraft(structuredClone(host));setError('');}}>编辑</Button><Button compact variant="secondary" disabled={working(host.phase)} onClick={()=>setRemoving(removing===host.id?'':host.id)}>移除</Button>
      </div>
      {removing===host.id&&<div className="ssh-remove"><p>仅移除客户端配置，远端安装与历史仍保留。未结束的远端会话需要先结束。</p><Button compact variant="secondary" onClick={()=>void act(async()=>{await api.removeHost!(host.id);setRemoving('');})}>移除主机配置</Button><Button compact variant="secondary" onClick={()=>setRemoving('')}>保留</Button></div>}
    </li>)}</ul>
    {draft&&<form className="ssh-host-form" onSubmit={event=>{event.preventDefault();void save();}}>
      <h4>{draft.id?'编辑 SSH 主机':'添加 SSH 主机'}</h4>
      <div className="ssh-field-grid"><label className="settings-field">主机名称<Input autoFocus aria-label="SSH 主机名称" required maxLength={80} value={draft.name} disabled={saving} onChange={name=>update({name})} placeholder="例如：开发服务器"/></label><label className="settings-field">SSH 目标<Input aria-label="SSH 目标" required value={draft.ssh.destination} disabled={saving} onChange={destination=>ssh({destination})} placeholder="SSH 别名或 user@hostname"/></label></div>
      <label className="settings-field">远端工作目录<Input aria-label="远端工作目录" required value={draft.root} disabled={saving} onChange={root=>update({root})} placeholder="/home/user/project"/><small>填写一个工作目录的绝对路径；目录与会话数据保留在远端。</small></label>
      <label className="settings-field">远端 OMP 路径<Input aria-label="远端 OMP 路径" value={draft.omp} disabled={saving} onChange={omp=>update({omp})} placeholder="留空，从远端登录环境查找 omp"/></label>
      <details><summary>更多连接选项</summary><div className="ssh-field-grid">
        <label className="settings-field">SSH 执行器<select aria-label="SSH 执行器" value={draft.ssh.executor.kind} disabled={saving} onChange={e=>ssh({executor:e.target.value==='wsl-openssh'?{kind:'wsl-openssh',distro:'Ubuntu-22.04',user:''}:{kind:'windows-openssh'}})}><option value="windows-openssh">Windows OpenSSH</option><option value="wsl-openssh">WSL OpenSSH</option></select></label>
        <label className="settings-field">SSH 端口<Input aria-label="SSH 端口" type="number" min={1} max={65535} value={String(draft.ssh.port||'')} disabled={saving} onChange={value=>ssh({port:value?Number(value):undefined})} placeholder="沿用 SSH 配置"/></label>
        {draft.ssh.executor.kind==='wsl-openssh'&&<><label className="settings-field">WSL 发行版<Input aria-label="SSH WSL 发行版" required value={draft.ssh.executor.distro||''} disabled={saving} onChange={distro=>ssh({executor:{...draft.ssh.executor,distro}})}/></label><label className="settings-field">WSL 用户<Input aria-label="SSH WSL 用户" required value={draft.ssh.executor.user||''} disabled={saving} onChange={user=>ssh({executor:{...draft.ssh.executor,user}})}/></label></>}
      </div><label className="settings-field">SSH 配置文件<Input aria-label="SSH 配置文件" value={draft.ssh.configFile||''} disabled={saving} onChange={value=>ssh({configFile:value||undefined})} placeholder="留空，使用默认 SSH 配置"/></label>
        <label className="settings-field">SSH 私钥文件路径<Input aria-label="SSH 私钥文件路径" value={draft.ssh.identityFile||''} disabled={saving} onChange={value=>ssh({identityFile:value||undefined})} placeholder="留空，使用 SSH 配置或 agent"/><small>路径应能由所选 SSH 执行器访问。密码与主机信任请先在 SSH 中配置。</small></label>
        <label className="settings-field">远端 OMP 配置目录<Input aria-label="远端 OMP 配置目录" value={draft.agentDir} disabled={saving} onChange={agentDir=>update({agentDir})} placeholder="留空，沿用远端 OMP 配置"/></label>
      </details>
      <p className="settings-caption">主机配置单独保存。断开 SSH 或退出客户端后，远端会话由主机服务持有；最后登录退出后的保活取决于主机配置。</p>
      <div className="panel-buttons"><Button type="submit" variant="cta" loading={saving} disabled={saving}>保存并连接</Button><Button type="button" variant="secondary" disabled={saving} onClick={()=>setDraft(null)}>取消编辑</Button></div>
    </form>}
  </section>;
}
