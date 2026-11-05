import {useEffect, useState} from 'react';
import {api} from './api';
import type {TurnChangeSummary} from './types';

const empty: TurnChangeSummary[] = [];

export function useTurnChanges(id: string, sessionFile: string, enabled: boolean) {
  const key = JSON.stringify([id, sessionFile]);
  const [snapshot, setSnapshot] = useState<{key: string; items: TurnChangeSummary[]}>();
  useEffect(() => {
    if (!enabled || !sessionFile || !api.listTurnChanges) return;
    let live = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      void api.listTurnChanges!(id).then(items => {
        if (live && revision === current) setSnapshot({key, items});
      }).catch(() => {});
    };
    const unsubscribe = api.onEvent(event => {
      if (event.clientSessionId === id && (event.type === 'turn_changes_ready' || event.type === 'session_state')) refresh();
    });
    refresh();
    return () => {live = false; unsubscribe();};
  }, [enabled, id, key, sessionFile]);
  return enabled && snapshot?.key === key ? snapshot.items : empty;
}
