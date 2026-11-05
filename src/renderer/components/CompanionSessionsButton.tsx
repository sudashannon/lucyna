import {BrandCompanions} from './BrandVisuals';
import {Tip} from '@cindy/components/ui/tooltip';

export function CompanionSessionsButton({active, count, onOpen, caption='活跃会话'}: {
  active: boolean;
  count: number;
  onOpen: () => void;
  caption?: string;
}) {
  const label = count ? `查看活跃会话 · ${count} 项任务动态` : '查看活跃会话';
  return <Tip text={label} side="right">
    <button type="button" className="companion-sessions" aria-label={label}
      aria-controls="workspace-content-sessions" aria-pressed={active} onClick={onOpen}>
      <BrandCompanions/>
      <span className="companion-session-caption">{caption}</span>
      {count > 0 && <span className="companion-session-count" aria-hidden="true">{count}</span>}
    </button>
  </Tip>;
}
