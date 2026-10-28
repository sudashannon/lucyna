import {useEffect, useState, useSyncExternalStore} from 'react';
import {api} from './api';
import {Workbench} from './workbench-store';
export type {Message} from './session-view';
export function useWorkbench() {
  const [store] = useState(() => new Workbench(api));
  useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {store.connect(); return () => store.dispose();}, [store]);
  return store.view();
}
