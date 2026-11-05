import {useEffect, useState} from 'react';
import {api} from './api';
import {errorText} from './errors';
import type {Work} from './types';
import type {GitInspection, GitReadOptions} from './work-detail-data';

export function useWorkspaceGitRead(work: Work, member: string, action: string, options: GitReadOptions, active: boolean, revision: number) {
  const key = JSON.stringify([work.root, work.hostId, member, action, options, revision]);
  const [result, setResult] = useState<{key: string; data?: GitInspection; error?: string}>();
  useEffect(() => {
    if (!active || !member || !action) return;
    let live = true;
    const timer = setTimeout(() => {
      void api.workGit(work.root, member, action, options, work.hostId).then(data => {
        if (live) setResult({key, data});
      }).catch(error => {
        if (live) setResult({key, error: errorText(error)});
      });
    }, options.query ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, active]);
  const current = result?.key === key ? result : undefined;
  return {
    data: current?.data,
    error: current?.error,
    busy: !!(active && member && action && !current),
  };
}
