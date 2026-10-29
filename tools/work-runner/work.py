"""Work-local files and shared sandbox for fixed evaluation and Work commands."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_name(name):
    return name in ('.git', '.omp', '.agents', '.ssh') or name.startswith('.env') or name.endswith(('.pem', '.key', '.pfx', '.p12'))


def bounded_file(path, limit=1024*1024):
    if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1:
        raise ValueError('只允许普通、非链接文件')
    with path.open('rb') as stream:
        data = stream.read(limit+1)
    if len(data) > limit:
        raise ValueError('文件超过 1 MiB，首版后台文件任务不支持')
    return data


def binding(root, config):
    path = Path(root)
    base = Path(config['workRoot']).resolve(strict=True)
    if not path.is_absolute() or str(path.resolve(strict=True)) != root or path.parent != base or path.is_symlink():
        raise ValueError('请选择登记的 Work 根目录')
    bounded_file(path/'SESSION.md')
    if (path/'.git').exists():
        raise ValueError('Work 根不能是 Git 仓库')
    manifest = bounded_file(path/'work.json') if (path/'work.json').exists() else b''
    result = subprocess.run(['/usr/bin/python3', config['helper'], 'verify', root], capture_output=True, timeout=20)
    if result.returncode:
        raise ValueError('Work helper 校验失败，请先检查成员登记')
    verified = json.loads(result.stdout)
    if verified.get('kind') not in ('work', 'gitless'):
        raise ValueError('无效 Work 类型')
    stat = path.stat()
    return {'root': root, 'device': stat.st_dev, 'inode': stat.st_ino, 'manifest': digest(manifest), 'kind': verified['kind']}


def local_path(root, name, directory=False):
    if not isinstance(name, str) or len(name) > 4096 or '\\' in name or any(c in name for c in '\0\r\n'):
        raise ValueError('无效相对路径')
    parts = name.split('/')
    if directory and name == '.':
        return Path(root)
    if not name or any(p in ('', '.', '..') for p in parts) or name.startswith('/'):
        raise ValueError('路径必须位于当前 Work 内')
    if any(private_name(p) for p in parts):
        raise ValueError('此路径不属于后台文件任务的可访问范围')
    target = Path(root)
    for part in parts:
        target /= part
        if target.is_symlink():
            raise ValueError('后台文件任务不跟随符号链接')
    if not target.resolve().is_relative_to(Path(root)):
        raise ValueError('路径越出 Work')
    return target


def check_frozen(run):
    for name, expected in run['frozen'].items():
        if digest(bounded_file(local_path(run['root'], name))) != expected:
            raise ValueError('验收输入已改变：'+name+'；请检查后创建新任务')


def file_tool(run, name, args):
    path = args.get('path', '.')
    target = local_path(run['root'], path, directory=name == 'list_work_files')
    if name == 'list_work_files':
        entries = []
        for entry in sorted(target.iterdir()):
            relative = entry.relative_to(run['root']).as_posix()
            try:
                local_path(run['root'], relative)
            except ValueError:
                continue
            entries.append({'path': relative, 'directory': entry.is_dir()})
            if len(entries) >= 500:
                return {'entries': entries, 'truncated': True}
        return {'entries': entries, 'truncated': False}
    if name == 'read_work_file':
        data = bounded_file(target)
        text = data.decode('utf-8')
        offset = args.get('offset', 0)
        if type(offset) is not int or offset < 0:
            raise ValueError('无效 offset')
        return {'content': text[offset:offset+32000], 'sha256': digest(data), 'nextOffset': offset+32000 if len(text) > offset+32000 else None}
    if name != 'write_work_file':
        raise ValueError('Unknown Work tool')
    if path == 'work.json' or path in run['frozen'] or (re.fullmatch(r'SESSION-.+\.md', path) and path != run['privateLog']):
        raise ValueError('不能修改成员登记、冻结验收文件或其他会话日志')
    content = args.get('content')
    if not isinstance(content, str) or len(content.encode()) > 256*1024:
        raise ValueError('写入内容超过 256 KiB')
    before = bounded_file(target) if target.exists() else None
    expected = digest(before) if before is not None else 'missing'
    if args.get('expectedSha256') != expected:
        raise ValueError('文件已变化，请重新读取后合并修改')
    if path == run['privateLog'] and before and not content.startswith(before.decode()):
        raise ValueError('当前会话日志仅可追加')
    if path == 'SESSION.md' and before:
        state = re.compile(r'(?m)^.*(?:\*\*状态\*\*|状态\s*[:：]).*$')
        if state.findall(before.decode()) != state.findall(content):
            raise ValueError('请保留 Work 的总体状态，只更新进度、证据与下一步')
    target.parent.mkdir(parents=True, exist_ok=True)
    # Recheck after mkdir; no model tool can create symlinks or hardlinks.
    local_path(run['root'], path)
    fd, temp = tempfile.mkstemp(prefix='.lucyna-write-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content.encode())
            stream.flush()
            os.fsync(stream.fileno())
        if before is not None:
            os.chmod(temp, target.stat().st_mode & 0o777)
        os.replace(temp, target)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return {'sha256': digest(content.encode()), 'written': path}


def verification_spec(value, root):
    if value is None:
        return None, {}
    if not isinstance(value, dict):
        raise ValueError('验收配置无效')
    argv, files, cwd = value.get('argv'), value.get('files'), value.get('cwd', '.')
    if not isinstance(argv, list) or not 1 <= len(argv) <= 64 or any(not isinstance(a, str) or len(a) > 4000 or '\0' in a for a in argv):
        raise ValueError('验收命令须为参数数组')
    if not argv[0].startswith('/usr/bin/') or '/' in argv[0][9:]:
        raise ValueError('验收程序须使用 /usr/bin/ 下的绝对路径')
    if not isinstance(files, list) or not 1 <= len(files) <= 30:
        raise ValueError('请指定至少一个冻结的验收文件')
    target = local_path(root, cwd, directory=True)
    if not target.is_dir():
        raise ValueError('验收目录不存在')
    frozen = {name: digest(bounded_file(local_path(root, name))) for name in files}
    return {'argv': argv, 'files': files, 'cwd': cwd}, frozen


async def verify(run):
    check_frozen(run)
    spec = run['verificationSpec']
    if not spec:
        return {'passed': None, 'reason': 'manual_acceptance', 'output': ''}
    result = await sandbox_command(run, spec['argv'], spec['cwd'])
    check_frozen(run)
    return dict(result, passed=result['exitCode'] == 0, inputs=run['frozen'])


async def sandbox_command(run, argv, cwd='.', writable=False):
    def limits():
        resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
        resource.setrlimit(resource.RLIMIT_FSIZE, (16*1024*1024, 16*1024*1024))
        resource.setrlimit(resource.RLIMIT_AS, (2*1024**3, 2*1024**3))
    masks, count = [], 0
    for name in run.get('hidden', []):
        local_path(run['root'],name)
        masks.extend(['--ro-bind','/dev/null','/work/'+name])
    for directory, dirs, files in os.walk(run['root'], followlinks=False):
        for name in dirs[:]+files:
            count += 1
            if count > 100000:
                raise ValueError('验收目录超过 100000 项，请缩小 Work 输入')
            target = Path(directory)/name
            if target.is_symlink():
                raise ValueError('首版隔离验收不支持符号链接：'+str(target.relative_to(run['root'])))
            if target.is_file() and target.stat().st_nlink != 1:
                raise ValueError('首版隔离验收不支持共享硬链接')
            if private_name(name):
                sandbox_path = '/work/'+target.relative_to(run['root']).as_posix()
                if name in dirs:
                    dirs.remove(name)
                    masks.extend(['--tmpfs', sandbox_path])
                else:
                    masks.extend(['--ro-bind', '/dev/null', sandbox_path])
    if writable:
        protected = set(run['frozen']) | {'SESSION.md', 'work.json'}
        protected.update(p.name for p in Path(run['root']).glob('SESSION-*.md'))
        for name in sorted(protected):
            target = local_path(run['root'], name)
            if target.exists():
                bounded_file(target)
                masks.extend(['--ro-bind', str(target), '/work/'+name])
    args = ['bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL',
        '--tmpfs', '/', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
        '--bind' if writable else '--ro-bind', run['root'], '/work', *masks, '--chdir', '/work' if cwd == '.' else '/work/'+cwd,
        '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1', *argv]
    process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, start_new_session=True, preexec_fn=limits)
    output = bytearray()
    try:
        async def collect():
            while chunk := await process.stdout.read(8192):
                output.extend(chunk)
                if len(output) > 512*1024:
                    raise ValueError('验收输出超过限制')
            await process.wait()
        await asyncio.wait_for(collect(), 75)
        return {'exitCode': process.returncode, 'output': output[-12000:].decode('utf-8', errors='replace')}
    finally:
        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()


def tool(name, description, properties, required):
    return {'name': name, 'label': name, 'description': description, 'loadMode': 'essential',
            'parameters': {'type': 'object', 'properties': properties, 'required': required, 'additionalProperties': False}}


TOOLS = [
    tool('list_work_files', 'List a directory within this Work (no symlinks or private config).', {'path': {'type': 'string'}}, ['path']),
    tool('read_work_file', 'Read UTF-8 Work file; retain sha256 for edits. Paginate with offset if needed.', {'path': {'type': 'string'}, 'offset': {'type': 'integer'}}, ['path']),
    tool('write_work_file', 'Write a Work file using its last sha256, or missing for a new file. Never change frozen tests or other session logs.',
         {'path': {'type': 'string'}, 'content': {'type': 'string'}, 'expectedSha256': {'type': 'string'}}, ['path', 'content', 'expectedSha256']),
    tool('verify_work', 'Run the user-defined immutable acceptance command in an offline read-only sandbox. Use failure evidence to fix the task.', {}, []),
    tool('ask_work_user', 'Wait for human clarification. No timeout chooses an answer; offline UI does not imply consent.', {'question': {'type': 'string'}}, ['question']),
]
