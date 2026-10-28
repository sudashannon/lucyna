import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ExternalLink, RotateCw, Square, X } from 'lucide-react';
import { SidebarIconButton } from '@cindy/components/sidebar/SidebarIconButton';
import { api } from '../api';
type Phase = 'starting' | 'running' | 'closing' | 'ended' | 'error';
type Attempt = {id: string; phase: Phase; timer?: ReturnType<typeof setTimeout>};
export function TerminalPanel({root, visible, theme, onHide, onActive, onError}: {root: string; visible: boolean; theme: string; onHide: () => void; onActive: (active: boolean) => void; onError: (e: unknown) => void}) {
  const callbacks=useRef({onActive,onError,visible});callbacks.current={onActive,onError,visible};
  const host = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null), fit = useRef<FitAddon | null>(null), attempt = useRef<Attempt | null>(null);
  const startRef = useRef<(() => void) | null>(null), stopRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<{phase: Phase; label: string}>({phase: 'starting', label: '正在启动…'});
  useEffect(() => {
    let alive = true;
    const onActive=(active:boolean)=>callbacks.current.onActive(active),onError=(e:unknown)=>callbacks.current.onError(e);
    const t = new Terminal({fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-code'), fontSize: 12, cursorBlink: true, scrollback: 5000});
    const f = new FitAddon(); terminal.current = t; fit.current = f; t.loadAddon(f); t.open(host.current!);
    const ended = (current: Attempt, label: string) => {
      clearTimeout(current.timer);
      if (!alive || attempt.current !== current) return;
      attempt.current = null; onActive(false); setState({phase: 'ended', label});
    };
    const off = api.onTerminal(e => {
      const current = attempt.current;
      if (!alive || !current || e.id !== current.id) return;
      if (e.type === 'data') t.write(e.data);
      if (e.type === 'exit') ended(current, e.cancelled ? '已取消启动' : `已结束 · ${e.exitCode ?? ''}`);
    });
    const data = t.onData(value => { const current = attempt.current; if (current && current.phase !== 'closing') void api.terminalInput(current.id, value).catch(onError); });
    const resize = t.onResize(({cols, rows}) => { const current = attempt.current; if (current?.phase === 'running') void api.terminalResize(current.id, cols, rows).catch(onError); });
    const observer = new ResizeObserver(() => { if (host.current?.clientWidth && host.current?.clientHeight) f.fit(); }); observer.observe(host.current!);
    const stop = async () => {
      const current = attempt.current;
      if (!current || current.phase === 'closing') return;
      const previous = current.phase;
      current.phase = 'closing'; clearTimeout(current.timer); setState({phase: 'closing', label: previous === 'starting' ? '正在取消启动…' : '正在结束…'});
      try {
        await api.closeTerminal(current.id);
        ended(current, previous === 'starting' ? '已取消启动' : '已结束');
      } catch (e) {
        if (alive && attempt.current === current) {current.phase = previous; setState({phase: previous, label: '结束失败，可重试'}); onError(e);}
      }
    };
    const start = async () => {
      if (attempt.current) return;
      // Known before IPC so cancel/exit events can be correlated even if they
      // arrive before the start response. No shared pending-event buffer.
      const current: Attempt = {id: crypto.randomUUID(), phase: 'starting'};
      attempt.current = current; onActive(true); setState({phase: 'starting', label: '正在启动…'});
      current.timer = setTimeout(() => {if (alive && attempt.current === current && current.phase === 'starting') {onError(new Error('终端启动超时，正在取消；可以稍后重试')); void stop();}}, 45000);
      try {
        f.fit(); const result = await api.startTerminal(root, {cols: t.cols, rows: t.rows, requestId: current.id});
        clearTimeout(current.timer);
        if (!alive || attempt.current !== current) {void api.closeTerminal(result.id).catch(onError); return;}
        if (current.phase !== 'starting') return;
        current.phase = 'running'; setState({phase: 'running', label: 'WSL 终端'}); if(callbacks.current.visible)t.focus();
      } catch (e) {
        clearTimeout(current.timer);
        if (alive && attempt.current === current && current.phase !== 'closing') {attempt.current = null; onActive(false); setState({phase: 'error', label: '启动失败，可重试'}); onError(e);}
      }
    };
    startRef.current = () => {void start();}; stopRef.current = () => {void stop();}; void start();
    return () => {alive = false; off(); observer.disconnect(); data.dispose(); resize.dispose(); const current = attempt.current; attempt.current = null; if (current) {clearTimeout(current.timer); void api.closeTerminal(current.id).catch(onError);} t.dispose(); onActive(false);};
  }, [root]);
  useEffect(() => {
    if (!terminal.current) return;
    const styles = getComputedStyle(document.documentElement), color = (name: string) => styles.getPropertyValue(name).trim();
    terminal.current.options.theme = {background: color('--terminal-bg'), foreground: color('--terminal-fg'), cursor: color('--terminal-fg'), selectionBackground: color('--terminal-selection')};
    if (visible) { fit.current?.fit(); terminal.current.focus(); }
  }, [visible, theme]);
  return <section className="terminal-panel" hidden={!visible} aria-label="WSL 终端">
    <div className="terminal-header"><span role="status">{state.label}</span><span className="terminal-path">{root}</span><div className="spacer"/>
      <SidebarIconButton icon={ExternalLink} label="在独立 WSL 窗口中打开" onClick={() => void api.terminal(root).catch(onError)}/>
      <SidebarIconButton icon={RotateCw} label="重新连接终端" disabled={['starting', 'running', 'closing'].includes(state.phase)} onClick={() => startRef.current?.()}/>
      <SidebarIconButton icon={Square} label={state.phase === 'starting' ? '取消启动' : '结束终端'} disabled={!['starting', 'running'].includes(state.phase)} onClick={() => stopRef.current?.()}/>
      <SidebarIconButton icon={X} label="收起终端" onClick={onHide}/>
    </div><div className="terminal-host" ref={host}/>
  </section>;
}
