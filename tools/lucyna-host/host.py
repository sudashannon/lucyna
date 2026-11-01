"""Lucyna host protocol v1, private bridge and daemon-owned OMP sessions."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import socket
import socketserver
import stat
import struct
import sys
import threading
import re
import signal

# -I excludes the script directory. Only add this trusted release's own modules.
sys.dont_write_bytecode = True
if not getattr(sys, 'frozen', False):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    shared = Path(__file__).resolve().parents[1]/'work-runner'
    if shared.is_dir():
        sys.path.append(str(shared))
import host_runtime

PREFIX = b'LUCYNA_HOST_V1 '
LIMIT = 2*1024*1024


def metadata(state):
    identity = json.loads((state/'identity.json').read_text())
    release = json.loads((host_runtime.root()/'manifest.json').read_text())['release']
    return dict(protocolVersion=1, installationId=identity['installationId'],
                release=release, pid=os.getpid(), capabilities=['hello', 'ping', 'host.status'],
                ompSessionsSupported=False)


def respond(request, info, negotiated, manager=None):
    if not isinstance(request, dict) or request.get('version') != 1:
        raise ValueError('protocol_mismatch')
    request_id = request.get('id')
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
        raise ValueError('invalid_id')
    operation = request.get('op')
    if operation == 'hello':
        if 1 not in request.get('args', {}).get('protocolVersions', []):
            raise ValueError('protocol_mismatch')
        negotiated = True
    elif not negotiated:
        raise ValueError('hello_required')
    elif operation not in ('ping', 'host.status'):
        if manager is None:
            raise ValueError('unsupported_operation')
        data = manager.workspace.dispatch(operation, request.get('args', {})) if operation in getattr(manager, 'workspace_capabilities', []) else manager.dispatch(operation, request.get('args', {}))
        return dict(version=1, id=request_id, ok=True, data=data), negotiated
    return dict(version=1, id=request_id, ok=True, data=info), negotiated


def serve_stream(reader, writer, info, manager=None):
    negotiated = False
    while True:
        line = reader.readline(LIMIT+1)
        if not line:
            return
        if len(line) > LIMIT or not line.endswith(b'\n'):
            return
        request = None
        try:
            request = json.loads(line)
            response, negotiated = respond(request, info, negotiated, manager)
        except (ValueError, TypeError, AttributeError, KeyError, OSError) as error:
            response = dict(version=1, id=request.get('id') if isinstance(request, dict) else None,
                            ok=False, code=str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z_]+', str(error)) else 'invalid_request',
                            message=str(error)[:3000])
        # Match the UTF-8 byte limits used by the session replay buffer.
        try:encoded=json.dumps(response,separators=(',', ':'),ensure_ascii=False).encode()
        except UnicodeEncodeError:
            encoded=json.dumps(dict(version=1,id=request.get('id') if isinstance(request,dict) else None,ok=False,
                                    code='response_encoding_unsupported',message='文件名或内容无法以 UTF-8 传输，请在终端处理')).encode()
        if len(PREFIX)+len(encoded)+1>LIMIT:
            encoded=json.dumps(dict(version=1,id=request.get('id') if isinstance(request,dict) else None,ok=False,
                                    code='response_too_large',message='读取结果超过传输上限，请缩小范围')).encode()
        writer.write(PREFIX+encoded+b'\n')
        writer.flush()


def serve(state):
    lock = os.fdopen(os.open(state/'daemon.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'a+b')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    address = str(state/'control.sock')
    if len(os.fsencode(address)) >= 104:
        raise ValueError('socket_path_too_long')
    if os.path.lexists(address):
        entry = os.lstat(address)
        if not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != os.getuid():
            raise ValueError('unsafe_socket')
        os.unlink(address)  # daemon lock proves there is no other managed listener
    info = metadata(state)
    from sessions import SessionManager
    manager = SessionManager(state)
    from workspace import Workspace, CAPABILITIES
    manager.workspace = Workspace(state, manager)
    manager.workspace_capabilities = CAPABILITIES
    info.update(ompSessionsSupported=True, capabilities=info['capabilities']+[
        'workspace.inspect', 'session.create', 'session.attach', 'session.list', 'session.request', 'session.events', 'session.stop', 'operation.get', *CAPABILITIES])

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            _, uid, _ = struct.unpack('3i', self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid == os.getuid():
                try:
                    self.request.settimeout(60)
                    serve_stream(self.rfile, self.wfile, info, manager)
                except (OSError, TimeoutError):
                    pass

    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True
        request_queue_size = 16

    try:
        with Server(address, Handler) as server:
            os.chmod(address, 0o600)
            server.serve_forever()
    finally:
        manager.close()
        if os.path.exists(address):
            os.unlink(address)
        lock.close()


def bridge(state):
    with socket.socket(socket.AF_UNIX) as channel:
        channel.connect(str(state/'control.sock'))

        def send():
            try:
                while data := sys.stdin.buffer.read1(65536):
                    channel.sendall(data)
                channel.shutdown(socket.SHUT_WR)
            except OSError:
                pass

        threading.Thread(target=send, daemon=True).start()
        while data := channel.recv(65536):
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()


def main():
    os.umask(0o077)
    if sys.argv[1:2] == ['exec-omp']:
        import ctypes
        child_parser = argparse.ArgumentParser()
        child_parser.add_argument('--parent-pid', type=int, required=True)
        child_parser.add_argument('command', nargs=argparse.REMAINDER)
        child_args = child_parser.parse_args(sys.argv[2:])
        command = child_args.command[1:] if child_args.command[:1] == ['--'] else child_args.command
        if not command or ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
            raise SystemExit(1)
        if os.getppid() != child_args.parent_pid:
            raise SystemExit(1)
        os.execvpe(command[0], command, host_runtime.external_env())
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['self-test', 'stdio', 'serve', 'bridge', 'install'])
    parser.add_argument('--state')
    parser.add_argument('--source')
    parser.add_argument('--expected-release')
    parser.add_argument('--install-mode', choices=['connection', 'user-service'], default='user-service')
    parser.add_argument('--prefix')
    parser.add_argument('--upgrade',action='store_true')
    args = parser.parse_args()
    if args.mode == 'install':
        import install
        try:
            answer = install.install_frozen(args.source, args.expected_release,
                                            dict(mode=args.install_mode, prefix=args.prefix,upgrade=args.upgrade))
        except Exception as error:
            answer = dict(ok=False, code=str(error) if isinstance(error, ValueError) else type(error).__name__)
        print('LUCYNA_HOST_V1 '+json.dumps(answer), flush=True)
        return
    if args.mode == 'self-test':
        assert sys.version_info >= (3, 10)
        import sqlite3  # validate the frozen session runtime before activation
        assert sqlite3.sqlite_version
        import sessions
        import workspace
        return
    state = Path(args.state)
    entry = state.lstat()
    if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != os.getuid() or entry.st_mode & 0o077:
        raise ValueError('unsafe_state_directory')
    if args.mode == 'stdio':
        serve_stream(sys.stdin.buffer, sys.stdout.buffer, metadata(state))
    elif args.mode == 'serve':
        def shutdown(signum, frame):
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)
        serve(state)
    else:
        bridge(state)


if __name__ == '__main__':
    main()
