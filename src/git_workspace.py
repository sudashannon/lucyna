"""Bounded Git transactions shared by WSL and the frozen SSH host.

Git owns refs/index locks. Our common-dir lock only serializes Lucyna clients.
An operation ID is durable before any write; lost replies are queried, not replayed.
"""
from contextlib import contextmanager, nullcontext
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import signal
import sqlite3
import subprocess
import tempfile
import time
import threading
import socket
import shutil

_spec = importlib.util.spec_from_file_location('workspace_details', Path(__file__).with_name('work-details.py'))
details = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(details)
READS = {'snapshot', 'patches', 'network', 'operations', 'operation', 'acknowledge'}
WRITES = {'stage', 'unstage', 'stage-selection', 'unstage-selection', 'commit', 'fetch', 'push',
          'branch-create', 'branch-switch', 'branch-merge', 'worktree-create', 'worktree-move', 'worktree-remove'}
LIFECYCLE = {x for x in WRITES if x.startswith(('branch-', 'worktree-'))}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_text(value, limit=4096):
    if not isinstance(value, str) or len(value) > limit or '\0' in value:
        raise ValueError('无效 Git 参数')
    return value


def command(member, *args, env=None, data=None, timeout=150, accepted=(0,),progress=None):
    # External tools use the user's Git configuration; frozen Python variables
    # must not leak into credential helpers, hooks, SSH or signing programs.
    external = {k: v for k, v in os.environ.items() if not k.startswith(('PYTHON', '_PYI', 'GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE'))}
    if 'LD_LIBRARY_PATH_ORIG' in external:external['LD_LIBRARY_PATH']=external['LD_LIBRARY_PATH_ORIG']
    elif '_PYI_APPLICATION_HOME_DIR' in os.environ:external.pop('LD_LIBRARY_PATH',None)
    external.update(GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0', NO_COLOR='1', SSH_ASKPASS_REQUIRE='never')
    if env:
        external.update(env)
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p = subprocess.Popen(['git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', str(member), *args],
                             stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                             stdout=out, stderr=err, env=external, start_new_session=True)
        monitor=None;finished=threading.Event()
        if progress:
            def report():
                while not finished.wait(.5):
                    size=os.fstat(err.fileno()).st_size
                    if size:
                        value=os.pread(err.fileno(),min(size,3000),max(0,size-3000)).decode('utf-8','replace')
                        value=re.sub(r'(https?://)[^/@\s]+@',r'\1[已隐藏]@',value)
                        value=re.sub(r'([?&](?:token|access_token|password)=)[^&\s]+',r'\1[已隐藏]',value,flags=re.I)
                        try:progress(value.strip()[-2000:])
                        except Exception:pass  # progress cannot decide the Git result
            monitor=threading.Thread(target=report,daemon=True);monitor.start()
        try:
            p.communicate(data, timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGTERM)
            try: p.wait(3)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL); p.wait()
            raise TimeoutError('Git 操作超时，请核对操作结果，不要重复提交或推送') from None
        finally:
            finished.set()
            if monitor:monitor.join(2)
        out.seek(0); err.seek(0)
        output = out.read(512*1024+1); error = err.read(12000).decode('utf-8', 'replace')
        # Never echo URL passwords/tokens into the operation history.
        error = re.sub(r'(https?://)[^/@\s]+@', r'\1[已隐藏]@', error)
        error = re.sub(r'([?&](?:token|access_token|password)=)[^&\s]+',r'\1[已隐藏]',error,flags=re.I)
        if p.returncode not in accepted:
            raise ValueError(error.strip() or 'Git 操作失败')
        if len(output) > 512*1024:
            raise ValueError('Git 输出过大，请缩小范围')
        return output


def text(member, *args, **kwargs):
    return command(member, *args, **kwargs).decode('utf-8', 'strict').strip()


def optional(member, *args):
    try: return text(member, *args)
    except ValueError: return ''


def git_path(member, name):
    return (member / text(member, 'rev-parse', '--git-path', name)).resolve()


def index_hash(member):
    p = git_path(member, 'index')
    return digest(p.read_bytes()) if p.exists() else 'absent'


