#!/usr/bin/env python3
"""Hold OMP's native Linux session lease until the desktop closes stdin.

Interop: can1357/oh-my-pi packages/utils/src/file-lock.ts,
session/session-storage.ts and crates/pi-natives/src/file_lock/{mod,linux}.rs.
No session writes. Older native writers are additionally checked via /proc fds.
"""
import ctypes
import ctypes.util
import errno
import json
import os
from pathlib import Path
import re
import socket
import sys
from launch_wsl import interactive_environment


def lock_name(lock_path):
    library = ctypes.util.find_library('xxhash')
    if not library:
        raise RuntimeError('无法加载 OMP 锁兼容库 libxxhash，文件已保留')
    xxhash = ctypes.CDLL(library).XXH64
    xxhash.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_ulonglong]
    xxhash.restype = ctypes.c_ulonglong
    data = os.fsencode(lock_path)
    return 'omp-file-lock-' + ''.join(f'{xxhash(data, len(data), seed):016x}' for seed in (0x4f4d502d4c4f434b, 0x50492d46494c454c))


def reject_open_writers(files):
    identities = set()
    directories = [os.path.realpath(file) + '/' for file in files if os.path.isdir(file)]
    for file in files:
        try:
            stat = os.stat(file)
            identities.add((stat.st_dev, stat.st_ino))
        except FileNotFoundError:
            pass  # Restore can reserve a journal before it exists.
    for process in Path('/proc').iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            for fd in (process / 'fd').iterdir():
                try:
                    stat = fd.stat()
                    if (stat.st_dev, stat.st_ino) not in identities and not any(os.readlink(fd).startswith(directory) for directory in directories):
                        continue
                    flags = next(line.split()[1] for line in (process / 'fdinfo' / fd.name).read_text().splitlines() if line.startswith('flags:'))
                    if int(flags, 8) & os.O_ACCMODE:
                        raise RuntimeError('会话或备忘正在被其他进程写入，请先结束该会话再删除')
                except (FileNotFoundError, ProcessLookupError):
                    pass
        except (FileNotFoundError, ProcessLookupError):
            pass
        except PermissionError:
            # PAM, privileged shells and xdg-open may be non-dumpable. Native
            # OMP ownership is already excluded by the lease; fd inspection is
            # a compatibility check for older writers, not a process audit.
            name = (process / 'comm').read_text().strip()
            if name in ('omp', 'node', 'bun') or name.startswith('omp-'):
                raise RuntimeError('无法检查其他进程的会话占用，文件已保留')


def acquire(session_id, environment):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', session_id):
        raise ValueError('无效会话 ID')
    home = Path(environment.get('HOME', str(Path.home())))
    roots = {home / '.omp', home / environment.get('PI_CONFIG_DIR', '.omp')}
    # OMP's ownership directory is profile-independent. Cover explicit XDG and
    # the conventional fallback, regardless of whether migration has occurred.
    roots.add(Path(environment.get('XDG_STATE_HOME', str(home / '.local/state'))) / 'omp')
    locks = []
    try:
        for root in sorted(roots):
            lock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            locks.append(lock)
            lock.bind('\0' + lock_name(str(root / 'run/session-owners' / (session_id + '.lock'))))
        return locks
    except OSError as error:
        for lock in locks:
            lock.close()
        if error.errno == errno.EADDRINUSE:
            raise RuntimeError('原生 OMP 正在使用该会话，请先结束它的连接再删除') from error
        raise


def main():
    request = json.loads(sys.stdin.readline())
    locks = acquire(request['id'], interactive_environment())
    try:
        reject_open_writers(request['files'])
        print(json.dumps({'ready': True}), flush=True)
        sys.stdin.read()  # EOF on parent crash also releases the native leases.
    finally:
        for lock in locks:
            lock.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
