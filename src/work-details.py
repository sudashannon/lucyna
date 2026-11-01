"""On-demand, read-only Work assets and native Git inspection. No fetch or writes."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import hashlib
from urllib.parse import urlparse, quote

spec = importlib.util.spec_from_file_location('work_inventory', Path(__file__).with_name('work-inventory.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)
LIMIT = 2 * 1024 * 1024


def now():
    return datetime.now(timezone.utc).isoformat()


def run(args, limit=LIMIT, timeout=25, accepted=(0,)):
    # Spool output to disk; a large diff never fills the desktop process heap.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(args, stdout=output, stderr=errors, stdin=subprocess.DEVNULL,
                                   env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0', 'NO_COLOR': '1'})
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait()
            raise ValueError('读取超时，请缩小范围后重试')
        errors.seek(0)
        if process.returncode not in accepted:
            raise ValueError(errors.read(3000).decode('utf-8', 'replace').strip() or '读取失败')
        output.seek(0); data = output.read(limit + 1)
        return data[:limit].decode('utf-8', 'replace'), len(data) > limit


def git(member, *args, limit=LIMIT, accepted=(0,)):
    return run(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
                '-C', str(member), *args], limit=limit, accepted=accepted)


def optional(member, *args):
    try:
        return git(member, *args)[0].strip()
    except ValueError:
        return None


def work_root(value):
    root = Path(value)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError('无效工作根')
    root = root.resolve()
    if not (root / 'SESSION.md').is_file():
        raise ValueError('工作根缺少 SESSION.md')
    if not (root / 'SESSION.md').resolve().is_relative_to(root):
        raise ValueError('SESSION.md 指向工作根之外')
    return root


def member_path(root, name):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name):
        raise ValueError('无效成员名称')
    manifest = json.loads((root / 'work.json').read_text())
    members = [m for m in manifest.get('members', []) if m.get('name') == name]
    if manifest.get('version') != 1 or len(members) != 1:
        raise ValueError('请选择当前 work 登记的成员')
    meta = members[0]; member = root / 'repos' / name
    if meta.get('path') != 'repos/' + name or (root / 'repos').is_symlink() or member.is_symlink():
        raise ValueError('成员路径与登记不一致')
    member = member.resolve(strict=True)
    if not member.is_relative_to(root / 'repos'):
        raise ValueError('成员路径超出工作根')
    if Path(git(member, 'rev-parse', '--show-toplevel')[0].strip()).resolve() != member:
        raise ValueError('成员不是独立 Git 工作树')
    common = Path(git(member, 'rev-parse', '--git-common-dir')[0].strip())
    common = (member / common).resolve()
    if common != Path(meta['repo']).expanduser().resolve():
        raise ValueError('成员的 Git 仓库归属与登记不一致')
    return member, meta


def status(member):
    raw, truncated = git(member, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
    chunks = raw.split('\0'); files = []; i = 0
    counts = dict(staged=0, unstaged=0, untracked=0, conflicts=0)
    while i < len(chunks):
        row = chunks[i]; i += 1
        if len(row) < 4: continue
        if truncated and i == len(chunks): break
        code, filename = row[:2], row[3:]; old = None
        if 'R' in code or 'C' in code:
            old = chunks[i] if i < len(chunks) else None; i += 1
        conflict = code in ('DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU')
        staged = code[0] not in (' ', '?', '!') and not conflict
        unstaged = code[1] not in (' ', '?', '!') and not conflict
        untracked = code == '??'
        for key, value in dict(staged=staged, unstaged=unstaged, untracked=untracked, conflicts=conflict).items():
            counts[key] += int(value)
        files.append(dict(path=filename, oldPath=old, code=code, staged=staged, unstaged=unstaged, untracked=untracked, conflict=conflict))
    return dict(counts=counts, files=files, truncated=truncated)


def trees(member):
    try:
        raw, truncated = git(member, 'worktree', 'list', '--porcelain', '-z')
        separator = '\0'
    except ValueError as error:
        if 'unknown switch' not in str(error) and 'unknown option' not in str(error): raise
        # Ubuntu 22.04 Git 2.34 lacks worktree list -z. Some old builds emit
        # newline paths without quoting. Reject ambiguous rows rather than
        # silently returning a shortened path.
        raw, truncated = git(member, '-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain')
        separator = '\n'
    result = []
    for block in raw.split(separator * 2):
        row = {}
        for field in block.split(separator):
            key, _, value = field.partition(' ')
            if separator == '\n' and key not in ('', 'worktree', 'HEAD', 'branch', 'locked', 'prunable', 'detached', 'bare'):
                raise ValueError('旧版 Git 无法可靠列举含换行的 Worktree 路径，请在终端查看或升级 Git')
            if separator == '\n' and value.startswith('"') and value.endswith('"'):
                buf = bytearray(); escapes = {'a':7,'b':8,'t':9,'n':10,'v':11,'f':12,'r':13,'"':34,'\\':92}
                for token in re.findall(r'\\[0-7]{1,3}|\\.|[^\\]', value[1:-1]):
                    if re.fullmatch(r'\\[0-7]{1,3}', token): buf.append(int(token[1:], 8))
                    elif token.startswith('\\') and token[1:] in escapes: buf.append(escapes[token[1:]])
                    else: buf.extend(token.encode('utf-8'))
                value = buf.decode('utf-8', 'replace')
            if key == 'worktree': row['path'] = value
            elif key in ('HEAD', 'branch', 'locked', 'prunable', 'detached', 'bare'):
                row[key.lower()] = value or True
        if row.get('path'): result.append(row)
    return result, truncated


def member_detail(root, row):
    result = dict(row)
    try:
        member, meta = member_path(root, row['name'])
        result['repo'] = str(Path(meta['repo']).expanduser().resolve())
        branch = git(member, 'branch', '--show-current')[0].strip()
        result.update(branch=branch or 'detached HEAD', detached=not branch, head=optional(member, 'rev-parse', '--verify', 'HEAD'))
        current = status(member); result.update(counts=current['counts'], changedFiles=len(current['files']), statusTruncated=current['truncated'])
        upstream = optional(member, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')
        result['upstream'] = upstream
        if upstream:
            pair = optional(member, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}')
            if pair: result['ahead'], result['behind'] = map(int, pair.split())
        base = meta.get('baseSha', '')
        if re.fullmatch(r'[a-fA-F0-9]{40}', base):
            pair = optional(member, 'rev-list', '--left-right', '--count', base + '...HEAD')
            if pair: result['baseBehind'], result['baseAhead'] = map(int, pair.split())
        try: result['worktrees'], result['treesTruncated'] = trees(member)
        except ValueError as error: result['worktreesError'] = str(error)
    except (OSError, ValueError, KeyError) as error:
        result['detailError'] = str(error)
    return result


def section(text, heading):
    match = re.search(r'(?ms)^## ' + heading + r'[^\n]*\n(.*?)(?=^## |\Z)', text)
    return match[1] if match else ''


def asset(root, relative, kind, indexed=True):
    file = root / relative
    record = dict(path=relative, name=file.name, kind=kind, indexed=indexed)
    try:
        if not file.resolve().is_relative_to(root):
            return {**record, 'unavailable': '引用位于工作根之外'}
        stat = file.stat()
        record.update(modifiedAt=datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(), size=stat.st_size, directory=file.is_dir())
        if file.is_file() and file.suffix.lower() == '.md':
            with file.open(encoding='utf-8', errors='replace') as stream: head = stream.read(8192)
            title = re.search(r'(?m)^#\s+(.+)', head)
            if title: record['title'] = title[1].strip()
    except OSError:
        record['unavailable'] = '引用文件不存在或不可读取'
    return record


def details(value):
    root = work_root(value); inventory_row = inventory.inspect(root)
    with (root / 'SESSION.md').open(encoding='utf-8') as stream: text = stream.read(512 * 1024 + 1)
    if len(text) > 512 * 1024: raise ValueError('SESSION.md 超过读取上限')
    assets = []; warnings = []
    for folder, kind, index in [('notes', 'note', section(text, '主题页索引')), ('scripts', 'script', text), ('', 'log', section(text, '日志索引'))]:
        directory = root / folder
        if not directory.is_dir() or directory.is_symlink(): continue
        entries = sorted(directory.iterdir())
        if kind == 'log': entries = [p for p in entries if p.name.startswith('SESSION-') and p.suffix == '.md']
        elif kind == 'note': entries = [p for p in entries if p.suffix == '.md']
        else: entries = [p for p in entries if not p.name.startswith('.')]
        if len(entries) > 300: warnings.append(folder + ' 仅显示前 300 项')
        for file in entries[:300]:
            assets.append(asset(root, file.relative_to(root).as_posix(), kind, file.name in index))
    references = sorted(set(re.findall(r'\.agent-tmp/[A-Za-z0-9_./-]+', text)))
    assets.extend(asset(root, p.rstrip('.'), 'evidence') for p in references[:100])
    with ThreadPoolExecutor(max_workers=4) as pool:
        members = list(pool.map(lambda m: member_detail(root, m), inventory_row.get('members', [])))
    return dict(root=str(root), name=root.name, content=text, modifiedAt=datetime.fromtimestamp((root / 'SESSION.md').stat().st_mtime, timezone.utc).isoformat(),
                fetchedAt=now(), members=members, assets=assets, issues=inventory_row.get('issues', []), warnings=warnings, kind=inventory_row['kind'])


def parse_remote(remote):
    if '://' in remote:
        url = urlparse(remote); host, project = url.hostname, url.path.lstrip('/')
    else:
        match = re.fullmatch(r'(?:[^@/:]+@)?([^/:]+):(.+)', remote)
        if not match: raise ValueError('无法确定 GitLab 仓库地址')
        host, project = match.groups()
    return host, project.removesuffix('.git')


def remote_identity(member, mr=None):
    identities = []
    for name in git(member, 'remote')[0].splitlines():
        try:
            identity = parse_remote(git(member, 'remote', 'get-url', name)[0].strip())
            if identity not in identities: identities.append(identity)
        except ValueError: continue
    if isinstance(mr, str) and mr.startswith('https://'):
        parsed = urlparse(mr); match = re.fullmatch(r'/(.+)/-/merge_requests/(\d+)/?', parsed.path)
        expected = (parsed.hostname, match[1]) if match else None
        if expected in identities: return expected
        raise ValueError('MR 地址与该成员的 Git 远端不一致，请核对登记')
    if len(identities) == 1: return identities[0]
    raise ValueError('数字 MR 对应多个远端项目，无法唯一确定，请使用完整 MR 地址')


def mr_status(member, meta):
    mr = meta.get('mr')
    if not mr: raise ValueError('此成员尚未登记 MR')
    host, project = remote_identity(member, mr)
    if str(mr).isdigit(): iid = str(mr)
    else:
        parsed = urlparse(str(mr)); match = re.fullmatch(r'/(.+)/-/merge_requests/(\d+)/?', parsed.path)
        if parsed.scheme != 'https' or parsed.hostname != host or not match or match[1] != project:
            raise ValueError('MR 地址与该成员 Git 远端不一致，请核对登记')
        iid = match[2]
    executable = shutil.which('glab') or '/home/linuxbrew/.linuxbrew/bin/glab'
    try:
        output, truncated = run([executable, 'api', '--hostname', host, 'projects/' + quote(project, safe='') + '/merge_requests/' + iid], timeout=35)
        if truncated: raise ValueError('MR 响应过大')
        value = json.loads(output)
    except (OSError, ValueError):
        raise ValueError('无法读取 MR，请检查 WSL glab 的安装、登录及网络') from None
    pipeline = value.get('head_pipeline') or {}
    return dict(kind='mr', state=value.get('state'), draft=value.get('draft'), sourceBranch=value.get('source_branch'), targetBranch=value.get('target_branch'),
                sha=value.get('sha'), url=value.get('web_url'), updatedAt=value.get('updated_at'), checkedAt=now(),
                pipelineStatus=pipeline.get('status'), pipelineSha=pipeline.get('sha'), pipelineMatchesHead=bool(pipeline.get('sha') and pipeline.get('sha') == value.get('sha')))


def history_page(member, cursor='', query=''):
    head = optional(member, 'rev-parse', '--verify', 'HEAD')
    if not head:
        return dict(kind='history', commits=[], nextCursor=None, checkedAt=now())
    if not isinstance(query, str) or len(query) > 200 or '\0' in query:
        raise ValueError('无效提交搜索')
    signature = hashlib.sha256(query.encode()).hexdigest()[:16]
    offset = 0
    if cursor:
        parts = cursor.split(':')
        if len(parts) != 3 or parts[:2] != [head, signature] or not parts[2].isdigit() or int(parts[2]) > 100000:
            raise ValueError('提交列表已变化，请刷新后重新读取')
        offset = int(parts[2])
    args = ['log', '--max-count=41', '--skip='+str(offset), '--format=%H%x00%P%x00%aI%x00%an%x00%s%x00']
    if query:
        args += ['--fixed-strings', '--regexp-ignore-case', '--grep='+query]
    raw, cut = git(member, *args, limit=128*1024)
    fields = raw.split('\0'); rows = []
    for i in range(0, len(fields)-5, 5):
        oid, parents, date, author, subject = fields[i:i+5]
        oid = oid.strip()
        if not re.fullmatch('[a-fA-F0-9]{40,64}', oid):
            break
        rows.append(dict(oid=oid, parents=parents.split(), date=date, author=author, subject=subject))
    if optional(member, 'rev-parse', '--verify', 'HEAD') != head:
        raise ValueError('提交列表已变化，请刷新后重新读取')
    more = len(rows) > 40
    return dict(kind='history', commits=rows[:40], nextCursor=f'{head}:{signature}:{offset+40}' if more else None,
                truncated=cut, checkedAt=now())


def refs_list(member):
    raw, cut = git(member, 'for-each-ref', '--sort=-committerdate', '--count=201',
                   '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(committerdate:iso-strict)%00%(HEAD)',
                   'refs/heads/', 'refs/remotes/', limit=128*1024)
    rows = []
    for line in raw.splitlines():
        fields = line.split('\0')
        if len(fields) != 5:
            continue
        ref, oid, upstream, date, current = fields
        remote = ref.startswith('refs/remotes/')
        rows.append(dict(ref=ref, name=ref.removeprefix('refs/remotes/' if remote else 'refs/heads/'),
                         oid=oid, upstream=upstream, date=date, current=current.strip() == '*', remote=remote))
    return dict(kind='refs', branches=rows[:200], truncated=cut or len(rows)>200, checkedAt=now())


def resolve_commit(member, reference):
    if not isinstance(reference, str) or len(reference)>512 or '\0' in reference or not (
            reference == 'HEAD' or reference.startswith(('refs/heads/', 'refs/remotes/', 'refs/tags/'))
            or re.fullmatch('[a-fA-F0-9]{40,64}', reference)):
        raise ValueError('无效提交引用')
    return git(member, 'rev-parse', '--verify', '--end-of-options', reference+'^{commit}')[0].strip()


def inspect_git(value, name, action, scope='unstaged', filename='', cursor='', query='', commit='', base='', target='HEAD'):
    root = work_root(value); member, meta = member_path(root, name)
    if action == 'path': return dict(path=str(member))
    if action == 'mr': return mr_status(member, meta)
    if action == 'changes': return dict(kind=action, **status(member), checkedAt=now())
    if action == 'history': return history_page(member, cursor, query)
    if action == 'refs': return refs_list(member)
    if action == 'worktrees':
        rows, truncated = trees(member); return dict(kind=action, worktrees=rows, truncated=truncated, checkedAt=now())
    if action == 'diff':
        if scope not in ('staged', 'unstaged', 'baseline'): raise ValueError('无效比较方式')
        if filename and (Path(filename).is_absolute() or '..' in Path(filename).parts or '\0' in filename): raise ValueError('无效文件路径')
        args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color']
        if scope == 'staged': args += ['--cached']
        if scope == 'baseline':
            base = meta.get('baseSha', '')
            if not re.fullmatch(r'[a-fA-F0-9]{40}', base): raise ValueError('未登记有效 baseSha')
            args += [base, 'HEAD']
        args += ['--']
        if filename: args += [':(literal)' + filename]
        untracked = filename and scope == 'unstaged' and any(f['path'] == filename and f['untracked'] for f in status(member)['files'])
        if untracked:
            location = member / filename
            if not location.resolve().is_relative_to(member.resolve()):
                raise ValueError('文件指向成员工作树之外')
            text, truncated = git(member, 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color',
                                  '--', os.devnull, filename, limit=256*1024, accepted=(0,1))
        else:
            text, truncated = git(member, *args, limit=256 * 1024)
    elif action == 'commit':
        oid = resolve_commit(member, commit)
        text, truncated = git(member, 'show', '--format=', '--no-ext-diff', '--no-textconv', '--no-color', oid, '--', limit=256*1024)
    elif action == 'compare':
        start, end = resolve_commit(member, base), resolve_commit(member, target)
        text, truncated = git(member, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', start, end, '--', limit=256*1024)
    elif action == 'commits':
        text, truncated = git(member, 'log', '--max-count=40', '--date=iso-strict', '--format=%h  %ad  %s', limit=128 * 1024)
    elif action == 'branches':
        current = git(member, 'branch', '--show-current')[0].strip() or 'detached HEAD'
        text = '当前：' + current + '  ' + git(member, 'rev-parse', '--short', 'HEAD')[0].strip() + '\n'; truncated = False
        for ref, label in [('refs/heads/', '本地分支'), ('refs/remotes/', '远端引用（本机缓存）')]:
            rows, cut = git(member, 'for-each-ref', '--sort=-committerdate', '--count=151', '--format=%(HEAD) %(refname:short)  %(objectname:short)  %(upstream:short)', ref, limit=128 * 1024)
            lines = rows.splitlines(); truncated |= cut or len(lines) > 150
            text += '\n' + label + ' · 最近 150 条以内\n' + '\n'.join(lines[:150]) + '\n'
    else: raise ValueError('不支持的 Git 查看操作')
    return dict(kind=action, scope=scope, text=text, truncated=truncated, checkedAt=now())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('root'); parser.add_argument('--member'); parser.add_argument('--action', default='details'); parser.add_argument('--scope', default='unstaged'); parser.add_argument('--file', default='')
    for option in ('cursor', 'query', 'commit', 'base'):
        parser.add_argument('--'+option, default='')
    parser.add_argument('--target', default='HEAD')
    args = parser.parse_args()
    try:
        print(json.dumps(details(args.root) if args.action == 'details' else inspect_git(args.root, args.member, args.action, args.scope, args.file,
                         args.cursor, args.query, args.commit, args.base, args.target), ensure_ascii=False))
    except Exception as error:
        print(str(error), file=__import__('sys').stderr); raise SystemExit(1)
