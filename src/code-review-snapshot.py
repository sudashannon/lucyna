"""Capture bounded, immutable-by-value Git diffs for code review.

This program only reads registered Work repositories. The caller sends one JSON
line and keeps stdin open; EOF requests cancellation. Git children are owned by
this process and are terminated and reaped before this program exits.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import signal
import select
import stat
import subprocess
import sys
import tempfile
import threading
import time


DETAILS_SPEC = importlib.util.spec_from_file_location('work_details', Path(__file__).with_name('work-details.py'))
details = importlib.util.module_from_spec(DETAILS_SPEC)
DETAILS_SPEC.loader.exec_module(details)

MAX_TOTAL_SECONDS = 22
MAX_STATUS_BYTES = 2 * 1024 * 1024
MAX_INDEX_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_FINGERPRINT_BYTES = 64 * 1024 * 1024
MAX_STDERR_BYTES = 64 * 1024
MAX_STATUS_PATHS = 2000
MAX_FILES = 80
MAX_PATCH_BYTES = 128 * 1024
MAX_TOTAL_PATCH_BYTES = 512 * 1024


class SnapshotError(Exception):
    pass


class Cancelled(SnapshotError):
    pass


class OutputLimit(SnapshotError):
    pass


class GitRunner:
    def __init__(self, seconds=MAX_TOTAL_SECONDS):
        self.deadline = time.monotonic() + seconds
        self.cancelled = threading.Event()
        self.lock = threading.RLock()
        self.active = set()

    def remaining(self):
        value = self.deadline - time.monotonic()
        if value <= 0:
            raise SnapshotError('工作区快照超过总时限，请缩小改动范围后重试')
        if self.cancelled.is_set():
            raise Cancelled('工作区快照已取消')
        return value

    @staticmethod
    def _stop(process):
        if process.poll() is not None:
            return
        try:
            if os.name == 'nt':
                process.terminate()
            else:
                os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except OSError:
            try:
                process.terminate()
            except OSError:
                pass
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            try:
                if os.name == 'nt':
                    process.kill()
                else:
                    os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                try:
                    process.kill()
                except OSError:
                    pass
            process.wait()

    def cancel(self):
        self.cancelled.set()
        with self.lock:
            active = tuple(self.active)
        for process in active:
            self._stop(process)

    def run(self, args, output_limit, accepted=(0,)):
        remaining = self.remaining()
        env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        env.update(GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0', NO_COLOR='1')
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            try:
                process = subprocess.Popen(
                    args,
                    stdin=subprocess.DEVNULL,
                    stdout=output,
                    stderr=errors,
                    env=env,
                    start_new_session=os.name != 'nt',
                )
            except OSError:
                raise SnapshotError('无法启动只读 Git 快照命令') from None
            with self.lock:
                self.active.add(process)
                if self.cancelled.is_set():
                    self._stop(process)
            try:
                while process.poll() is None:
                    if self.cancelled.is_set():
                        self._stop(process)
                        raise Cancelled('工作区快照已取消')
                    if time.monotonic() >= self.deadline:
                        self._stop(process)
                        raise SnapshotError('工作区快照超过总时限，请缩小改动范围后重试')
                    if os.fstat(output.fileno()).st_size > output_limit:
                        self._stop(process)
                        raise OutputLimit('Git 输出超过快照限制')
                    if os.fstat(errors.fileno()).st_size > MAX_STDERR_BYTES:
                        self._stop(process)
                        raise SnapshotError('Git 错误输出超过快照限制')
                    time.sleep(min(0.025, max(0.001, self.deadline - time.monotonic())))
                process.wait()
                if self.cancelled.is_set():
                    raise Cancelled('工作区快照已取消')
                output.seek(0)
                data = output.read(output_limit + 1)
                if len(data) > output_limit:
                    raise OutputLimit('Git 输出超过快照限制')
                if os.fstat(errors.fileno()).st_size > MAX_STDERR_BYTES:
                    raise SnapshotError('Git 错误输出超过快照限制')
                if process.returncode not in accepted:
                    raise SnapshotError('Git 无法读取当前工作区差异')
                return data
            finally:
                with self.lock:
                    self.active.discard(process)
                if process.poll() is None:
                    self._stop(process)


def monitor_eof(runner, stop):
    # The production caller runs this script inside WSL. select/os.read avoids
    # a daemon thread holding Python's buffered stdin lock at interpreter exit.
    if os.name == 'nt':
        return
    descriptor = sys.stdin.fileno()
    while not stop.is_set():
        try:
            readable, _, _ = select.select([descriptor], [], [], 0.1)
            if not readable:
                continue
            if not os.read(descriptor, 4096):
                runner.cancel()
                return
        except OSError:
            runner.cancel()
            return


def git_command(member, *args):
    return ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
            '-c', 'core.quotePath=false', '-C', str(member), *args]


def read_index(runner, member):
    raw = runner.run(git_command(member, 'rev-parse', '--path-format=absolute', '--git-path', 'index'), 8192)
    try:
        target = Path(raw.decode('utf-8', 'strict').strip())
    except UnicodeDecodeError:
        raise SnapshotError('Git index 路径无法读取') from None
    if not target.is_absolute():
        target = member / target
    return hash_regular_file(target, MAX_INDEX_BYTES, None, allow_missing=True, check=runner.remaining)


def hash_regular_file(file, size_limit, budget, allow_missing=False, check=None):
    if check:
        check()
    try:
        before = file.lstat()
    except FileNotFoundError:
        if allow_missing:
            return 'absent'
        return ('missing', False) if budget is not None else 'missing'
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise SnapshotError('Git index 文件类型无效')
    metadata = stat_signature(before)
    if before.st_size > size_limit:
        if budget is not None:
            return 'metadata:' + metadata, True
        raise SnapshotError('Git index 超过读取上限')
    if budget is not None:
        if budget[0] + before.st_size > budget[1]:
            return 'metadata:' + metadata, True
        budget[0] += before.st_size
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    try:
        fd = os.open(file, flags)
    except OSError:
        raise SnapshotError('工作区文件正在变化或无法安全读取') from None
    digest = hashlib.sha256()
    try:
        with os.fdopen(fd, 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or not same_file_version(before, opened):
                raise SnapshotError('Git index 正在变化' if budget is None else '工作区文件正在变化')
            total = 0
            while True:
                if check:
                    check()
                chunk = stream.read(min(1024 * 1024, size_limit + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > size_limit:
                    raise SnapshotError('工作区文件超过指纹读取上限')
                digest.update(chunk)
            after = os.fstat(stream.fileno())
            if stat_signature(opened) != stat_signature(after):
                raise SnapshotError('工作区文件在读取期间发生变化')
            if total != opened.st_size:
                raise SnapshotError('工作区文件在读取期间发生变化')
    except OSError:
        raise SnapshotError('工作区文件正在变化或无法安全读取') from None
    return 'content:' + digest.hexdigest() + ':' + stat_signature(after), False


def stat_signature(info):
    return ':'.join(str(value) for value in (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
                                               info.st_ctime_ns, info.st_mode))


def same_file_version(left, right):
    # Some Windows file systems update ctime while opening files. The final
    # descriptor stat still carries ctime in the snapshot token; use stable
    # object/content attributes for the path-to-descriptor identity check.
    return (left.st_dev, left.st_ino, left.st_size, left.st_mtime_ns, left.st_mode) == \
           (right.st_dev, right.st_ino, right.st_size, right.st_mtime_ns, right.st_mode)


def safe_worktree_hash(member, name, budget, check=None):
    if check:
        check()
    if not isinstance(name, str) or not name or '\ufffd' in name or any(ord(value) < 32 or ord(value) == 127 for value in name):
        raise SnapshotError('工作区包含无法无损读取的文件名')
    relative = PurePosixPath(name)
    if relative.is_absolute() or '..' in relative.parts or '.git' in relative.parts:
        raise SnapshotError('Git 返回了无效工作区路径')
    file = member.joinpath(*relative.parts)
    try:
        parent = file.parent.resolve(strict=False)
        if not parent.is_relative_to(member):
            raise SnapshotError('工作区文件路径超出成员仓库')
    except OSError:
        raise SnapshotError('工作区文件路径无法安全解析') from None
    try:
        info = file.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return ('missing', False)
    except OSError:
        raise SnapshotError('工作区文件正在变化或无法安全读取') from None
    if stat.S_ISLNK(info.st_mode):
        target = os.fsencode(os.readlink(file))
        after = file.lstat()
        if stat_signature(info) != stat_signature(after):
            raise SnapshotError('工作区符号链接在读取期间发生变化')
        if budget[0] + len(target) > budget[1]:
            return 'metadata-symlink:' + stat_signature(info), True
        budget[0] += len(target)
        return 'symlink:' + hashlib.sha256(target).hexdigest() + ':' + stat_signature(info), False
    if not stat.S_ISREG(info.st_mode):
        return 'special:' + stat_signature(info), True
    return hash_regular_file(file, MAX_FILE_BYTES, budget, check=check)


def fingerprint(runner, member, scope):
    try:
        head = details.optional(member, 'rev-parse', '--verify', 'HEAD^{commit}') or ''
        ref = details.optional(member, 'symbolic-ref', '-q', 'HEAD') or ''
        index = read_index(runner, member)
        status = details.status(member)
    except Cancelled:
        raise
    except Exception as error:
        raise SnapshotError(str(error) or 'Git 状态无法完整读取') from None
    if status.get('truncated'):
        raise SnapshotError('改动文件清单超过读取上限，未生成不完整快照')
    rows = status.get('files')
    if not isinstance(rows, list) or len(rows) > MAX_STATUS_PATHS:
        raise SnapshotError('改动文件数量超过指纹读取上限')
    budget = [0, MAX_FINGERPRINT_BYTES]
    files = []
    content = {}
    for row in rows:
        name = row.get('path')
        old = row.get('oldPath')
        files.append((row.get('code', ''), name, old, bool(row.get('staged')), bool(row.get('unstaged')),
                      bool(row.get('untracked')), bool(row.get('conflict'))))
    # Staged patches depend on HEAD and the index, not the working copy. Hash
    # only the selected unstaged inputs; huge or aggregate-over-budget files
    # are metadata-fingerprinted and omitted before Git reads their contents.
    for item_scope, candidate, _untracked in candidates(rows, scope)[:MAX_FILES]:
        if item_scope != 'unstaged' or candidate in content:
            continue
        content[candidate] = safe_worktree_hash(member, candidate, budget, runner.remaining)
    omitted = {name for name, (_fingerprint, metadata_only) in content.items() if metadata_only}
    return {'head': head, 'ref': ref, 'index': index, 'files': files, 'content': content, 'omitted': omitted,
            'rows': status['files']}


def candidates(status, scope):
    result = {}
    for row in status:
        path = row['path']
        old_path = row.get('oldPath')
        paths = [path] + ([old_path] if old_path else [])
        if row.get('conflict'):
            selected = ['unstaged'] if scope == 'all' else [scope]
            for item_scope in selected:
                result[(item_scope, path)] = False
            continue
        selected = ('staged', 'unstaged') if scope == 'all' else (scope,)
        for item_scope in selected:
            active = row.get(item_scope) or item_scope == 'unstaged' and row.get('untracked')
            if active:
                for item_path in paths:
                    result[(item_scope, item_path)] = bool(row.get('untracked') and item_path == path and item_scope == 'unstaged')
    return sorted((item_scope, item_path, untracked) for (item_scope, item_path), untracked in result.items())


def diff_for(runner, member, path, scope, untracked):
    common = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=3']
    pathspec = ':(literal)' + path
    if untracked:
        # --no-index compares two filesystem paths rather than Git pathspecs.
        # The validated relative name follows `--`, so leading dashes are safe.
        args = common + ['--no-index', '--', '/dev/null', path]
        accepted = (0, 1)
    else:
        args = common + (['--cached'] if scope == 'staged' else []) + ['--', pathspec]
        accepted = (0,)
    return runner.run(git_command(member, *args), MAX_PATCH_BYTES, accepted=accepted)


def capture(request, runner):
    if not isinstance(request, dict):
        raise SnapshotError('无效工作区快照请求')
    root_value, member_name = request.get('root'), request.get('member')
    scope = request.get('scope', 'all')
    root_path = Path(root_value) if isinstance(root_value, str) else Path('.')
    if not isinstance(root_value, str) or len(root_value) > 4096 or not root_path.is_absolute() \
            or any(value in root_value for value in ('\0', '\r', '\n')) or '..' in root_path.parts:
        raise SnapshotError('无效工作根')
    if not isinstance(member_name, str) or not member_name or len(member_name) > 200 or not member_name[0].isalnum() \
            or any(not (c.isascii() and (c.isalnum() or c in '._-')) for c in member_name):
        raise SnapshotError('无效 Git 成员')
    if scope not in ('all', 'staged', 'unstaged'):
        raise SnapshotError('无效改动范围')
    root = details.work_root(root_value)

    # Reuse Work registration and repository identity checks from the existing
    # reader. Replace only its subprocess function so cancellation owns/reaps
    # every Git process it starts.
    original_run = details.run

    def bounded_run(args, limit=details.LIMIT, timeout=25, accepted=(0,)):
        try:
            raw = runner.run(args, min(limit, MAX_STATUS_BYTES), accepted=accepted)
            return raw.decode('utf-8', 'replace'), False
        except OutputLimit:
            return '', True
        except Cancelled:
            raise
        except SnapshotError as error:
            raise ValueError(str(error)) from None

    details.run = bounded_run
    try:
        member, _metadata = details.member_path(root, member_name)
        before = fingerprint(runner, member, scope)
        rows = before['rows']
        pending = candidates(rows, scope)
        files = []
        warnings = []
        partial = False
        if len(pending) > MAX_FILES:
            partial = True
            warnings.append(f'改动项共 {len(pending)} 个，超过本轮 {MAX_FILES} 项上限；仅读取前 {MAX_FILES} 项。')
            pending = pending[:MAX_FILES]
        total = 0
        for item_scope, path, untracked in pending:
            runner.remaining()
            try:
                row = next((row for row in rows if row.get('path') == path or row.get('oldPath') == path), None)
                if row and row.get('conflict'):
                    raise SnapshotError('冲突文件尚未解决')
                if item_scope == 'unstaged' and path in before['omitted']:
                    raise SnapshotError('文件过大或超出内容指纹预算，未读取也未传入审查')
                raw = diff_for(runner, member, path, item_scope, untracked)
                if not raw:
                    continue
                try:
                    patch = raw.decode('utf-8', 'strict')
                except UnicodeDecodeError:
                    raise SnapshotError('差异不是有效 UTF-8 文本') from None
                if 'GIT binary patch' in patch or 'Binary files ' in patch:
                    raise SnapshotError('二进制文件不生成文本差异')
                if len(raw) > MAX_TOTAL_PATCH_BYTES - total:
                    raise OutputLimit('差异总量超过快照上限')
                total += len(raw)
                files.append({'member': member_name, 'path': path, 'scope': item_scope, 'patch': patch})
            except (OutputLimit, SnapshotError) as error:
                if isinstance(error, Cancelled):
                    raise
                partial = True
                files.append({'member': member_name, 'path': path, 'scope': item_scope, 'patch': '', 'omitted': True})
                warnings.append(f'{path}（{item_scope}）：{error}')
        after = fingerprint(runner, member, scope)
        if before != after:
            raise SnapshotError('工作区在快照读取期间发生变化，未返回混合版本；请刷新后重试')
        return {'files': files, 'warnings': list(dict.fromkeys(warnings)), 'partial': partial,
                'capturedAt': int(time.time() * 1000)}
    finally:
        details.run = original_run


def main():
    line = sys.stdin.buffer.readline(MAX_STATUS_BYTES + 1)
    if not line or len(line) > MAX_STATUS_BYTES:
        print(json.dumps({'success': False, 'error': '工作区快照请求无效'}, ensure_ascii=True), flush=True)
        return 2
    try:
        request = json.loads(line)
    except (json.JSONDecodeError, UnicodeDecodeError):
        print(json.dumps({'success': False, 'error': '工作区快照请求格式无效'}, ensure_ascii=True), flush=True)
        return 2
    runner = GitRunner()
    watcher_stop = threading.Event()
    watcher = threading.Thread(target=monitor_eof, args=(runner, watcher_stop), daemon=True)
    watcher.start()
    try:
        snapshot = capture(request, runner)
        response = {'success': True, 'snapshot': snapshot}
        code = 0
    except Cancelled:
        response = {'success': False, 'error': '工作区快照已取消'}
        code = 2
    except SnapshotError as error:
        response = {'success': False, 'error': str(error)}
        code = 1
    except Exception:
        response = {'success': False, 'error': '工作区快照读取失败'}
        code = 1
    watcher_stop.set()
    watcher.join(timeout=0.5)
    print(json.dumps(response, ensure_ascii=True, separators=(',', ':')), flush=True)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
