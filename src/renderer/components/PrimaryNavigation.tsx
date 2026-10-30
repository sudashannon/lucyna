import {Activity, BookOpen, PanelsTopLeft} from 'lucide-react';
import '../primary-navigation.css';

export type Section = 'workbench' | 'knowledge' | 'sessions';
const sections = [
  {id: 'workbench', label: '工作台', icon: PanelsTopLeft},
  {id: 'knowledge', label: '知识库', icon: BookOpen},
  {id: 'sessions', label: '活跃会话', icon: Activity},
] as const;

export function PrimaryNavigation({section, expanded, count, onChange}: {
  section: Section;
  expanded: boolean;
  count: number;
  onChange: (section: Section) => void;
}) {
  return <nav className={`primary-switcher ${expanded ? '' : 'is-compact'}`} role="tablist" aria-label="主要功能" aria-orientation={expanded ? 'horizontal' : 'vertical'}>
    {sections.map(({id, label, icon: Icon}, index) => {
      const description = id === 'sessions' && count > 0 ? `${count} 个连接` : undefined;
      return <button key={id} id={`primary-tab-${id}`} role="tab" aria-controls={`primary-panel-${id}`} tabIndex={section === id ? 0 : -1}
        aria-label={`打开${label}`} aria-description={description} aria-selected={section === id}
        title={description ? `${label} · ${description}` : label}
        onClick={() => onChange(id)}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1
            : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + sections.length) % sections.length;
          onChange(sections[next].id);
          (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
        }}>
        {expanded ? label : <><Icon size={18}/><span className="primary-compact-label">{id === 'sessions' ? '会话' : label}</span></>}
        {id === 'sessions' && count > 0 && <span className="primary-count" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
      </button>;
    })}
  </nav>;
}
