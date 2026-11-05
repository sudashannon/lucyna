"""Capture an interval in registered Git worktrees without writing to those repos."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

spec = importlib.util.spec_from_file_location('work_details', Path(__file__).with_name('work-details.py'))
details = importlib.util.module_from_spec(spec)
spec.loader.exec_module(details)
FILE_LIMIT = 512 * 1024
PATCH_LIMIT = 512 * 1024
MAX_FILES = 80
MAX_MEMBERS = 8
deadline = 0


def git(member, *args, overlay=None, data=None, limit=256 * 1024, accepted=(0,)):
    budget = deadline - time.monotonic()
    if budget <= 0:
        raise ValueError('超过本轮抓取时限')
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0')
    if overlay:
        env.update(GIT_INDEX_FILE=str(overlay / 'index'), GIT_OBJECT_DIRECTORY=str(overlay / 'objects'))
    with tempfile.TemporaryFile() as output:
        proc = subprocess.run(
            ['git', '-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false',
             '-c', 'core.untrackedCache=false', '-C', str(member), *args],
            input=data, stdout=output, stderr=subprocess.DEVNULL, env=env, timeout=min(4, budget))
        if proc.returncode not in accepted:
            raise ValueError('Git 状态无法读取')
        output.seek(0)
        result = output.read(limit + 1)
        if len(result) > limit:
            raise ValueError('Git 输出超过记录上限')
        return result


def file_data(member, name):
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts or '.git' in relative.parts:
        raise ValueError('文件路径无效')
    file = member / relative
    if file.parent.resolve() != file.parent:
        raise ValueError('跳过符号链接下的路径')
    try:
        info = file.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return None, b''
    if stat.S_ISDIR(info.st_mode):
        return None, b''
    if stat.S_ISLNK(info.st_mode):
        return '120000', os.fsencode(os.readlink(file))
    if not stat.S_ISREG(info.st_mode) or info.st_size > FILE_LIMIT:
        raise ValueError('文件类型或大小超出记录范围')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError('文件正在变化')
        content = stream.read(FILE_LIMIT + 1)
        after = os.fstat(stream.fileno())
        if len(content) > FILE_LIMIT or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError('文件正在变化或超过记录上限')
    return ('100755' if before.st_mode & stat.S_IXUSR else '100644'), content


def tree(member, overlay):
    original = git(member, 'rev-parse', '--path-format=absolute', '--git-path', 'objects').rstrip(b'\n')
    alternates = overlay / 'objects' / 'info' / 'alternates'
    if not overlay.exists():
        if b'\n' in original:
            raise ValueError('仓库路径无法记录')
        alternates.parent.mkdir(parents=True)
        alternates.write_bytes(original + b'\n')
    elif alternates.read_bytes() != original + b'\n':
        raise ValueError('仓库在会话期间被替换')
    head = git(member, 'rev-parse', '--verify', '-q', 'HEAD', accepted=(0, 1)).strip()
    git(member, 'read-tree', os.fsdecode(head) if head else '--empty', overlay=overlay)
    status_args = ('status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=all')
    raw = git(member, *status_args)
    rows = raw.split(b'\0')[:-1]
    if len(rows) > MAX_FILES:
        raise ValueError('改动文件过多，无法完整记录仓库')
    zero = b'0' * (64 if git(member, 'rev-parse', '--show-object-format').strip() == b'sha256' else 40)
    track_mode = git(member, 'config', '--bool', 'core.filemode', accepted=(0, 1)).strip() != b'false'
    removals, updates = [], []
    skipped = set()
    for row in rows:
        code, name = row[:2], row[3:]
        try:
            name_text = name.decode('utf-8')
            if code in (b'DD', b'AU', b'UD', b'UA', b'DU', b'AA', b'UU'):
                raise ValueError('跳过冲突文件')
            mode, content = file_data(member, name_text)
            if not mode:
                removals.append(b'0 ' + zero + b'\t' + name + b'\0')
                continue
            if not track_mode and mode.startswith('100'):
                entry = git(member, '--literal-pathspecs', 'ls-files', '-s', '-z', '--', name_text)
                mode = '100755' if entry.startswith(b'100755 ') else '100644'
            blob = git(member, 'hash-object', '-w', '--stdin', '--no-filters', overlay=overlay, data=content).strip()
            updates.append(mode.encode() + b' ' + blob + b'\t' + name + b'\0')
        except (OSError, ValueError):
            skipped.add(name)
    if removals or updates:
        git(member, 'update-index', '-z', '--index-info', overlay=overlay, data=b''.join(removals + updates))
    result = git(member, 'write-tree', overlay=overlay).strip().decode('ascii')
    if git(member, 'rev-parse', '--verify', '-q', 'HEAD', accepted=(0, 1)).strip() != head or git(member, *status_args) != raw:
        raise ValueError('仓库在抓取时发生变化')
    return result, skipped


def members(root):
    manifest = root / 'work.json'
    if not manifest.is_file():
        return []
    if manifest.is_symlink() or manifest.stat().st_size > 256 * 1024:
        raise ValueError('Work 登记文件不可读取')
    data = json.loads(manifest.read_text(encoding='utf-8'))
    if data.get('version') != 1 or not isinstance(data.get('members'), list):
        raise ValueError('Work 登记无效')
    return [item.get('name') for item in data['members']]


def capture(root, directory, previous=None):
    names = members(root)
    selected = names if previous is None else list(previous)
    warnings = []
    if len(selected) > MAX_MEMBERS:
        warnings.append('仓库数量超过本轮记录上限。')
    if previous is not None and any(name not in previous for name in names):
        warnings.append('本轮新增的仓库没有发送前基线。')
    def one(item):
        index, name = item
        try:
            member, _ = details.member_path(root, name)
            overlay = directory / str(index)
            current, skipped = tree(member, overlay)
            return name, (member, overlay, current, skipped), None
        except (KeyError, OSError, ValueError, subprocess.TimeoutExpired):
            label = name if isinstance(name, str) else '未知仓库'
            return name, None, label + ' 无法完整抓取。'
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(one, enumerate(selected[:MAX_MEMBERS])))
    # Retain failed members in the index so each overlay keeps the same owner.
    captures = {}
    for name, value, warning in results:
        if warning:
            warnings.append(warning)
        if isinstance(name, str):
            captures[name] = value
    return captures, warnings


def changes(before, after, warnings):
    files = []
    remaining = PATCH_LIMIT
    for name, previous in before.items():
        current = after.get(name)
        if not previous or not current:
            continue
        member, overlay, old, old_skipped = previous
        _, _, new, new_skipped = current
        skipped = old_skipped | new_skipped
        if skipped:
            warnings.append(f'{name} 有 {len(skipped)} 个文件超出记录范围或在抓取时变化。')
        try:
            common = ('diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=all', old, new)
            names = git(member, *common, '--name-only', '-z', overlay=overlay).split(b'\0')[:-1]
            for path in names:
                if path in skipped:
                    continue
                if len(files) >= MAX_FILES or remaining <= 0:
                    warnings.append('其余改动超过本轮记录上限。')
                    return files
                filename = path.decode('utf-8')
                try:
                    raw = git(member, '--literal-pathspecs', *common, '--', filename, overlay=overlay,
                              limit=min(128 * 1024, remaining))
                    remaining -= len(raw)
                    files.append(dict(member=name, path=filename, patch=raw.decode('utf-8', 'replace')))
                except (ValueError, subprocess.TimeoutExpired):
                    files.append(dict(member=name, path=filename, patch='', omitted=True))
        except (ValueError, subprocess.TimeoutExpired):
            warnings.append(f'{name} 的部分差异无法读取。')
    return files


if __name__ == '__main__':
    deadline = time.monotonic() + 3
    root = details.work_root(sys.argv[1])
    with tempfile.TemporaryDirectory(prefix='lucyna-turn-') as temporary:
        directory = Path(temporary)
        before, warnings = capture(root, directory)
        if not before:
            sys.exit(0)
        print('ready', flush=True)
        if sys.stdin.readline().strip() == 'finish':
            deadline = time.monotonic() + 10
            after, end_warnings = capture(root, directory, before)
            warnings.extend(end_warnings)
            files = changes(before, after, warnings)
            print(json.dumps(dict(files=files, warnings=list(dict.fromkeys(warnings))), ensure_ascii=True), flush=True)
