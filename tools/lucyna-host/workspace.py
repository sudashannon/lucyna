"""Daemon-owned file/Git operations; bridge loss never retries a write."""
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from pathlib import Path
import sys
import threading

if not getattr(sys,'frozen',False):
    source=Path(__file__).resolve().parents[2]/'src'
    if source.is_dir():sys.path.insert(0,str(source))
import git_workspace
import workspace_files

CAPABILITIES=['workspace.details','workspace.files.list','workspace.files.read','workspace.git.read','workspace.git']


class Workspace:
    def __init__(self,state,sessions):
        self.sessions=sessions
        self.git=git_workspace.GitWorkspace(Path(state)/'git',active=self.active)
        self.pool=ThreadPoolExecutor(max_workers=4,thread_name_prefix='git-workspace')
        self.pending={};self.lock=threading.RLock()

    def active(self,root):
        with self.sessions.lock:
            return any(row.record['root']==root and row.record['status'] in ('starting','live') for row in self.sessions.live.values())

    def dispatch(self,operation,args):
        if not isinstance(args,dict):raise ValueError('invalid_arguments')
        root=args.get('root')
        if operation=='workspace.files.list':return workspace_files.listing(root,args.get('directory',''),args.get('options'))
        if operation=='workspace.files.read':return workspace_files.read(root,args.get('reference'),args.get('basePath') or '')
        if operation=='workspace.details':return git_workspace.details.details(root)
        if operation=='workspace.git.read':
            action=args.get('action');options=args.get('options') or {}
            if action not in ('changes','diff','history','commit','compare','refs','worktrees'):raise ValueError('unsupported_operation')
            allowed={'scope','file','cursor','query','commit','base','target'}
            if set(options)-allowed:raise ValueError('invalid_arguments')
            if 'file' in options:options=dict(options,filename=options['file']);del options['file']
            return git_workspace.details.inspect_git(root,args.get('member'),action,**options)
        if operation!='workspace.git':raise ValueError('unsupported_operation')
        action=args.get('action');member=args.get('member');options=args.get('options') or {}
        if action in git_workspace.READS:
            result=self.git.dispatch(root,member,action,options)
            if action=='operation' and result.get('status')=='not-found':
                with self.lock:pending=self.pending.get(options.get('operationId'))
                if pending:
                    if pending['root']!=root or pending['member']!=member:raise ValueError('operation_conflict')
                    if not pending['future'].done():return dict(operationId=options['operationId'],status='queued')
                    return pending['future'].result()
            return result
        if action not in git_workspace.WRITES:raise ValueError('unsupported_operation')
        key=git_workspace.safe_text(options.get('operationId'),100)
        # Submit to the daemon, so a bridge timeout/exit cannot kill Git. The
        # worker persists its ID before writing. Repeated IDs do not run twice.
        with self.lock:
            previous=self.pending.get(key);fingerprint=git_workspace.canonical(args)
            if previous:
                if previous['fingerprint']!=fingerprint:raise ValueError('operation_conflict')
                if not previous['future'].done():return dict(operationId=key,status='running')
            if len(self.pending)>512:
                self.pending={k:v for k,v in self.pending.items() if not v['future'].done()}
            if len(self.pending)>=32:raise ValueError('workspace_busy')
            def execute():
                if action in git_workspace.LIFECYCLE:
                    with self.sessions.workspace_lock:return self.git.dispatch(root,member,action,options)
                return self.git.dispatch(root,member,action,options)
            future=self.pool.submit(execute);self.pending[key]=dict(future=future,root=root,member=member,fingerprint=fingerprint)
        try:return future.result(timeout=.05)
        except FutureTimeoutError:return dict(operationId=key,status='queued')
