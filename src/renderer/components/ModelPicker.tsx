import {useEffect, useState} from 'react';
import {Input} from '@cindy/components/ui/input';
import {Spinner} from '@cindy/components/ui/spinner';
import {Modal} from './Modal';
import {Check} from 'lucide-react';
import {useListNavigation} from '../useListNavigation';
import type {OmpEvent} from '../types';
export function ModelPicker({start, request, choose, onClose}: {start: () => Promise<void>; request:(type:string)=>Promise<OmpEvent>; choose: (provider: string, id: string) => Promise<void>; onClose: () => void}) {
  const [models, setModels] = useState<OmpEvent[]>([]), [filter, setFilter] = useState(''), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(''), [current, setCurrent] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => { let alive = true; setLoading(true); setError(''); void (async () => {try {await start(); const [result, state] = await Promise.all([request('get_available_models'), request('get_state')]); if (alive) {setModels(result.models || []); setCurrent(`${state.model?.provider}/${state.model?.id}`);}} catch (e) {if (alive) setError(String(e));} finally {if (alive) setLoading(false);}})(); return () => {alive = false;}; }, [start, request, revision]);
  const matches = models.filter(m => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(filter.toLowerCase()));
  const select = (model: OmpEvent) => {if (saving) return; setSaving(true); setError(''); void choose(model.provider, model.id).then(onClose).catch(e => setError(String(e))).finally(() => setSaving(false));};
  const navigation = useListNavigation(saving ? 0 : matches.length, filter, index => select(matches[index]));
  return <Modal open title="选择模型" description="读取 OMP 已配置的可用模型。" onClose={() => {if (!saving) onClose();}} className="command-palette">
    <Input autoFocus aria-label="搜索模型" placeholder="搜索模型或提供方…" value={filter} onChange={setFilter} onKeyDown={navigation.onKeyDown} role="combobox" aria-expanded={!loading} aria-controls="model-search-results" aria-activedescendant={matches.length ? `model-option-${navigation.activeIndex}` : undefined}/>
    {loading && <div className="inline-loading"><Spinner size={14}/>正在读取 OMP 模型…</div>}
    {error && <p role="alert" className="error-text">{error} <button className="text-action" disabled={loading || saving} onClick={() => setRevision(v => v + 1)}>重试</button></p>}
    <div className="palette-results" ref={navigation.listRef} id="model-search-results" role="listbox" aria-label="匹配的模型">{matches.map((m, index) => <button key={`${m.provider}/${m.id}`} id={`model-option-${index}`} role="option" aria-selected={index === navigation.activeIndex} aria-current={`${m.provider}/${m.id}` === current ? 'true' : undefined} onPointerMove={() => navigation.setSelected(index)} disabled={saving} onClick={() => select(m)}><span>{m.name || m.id}<small>{m.provider} / {m.id}</small></span>{`${m.provider}/${m.id}` === current && <><small>当前</small><Check size={14}/></>}</button>)}</div>
    {!loading && models.length > 0 && !matches.length && <p className="empty-line" role="status">没有匹配的模型，试试其他名称或提供方。</p>}
    {!loading && !models.length && !error && <p className="empty-line">OMP 尚未配置可用模型。</p>}
  </Modal>;
}
