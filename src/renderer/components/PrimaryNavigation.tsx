import {BookOpen, PanelsTopLeft} from 'lucide-react';
import '../primary-navigation.css';

export type Section = 'workbench' | 'knowledge';
const sections = [
  {id: 'workbench', label: '工作台', icon: PanelsTopLeft},
  {id: 'knowledge', label: '知识库', icon: BookOpen},
] as const;

export function PrimaryNavigation({section, expanded, vertical = false, onChange}: {
  section: Section;
  expanded: boolean;
  vertical?: boolean;
  onChange: (section: Section) => void;
}) {
  return <nav className={`primary-switcher ${expanded ? '' : 'is-compact'} ${vertical ? 'is-vertical' : ''}`} role="tablist" aria-label="主要功能" aria-orientation={expanded && !vertical ? 'horizontal' : 'vertical'}>
    {sections.map(({id, label, icon: Icon}, index) => {
      return <button key={id} id={`primary-tab-${id}`} role="tab" aria-controls={`primary-panel-${id}`} tabIndex={section === id ? 0 : -1}
        aria-label={`打开${label}`} aria-selected={section === id}
        title={label}
        onClick={() => onChange(id)}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1
            : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + sections.length) % sections.length;
          onChange(sections[next].id);
          (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
        }}>
        {expanded ? <>{vertical && <Icon size={19}/>}<span>{label}</span></> : <><Icon size={18}/><span className="primary-compact-label">{label}</span></>}
      </button>;
    })}
  </nav>;
}