def filename(member, value):
    safe_text(value)
    p = Path(value)
    if not value or p.is_absolute() or '..' in p.parts or str(p) != value or value.startswith('.git/') or value == '.git':
        raise ValueError('只能操作成员工作树内的文件')
    # Git can safely stage a symlink itself; never dereference an escaping parent.
    if not (member / p).parent.resolve().is_relative_to(member):
        raise ValueError('文件父目录指向工作树之外')
    if any(0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ValueError('此文件名无法无损编码，不开放写操作')
    return value


def file_hash(member, value):
    p = member / filename(member, value)
    if p.is_symlink(): return digest(os.fsencode(os.readlink(p)))
    if not p.exists(): return 'deleted'
    if not p.is_file(): return 'directory'
    h = hashlib.sha256()
    with p.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()+':'+str(p.stat().st_mode)


def snapshot(member, meta, file=''):
    before = index_hash(member)
    head = optional(member, 'rev-parse', '--verify', 'HEAD')
    ref = optional(member, 'symbolic-ref', '-q', 'HEAD')
    raw = command(member, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
    # Invalid UTF-8 paths stay inspectable by the legacy reader, never writable.
    try:raw.decode('utf-8', 'strict')
    except UnicodeDecodeError:raise ValueError('仓库包含非 UTF-8 文件名，请在终端处理；界面暂不开放写操作') from None
    state = dict(worktree=str(member),common=str((member/text(member,'rev-parse','--git-common-dir')).resolve()),
                 head=head, ref=ref, index=before, status=digest(raw), file=file,
                 content=file_hash(member, file) if file else '', registration=digest(canonical(meta).encode()))
    if index_hash(member) != before or optional(member, 'rev-parse', '--verify', 'HEAD') != head:
        raise ValueError('仓库正在变化，请刷新后重试')
    current = details.status(member)
    busy = [name for name in ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply') if git_path(member, name).exists()]
    return dict(kind='snapshot', token=digest(canonical(state).encode()), head=head, ref=ref, index=before,
                counts=current['counts'], files=current['files'], truncated=current['truncated'],
                busy=busy, checkedAt=details.now(), file=file)


def patch_catalog(member, meta, file, scope):
    file = filename(member, file)
    if scope not in ('staged', 'unstaged'): raise ValueError('此范围不能部分暂存')
    snap = snapshot(member, meta, file)
    current = next((f for f in snap['files'] if f['path'] == file), None)
    if not current or current['conflict'] or current['untracked'] or current.get('oldPath') or not (member/file).is_file() or (member/file).is_symlink():
        return dict(kind='patches', snapshot=snap, hunks=[], reason='此文件只支持文件级操作')
    raw = command(member, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=3',
                  *(['--cached'] if scope == 'staged' else []), '--', ':(literal)'+file)
    if len(raw) > 256*1024: return dict(kind='patches', snapshot=snap, hunks=[], reason='差异过大，只支持文件级操作')
    value = raw.decode('utf-8', 'strict')
    if any(x in value for x in ('GIT binary patch', 'Binary files ', '\nold mode ', '\nnew mode ', '\nnew file mode ', '\ndeleted file mode ')):
        return dict(kind='patches', snapshot=snap, hunks=[], reason='文件类型或属性变化，只支持文件级操作')
    lines = value.splitlines(keepends=True)
    starts = [i for i, row in enumerate(lines) if row.startswith('@@ ')]
    hunks = []
    for n, start in enumerate(starts):
        body = lines[start:starts[n+1] if n+1<len(starts) else len(lines)]
        rows = [dict(id=f'{n}:{i}', text=row.rstrip('\n'), kind='add' if row.startswith('+') else 'delete')
                for i, row in enumerate(body[1:], 1) if row.startswith(('+', '-'))]
        hunks.append(dict(id=str(n), header=body[0].rstrip('\n'), lines=rows))
    if snapshot(member, meta, file)['token'] != snap['token']: raise ValueError('差异已变化，请刷新')
    return dict(kind='patches', snapshot=snap, hunks=hunks, _lines=lines, _starts=starts)


def selected_patch(catalog, selection, reverse=False):
    if not isinstance(selection, list) or not selection or len(selection)>6000 or any(not isinstance(x, str) for x in selection):
        raise ValueError('请选择差异中的块或行')
    valid = {line['id'] for h in catalog['hunks'] for line in h['lines']}
    chosen = set(selection)
    if not chosen <= valid: raise ValueError('差异选区已过期')
    lines, starts = catalog['_lines'], catalog['_starts']
    output = lines[:starts[0]]; offset = 0
    for n, start in enumerate(starts):
        body = lines[start:starts[n+1] if n+1<len(starts) else len(lines)]
        if not any(f'{n}:{i}' in chosen for i in range(1,len(body))): continue
        match = re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', body[0])
        if not match: raise ValueError('无法安全解析差异块')
        oldstart, oldcount, newstart, newcount = int(match[1]), int(match[2] or 1), int(match[3]), int(match[4] or 1)
        rows = []; cursor = 1
        # Pair replacement rows before restoring unselected lines as context.
        # Otherwise selecting the first replacement of a multi-line edit moves
        # its addition below every unselected deletion in the same edit group.
        while cursor < len(body):
            row=body[cursor]
            if not row.startswith(('+','-')):
                rows.append(row);cursor+=1;continue
            deleted=[];added=[]
            while cursor<len(body) and body[cursor].startswith(('+','-','\\')):
                row=body[cursor]
                if row.startswith('\\'):
                    target=added if added else deleted
                    if target:target[-1][1]+=row
                else:(deleted if row.startswith('-') else added).append([cursor,row])
                cursor+=1
            for i in range(max(len(deleted),len(added))):
                old=deleted[i] if i<len(deleted) else None;new=added[i] if i<len(added) else None
                old_selected=old and f'{n}:{old[0]}' in chosen;new_selected=new and f'{n}:{new[0]}' in chosen
                if reverse:
                    if old_selected:rows.extend(old[1].splitlines(keepends=True))
                    if new:rows.extend((new[1] if new_selected else ' '+new[1][1:]).splitlines(keepends=True))
                else:
                    if old:rows.extend((old[1] if old_selected else ' '+old[1][1:]).splitlines(keepends=True))
                    if new_selected:rows.extend(new[1].splitlines(keepends=True))
        oldn = sum(r.startswith((' ', '-')) for r in rows)
        newn = sum(r.startswith((' ', '+')) for r in rows)
        if reverse:
            newpos = newstart; oldpos = newpos-offset
            if newn==0: oldpos+=1
            if oldn==0: oldpos=max(0,oldpos-1)
        else:
            oldpos = oldstart; newpos = oldpos+offset
            if oldn==0: newpos+=1
            if newn==0: newpos=max(0,newpos-1)
        output += [f'@@ -{oldpos},{oldn} +{newpos},{newn} @@\n', *rows]
        offset += newn-oldn
    return ''.join(output).encode('utf-8')


@contextmanager
def frozen_index(member):
    directory = git_path(member, 'index').parent
    with tempfile.TemporaryDirectory(prefix='lucyna-index-', dir=directory) as temporary:
        index = Path(temporary)/'index'
        original = git_path(member, 'index')
        if original.exists(): shutil.copy2(original,index)
        else: command(member, 'read-tree', '--empty', env={'GIT_INDEX_FILE':str(index)})
        yield index, {'GIT_INDEX_FILE':str(index)}


def install_index(member, index, expected, meta, file):
    original = git_path(member, 'index'); lock = Path(str(original)+'.lock')
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        if snapshot(member, meta, file)['token'] != expected: raise ValueError('仓库已变化，请重新审查后操作')
        with os.fdopen(descriptor, 'wb') as stream:
            descriptor = None; stream.write(index.read_bytes()); stream.flush(); os.fsync(stream.fileno())
        os.replace(lock, original)
    finally:
        if descriptor is not None: os.close(descriptor)
        lock.unlink(missing_ok=True)


def commit_frozen(member, snap, message):
    safe_text(message, 20000)
    if not message.strip(): raise ValueError('请填写提交信息')
    if snap['busy']: raise ValueError('仓库有合并或变基正在进行，请先在终端完成')
    if not snap['counts']['staged'] or snap['counts']['conflicts']: raise ValueError('请先暂存文件并解决冲突')
    with frozen_index(member) as (index, env):
        if digest(index.read_bytes())!=snap['index']:raise ValueError('暂存区在冻结前已变化，请重新审查')
        expected_tree = text(member, 'write-tree', env=env)
        hooks = git_path(member, 'hooks')
        with tempfile.TemporaryDirectory(prefix='lucyna-hooks-') as folder:
            wrapper = Path(folder)
            if hooks.is_dir():
                for hook in hooks.iterdir():
                    if hook.is_file(): (wrapper/hook.name).symlink_to(hook)
            # Preserve every normal hook. These three also enforce the reviewed
            # tree and parent after the original hook, before Git updates refs.
            for name in ('pre-commit', 'prepare-commit-msg', 'commit-msg'):
                p = wrapper/name; p.unlink(missing_ok=True)
                hook = hooks/name
                original = shlex.quote(str(hook))+' "$@" || exit $?\n' if hook.is_file() and os.access(hook, os.X_OK) else ''
                guard = ('test "$(git write-tree)" = '+shlex.quote(expected_tree)+' || { echo "hooks 改变了审阅的暂存内容，提交已停止" >&2; exit 1; }\n'
                         'test "$(git rev-parse --verify HEAD 2>/dev/null || true)" = '+shlex.quote(snap['head'])+' || { echo "HEAD 已变化，提交已停止" >&2; exit 1; }\n')
                p.write_text('#!/bin/sh\n'+original+guard, encoding='utf-8'); p.chmod(0o700)
            command(member, '-c', 'core.hooksPath='+str(wrapper), 'commit', '--file=-', env=env, data=message.encode())
        oid = text(member, 'rev-parse', 'HEAD')
        tree, parents = text(member, 'show', '-s', '--format=%T%n%P', oid).split('\n',1) if snap['head'] else (text(member,'show','-s','--format=%T',oid), '')
        if tree != expected_tree or parents != snap['head']:
            raise TimeoutError('提交已经执行，但结果与审阅内容不一致，请核对 HEAD；不会自动重试')
        # Leave the original index alone: its tree was the committed tree, plus
        # any independent staging performed while hooks/signing were running.
        return dict(commit=oid, tree=tree, parent=snap['head'], message='提交完成')


def network(member):
    rows=[]
    for remote in text(member, 'remote').splitlines():
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', remote): continue
        rows.append(dict(name=remote))
    return dict(kind='network', remotes=rows, upstream=optional(member,'rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}'),
                aheadBehind=optional(member,'rev-list','--left-right','--count','HEAD...@{upstream}'))


def branch_name(member, name):
    safe_text(name,200)
    if name.startswith('-'): raise ValueError('无效分支名称')
    command(member,'check-ref-format','--branch',name)
    return name


class GitWorkspace:
    def __init__(self, state=None, active=lambda root:False, admission=lambda root:nullcontext()):
        self.state = Path(state or os.environ.get('LUCYNA_GIT_STATE', Path.home()/'.local/state/lucyna/git'))
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.active = active
        self.admission = admission
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, identity TEXT, request TEXT, status TEXT, result TEXT, updated REAL)')

    def db(self):
        db=sqlite3.connect(self.state/'operations.sqlite', timeout=20)
        db.execute('PRAGMA synchronous=FULL')
        return db

    def record(self, id):
        with self.db() as db:
            row=db.execute('SELECT identity,request,status,result,updated FROM operations WHERE id=?',(id,)).fetchone()
        if not row:return None
        result=json.loads(row[3]);status=row[2]
        if status in ('queued','running'):
            with (self.state/(id+'.worker')).open('a+b') as worker:
                try:fcntl.flock(worker,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:pass
                else:
                    status='uncertain';result={**result,'message':'执行进程已经中断，请核对真实仓库状态；此操作不会自动重放'}
                    self.update(id,status,result)
        return dict(operationId=id, identity=json.loads(row[0]), action=json.loads(row[1])['action'], status=status, result=result, updatedAt=row[4])

    def update(self, id, status, result):
        with self.db() as db: db.execute('UPDATE operations SET status=?,result=?,updated=? WHERE id=?',(status,canonical(result),time.time(),id))

    def dispatch(self, root, name, action, options=None):
        options=options or {}
        if not isinstance(options,dict):raise ValueError('无效 Git 参数')
        root=details.work_root(root)
        if action in ('operation','acknowledge','operations'):
            if action=='operations':
                with self.db() as db:ids=[row[0] for row in db.execute("SELECT id FROM operations WHERE json_extract(identity,'$.root')=? AND json_extract(identity,'$.member')=? ORDER BY updated DESC LIMIT 30",(str(root),name))]
                return dict(kind='operations',operations=[r for id in ids if (r:=self.record(id))['identity']['root']==str(root) and r['identity']['member']==name][:30])
            id=safe_text(options.get('operationId'),100)
            if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}',id):raise ValueError('无效操作标识')
            r=self.record(id)
            if r and (r['identity']['root']!=str(root) or r['identity']['member']!=name):raise ValueError('操作不属于当前仓库')
            if action=='acknowledge' and r and r['status']=='uncertain':
                self.update(id,'reviewed',{**r['result'],'message':'用户已核对仓库状态，操作限制已解除'})
                r=self.record(id)
            return r or dict(status='not-found')
        member,meta=details.member_path(root,name)
        identity=dict(root=str(root),member=name,repo=str(member),common=str((member/text(member,'rev-parse','--git-common-dir')).resolve()))
        file=options.get('file',''); scope=options.get('scope','unstaged')
        if file:filename(member,file)
        if action=='snapshot': return snapshot(member,meta,file)
        if action=='patches': return {k:v for k,v in patch_catalog(member,meta,file,scope).items() if not k.startswith('_')}
        if action=='network':return network(member)
        if action not in WRITES: raise ValueError('不支持的 Git 操作')
        id=options.get('operationId')
        if not isinstance(id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}',id):raise ValueError('操作缺少有效标识')
        request=canonical(dict(action=action,options=options))
        with (self.state/(id+'.worker')).open('a+b') as worker:
            # A second request waits only for this operation's worker, then
            # returns its persisted result, never another execution.
            fcntl.flock(worker,fcntl.LOCK_EX)
            with self.db() as db:
                row=db.execute('SELECT identity,request FROM operations WHERE id=?',(id,)).fetchone()
                if row:
                    if row!=(canonical(identity),request):raise ValueError('同一操作标识的参数发生变化')
                    return self.record(id)
                pending=[r[0] for r in db.execute("SELECT id FROM operations WHERE identity=? AND status IN ('running','queued','uncertain')",(canonical(identity),))]
            for previous in pending:
                if self.record(previous)['status']=='uncertain':raise ValueError('此仓库有待核对的操作，请先核对结果并解除限制')
            with self.db() as db:db.execute('INSERT INTO operations VALUES (?,?,?,?,?,?)',(id,canonical(identity),request,'queued','{}',time.time()))
            return self.perform(root,member,meta,action,options,identity,id)

    def perform(self,root,member,meta,action,options,identity,id):
        file=options.get('file','')
        common=Path(identity['common'])
        try:
            # Held by a live worker; process death releases it. An interrupted
            # operation record is never re-executed by a repeated request.
            with (common/'lucyna-workspace.lock').open('a+b') as lock, self.admission(str(root)) if action in LIFECYCLE else nullcontext():
                fcntl.flock(lock,fcntl.LOCK_EX)
                snap=snapshot(member,meta,file)
                self.update(id,'running',dict(before=dict(head=snap['head'],ref=snap['ref'],index=snap['index'])))
                if options.get('expected')!=snap['token']: raise ValueError('仓库已变化，请刷新并重新审查后操作')
                if snap['busy'] and action not in ('stage','unstage'):raise ValueError('仓库有未完成的合并或变基，请先在终端处理')
                if action in LIFECYCLE and self.active(str(root)):raise ValueError('此 Work 仍有活动会话或后台任务，请先结束后再管理分支或工作树')
                result=self.execute(root,member,meta,action,options,snap,
                                    progress=lambda message:self.update(id,'running',dict(progress=message,before=dict(head=snap['head'],ref=snap['ref'],index=snap['index']))))
                self.update(id,'completed',result)
        except TimeoutError as error:self.update(id,'uncertain',dict(message=str(error)))
        except Exception as error:
            changed=False
            if 'snap' in locals():
                try:
                    if action=='commit':changed=optional(member,'rev-parse','--verify','HEAD')!=snap['head'] or optional(member,'symbolic-ref','-q','HEAD')!=snap['ref']
                    else:changed=(not member.exists() or snapshot(member,meta,file)['token']!=snap['token'])
                except Exception:changed=True
                if action.startswith('worktree-') and options.get('name'):changed=changed or (root/'repos'/options['name']).exists()
            self.update(id,'uncertain' if changed else 'failed',dict(message=('操作期间仓库发生变化，请核对结果：' if changed else '')+str(error)))
        return self.record(id)

    def execute(self,root,member,meta,action,o,snap,progress=None):
        file=o.get('file','')
        if action in ('stage','unstage','stage-selection','unstage-selection'):
            file=filename(member,file)
            row=next((f for f in snap['files'] if f['path']==file),None)
            if not row:raise ValueError('文件已不在改动列表中')
            if row['conflict']:raise ValueError('请先在终端解决冲突')
            with frozen_index(member) as (index,env):
                if snap['index']!='absent' and digest(index.read_bytes())!=snap['index']:raise ValueError('暂存区在冻结前已变化，请重新审查')
                if action.endswith('-selection'):
                    scope='staged' if action.startswith('unstage') else 'unstaged'
                    catalog=patch_catalog(member,meta,file,scope)
                    if catalog['snapshot']['token']!=snap['token'] or not catalog['hunks']:raise ValueError(catalog.get('reason','差异已变化'))
                    patch=selected_patch(catalog,o.get('selection'),reverse=scope=='staged')
                    args=['apply','--cached','--recount',*(['--reverse'] if scope=='staged' else [])]
                    command(member,*args,'--check','-',env=env,data=patch)
                    command(member,*args,'-',env=env,data=patch)
                elif action=='stage':
                    paths=[file]+([row['oldPath']] if row.get('oldPath') else [])
                    # A copied index must not turn a racy-clean entry into a
                    # trusted stat-cache hit. Explicit tracked-file staging
                    # reads its content even on coarse-timestamp filesystems.
                    renormalize=not row['untracked'] and not row.get('oldPath') and (member/file).is_file() and not (member/file).is_symlink()
                    command(member,'add',*(['--renormalize'] if renormalize else []),'--',*[':(literal)'+p for p in paths],env=env)
                elif snap['head']:
                    paths=[file]+([row['oldPath']] if row.get('oldPath') else [])
                    command(member,'reset','-q','HEAD','--',*[':(literal)'+p for p in paths],env=env)
                else: command(member,'update-index','--force-remove','--',file,env=env)
                install_index(member,index,o['expected'],meta,file)
            return dict(message='暂存区已更新')
        if action=='commit':return commit_frozen(member,snap,o.get('message',''))
        if action in ('fetch','push'):
            remote=safe_text(o.get('remote',''),100)
            if remote not in [r['name'] for r in network(member)['remotes']]:raise ValueError('请选择仓库已配置的远端')
            if action=='fetch':
                try:command(member,'fetch','--atomic','--progress','--',remote,timeout=180,progress=progress)
                except ValueError as error:raise TimeoutError('获取未确认，请核对远端引用后再继续：'+str(error)) from None
                return dict(message='获取完成')
            if not snap['ref'].startswith('refs/heads/'):raise ValueError('分离 HEAD 不能直接推送')
            target=branch_name(member,o.get('branch',''))
            oid=snap['head']; ref='refs/heads/'+target
            try:command(member,'push','--porcelain','--progress','--',remote,oid+':'+ref,timeout=180,progress=progress)
            except ValueError as error:raise TimeoutError('推送结果未确认，请核对远端分支后再继续：'+str(error)) from None
            actual=text(member,'ls-remote','--refs','--',remote,ref).split()
            if not actual or actual[0]!=oid:raise TimeoutError('推送已返回，但远端引用尚未核对，请检查远端')
            return dict(message='推送完成并已核对远端',commit=oid,remote=remote,ref=ref)
        if action in LIFECYCLE:
            return self.lifecycle(root,member,meta,action,o,snap)
        raise ValueError('不支持的 Git 操作')

    def lifecycle(self,root,member,meta,action,o,snap):
        if snap['truncated'] or snap['files']:raise ValueError('请先提交或处理当前工作树的改动')
        original=(root/'work.json').read_bytes();manifest=json.loads(original)
        index=next(i for i,m in enumerate(manifest['members']) if m['name']==meta['name'])
        branch=o.get('branch','')
        result=dict(message='操作完成')
        if action.startswith('branch-'):
            branch=branch_name(member,branch)
            if action=='branch-create':command(member,'branch','--',branch,snap['head'])
            elif action=='branch-switch':
                command(member,'switch','--no-guess','--',branch)
                manifest['members'][index]['branch']=branch
            else:
                oid=details.resolve_commit(member,'refs/heads/'+branch)
                command(member,'merge','--ff-only','--',oid)
            result['branch']=branch
        else:
            newname=o.get('name','')
            if action!='worktree-remove':
                if not isinstance(newname,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}',newname):raise ValueError('无效成员名称')
                target=root/'repos'/newname
                if target.exists() or target.is_symlink() or any(m['name']==newname for m in manifest['members']):raise ValueError('目标成员或目录已经存在')
            if action=='worktree-create':
                branch=branch_name(member,branch)
                command(member,'worktree','add','-b',branch,'--',str(target),snap['head'])
                manifest['members'].append(dict(name=newname,path='repos/'+newname,repo=meta['repo'],branch=branch,base=meta.get('branch'),baseSha=snap['head'],mr=None))
            elif action=='worktree-move':
                command(member,'worktree','move','--',str(member),str(target))
                manifest['members'][index].update(name=newname,path='repos/'+newname)
                result['member']=newname
            else:
                # No --force: Git refuses dirty, locked or untracked trees.
                command(member,'worktree','remove','--',str(member))
                del manifest['members'][index];result['removed']=True
        if canonical(manifest)!=canonical(json.loads(original)):
            lock=root/'.lucyna-work-registration.lock'
            with lock.open('a+b') as stream:
                fcntl.flock(stream,fcntl.LOCK_EX)
                if (root/'work.json').read_bytes()!=original:
                    raise TimeoutError('Git 已执行，但 Work 登记被其他程序修改；请核对仓库与 work.json，不会覆盖登记或重复执行')
                descriptor,temporary=tempfile.mkstemp(prefix='.work-json-',dir=root)
                try:
                    with os.fdopen(descriptor,'w',encoding='utf-8') as output:
                        json.dump(manifest,output,ensure_ascii=False,indent=2);output.write('\n');output.flush();os.fsync(output.fileno())
                    os.replace(temporary,root/'work.json')
                finally:Path(temporary).unlink(missing_ok=True)
        return result


@contextmanager
def runner_lease(state,root):
    with socket.socket(socket.AF_UNIX) as lease:
        lease.settimeout(15);lease.connect(str(Path(state)/'runner.sock'))
        with lease.makefile('rb') as reader:
            lease.sendall(b'{"op":"status"}\n');status=json.loads(reader.readline(65537))
            if not status.get('data',{}).get('workspaceLock'):raise ValueError('后台服务尚不支持工作树占用锁，请重启 Lucyna 更新后台组件')
            lease.sendall((json.dumps(dict(op='workspace-lock',root=root))+'\n').encode())
            response=json.loads(reader.readline(65537))
            if not response.get('success'):raise ValueError(response.get('error','无法取得工作树占用锁'))
            yield


if __name__=='__main__':
    import sys
    try:
        payload=json.loads(sys.stdin.buffer.read(1024*1024+1))
        admission=(lambda root:runner_lease(payload['runnerState'],root)) if payload.get('runnerState') else lambda root:nullcontext()
        print(json.dumps(GitWorkspace(payload.get('state'),admission=admission).dispatch(payload['root'],payload['member'],payload['action'],payload.get('options')),ensure_ascii=False))
    except Exception as error:
        print(json.dumps(dict(error=str(error)),ensure_ascii=False));sys.exit(1)
