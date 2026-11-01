"""Authenticated bundle installer. First install/reuse; live upgrades fail closed."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
import sqlite3

MARKER = '# Managed by Lucyna SSH Host v1\n'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def install_lock(stream):
    deadline = time.monotonic()+30
    while True:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise ValueError('installation_busy')
            time.sleep(.05)


def checked_directory(value):
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts or any(c in str(path) for c in '\0\r\n'):
        raise ValueError('unsafe_directory')
    for parent in reversed([path, *path.parents]):
        if parent.is_symlink():
            raise ValueError('symlink_directory')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    entry = path.stat()
    if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != os.getuid() or entry.st_mode & 0o077:
        raise ValueError('unsafe_directory_permissions')
    return path


def atomic_json(file, value):
    if file.is_symlink():
        raise ValueError('symlink_file')
    temporary = file.with_name(file.name+'.'+uuid.uuid4().hex+'.tmp')
    with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w', encoding='utf8') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)


def read_json(file):
    if file.is_symlink() or file.stat().st_size > 65536:
        raise ValueError('unsafe_metadata')
    return json.loads(file.read_text())


def atomic_text(file,value):
    temporary=file.with_name(file.name+'.'+uuid.uuid4().hex+'.tmp')
    try:
        with os.fdopen(os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600),'w',encoding='utf-8') as stream:
            stream.write(value);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,file)
    finally:temporary.unlink(missing_ok=True)


SOURCES = {'host.py', 'install.py', 'host_runtime.py', 'artifacts.py', 'sessions.py', 'protocol.py',
           'workspace.py', 'git_workspace.py', 'workspace_files.py', 'work-details.py', 'work-inventory.py'}


def validate(bundle):
    if bundle.get('version') != 1 or set(bundle.get('files', {})) != SOURCES:
        raise ValueError('invalid_manifest')
    files = {}
    for name, item in bundle['files'].items():
        data = base64.b64decode(item['data'], validate=True)
        if len(data) > 512*1024 or digest(data) != item['sha256']:
            raise ValueError('file_digest_mismatch')
        compile(data, name, 'exec')
        files[name] = data
    content = ''.join(name+'\0'+digest(files[name])+'\n' for name in sorted(files))
    if digest(content.encode()) != bundle.get('release'):
        raise ValueError('release_digest_mismatch')
    return files


def unit_arg(value):
    return '"'+str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$')+'"'


def systemctl(*args):
    return subprocess.run(['systemctl', '--user', *args], capture_output=True, timeout=25,
                          env=dict(child_env(), XDG_RUNTIME_DIR='/run/user/'+str(os.getuid())))


def child_env():
    if getattr(sys, 'frozen', False):
        import host_runtime
        return host_runtime.external_env()
    return dict(os.environ)


def launch(directory, frozen):
    return [str(directory/'lucyna-host')] if frozen else [sys.executable, '-I', str(directory/'host.py')]


def hello(state):
    with socket.socket(socket.AF_UNIX) as channel:
        channel.settimeout(2)
        channel.connect(str(state/'control.sock'))
        channel.sendall(b'{"version":1,"id":"health","op":"hello","args":{"protocolVersions":[1]}}\n')
        line = channel.makefile('rb').readline(65537)
        if not line.startswith(b'LUCYNA_HOST_V1 ') or len(line) > 65536:
            raise ValueError('invalid_health_response')
        response = json.loads(line[len(b'LUCYNA_HOST_V1 '):])
        if not response.get('ok') or response.get('id') != 'health':
            raise ValueError('unhealthy_service')
        return response['data']


def unit_content(command,state):
    return (MARKER+'[Unit]\nDescription=Lucyna SSH host\n[Service]\nType=simple\n'
            'ExecStart='+' '.join(unit_arg(arg) for arg in [*command,'serve','--state',str(state)])+'\n'
            'UMask=0077\nRestart=on-failure\nRestartSec=3\nKillMode=control-group\nTimeoutStopSec=10\n'
            '[Install]\nWantedBy=default.target\n')


def stop_idle_service(state,unit):
    # Lock durable admission before the idle check and service stop. An old
    # host cannot create a session between this check and stopping its cgroup.
    connections=[]
    try:
        for file,query in [(state/'sessions.sqlite3','SELECT record FROM sessions'),
                           (state/'git/operations.sqlite',"SELECT status FROM operations WHERE status IN ('queued','running')")]:
            if not file.exists():continue
            if file.is_symlink():raise ValueError('unsafe_database')
            db=sqlite3.connect(file,timeout=5);connections.append(db);db.execute('BEGIN IMMEDIATE')
            rows=db.execute(query).fetchall()
            if file.name=='sessions.sqlite3':rows=[r for r in rows if json.loads(r[0])['status'] in ('starting','live')]
            if rows:raise ValueError('upgrade_busy')
        if systemctl('stop',unit).returncode or systemctl('is-active','--quiet',unit).returncode==0:
            raise ValueError('upgrade_stop_failed')
    finally:
        for db in connections:db.rollback();db.close()


def install(bundle, options):
    files = validate(bundle)  # validation precedes any remote filesystem changes
    return install_package(bundle['release'], options, files=files)


def install_frozen(source, expected_release, options):
    import artifacts
    source = Path(source)
    artifacts.validate_directory(source, expected_release)
    return install_package(expected_release, options, source=source)


def install_package(release_id, options, files=None, source=None):
    frozen = source is not None
    mode = options.get('mode')
    if mode not in ('connection', 'user-service'):
        raise ValueError('invalid_mode')
    prefix = options.get('prefix')
    home_dir = Path.home()
    data = checked_directory(Path(prefix)/'data' if prefix else home_dir/'.local/share/lucyna/host')
    state = checked_directory(Path(prefix)/'state' if prefix else home_dir/'.local/state/lucyna/host')
    if len(os.fsencode(str(state/'control.sock'))) >= 104:
        raise ValueError('socket_path_too_long')
    lock_path = state/'install.lock'
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'a+b') as lock:
        install_lock(lock)
        identity_file = state/'identity.json'
        if identity_file.exists():
            identity = read_json(identity_file)
            if identity.get('owner') != 'lucyna-host-v1' or not isinstance(identity.get('installationId'), str):
                raise ValueError('foreign_installation')
        else:
            if any(p.name != 'install.lock' for p in state.iterdir()) or any(data.iterdir()):
                raise ValueError('unmanaged_installation_directory')
            identity = dict(owner='lucyna-host-v1', installationId=str(uuid.uuid4()))
            atomic_json(identity_file, identity)
        releases = checked_directory(data/'releases')
        release = releases/release_id
        reused = release.exists()
        if reused and frozen:
            import artifacts
            artifacts.validate_directory(release, release_id)
        elif reused:
            if release.is_symlink() or not release.is_dir() or set(p.name for p in release.iterdir()) != SOURCES | {'manifest.json'}:
                raise ValueError('release_modified')
            for name, expected in files.items():
                file = release/name
                if file.is_symlink() or not file.is_file() or file.stat().st_size != len(expected) or file.read_bytes() != expected:
                    raise ValueError('release_modified')
            if read_json(release/'manifest.json') != dict(release=release_id, protocolVersion=1):
                raise ValueError('release_modified')
        else:
            stage = Path(tempfile.mkdtemp(prefix='staging-', dir=data))
            try:
                if frozen:
                    import artifacts
                    shutil.copytree(source, stage, symlinks=True, dirs_exist_ok=True)
                    artifacts.validate_directory(stage, release_id)
                else:
                    for name, content in files.items():
                        (stage/name).write_bytes(content)
                    atomic_json(stage/'manifest.json', dict(release=release_id, protocolVersion=1))
                check = subprocess.run([*launch(stage, frozen), 'self-test'], capture_output=True,
                                       timeout=20, env=child_env())
                if check.returncode:
                    raise ValueError('candidate_self_test_failed')
                os.rename(stage, release)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
        current_file = state/'active.json'
        current = read_json(current_file) if current_file.exists() else None
        upgrading=bool(current and (current['release']!=release_id or current['mode']!=mode))
        if upgrading and (not options.get('upgrade') or mode!='user-service' or current['mode']!=mode):raise ValueError('update_pending')
        command = launch(release, frozen)
        entry = release/('lucyna-host' if frozen else 'host.py')
        unit_name = 'lucyna-host.service' if not prefix else 'lucyna-host-test-'+digest(str(state).encode())[:12]+'.service'
        if mode == 'user-service':
            unit_dir = home_dir/'.config/systemd/user'
            # This shared systemd directory may be 0755; only the owned unit is modified.
            for parent in [unit_dir, *unit_dir.parents]:
                if parent.is_symlink():
                    raise ValueError('symlink_unit_directory')
            unit_dir.mkdir(parents=True, exist_ok=True)
            unit = unit_dir/unit_name
            content = unit_content(command,state)
            previous_content=unit_content(launch(releases/current['release'],current.get('format')=='frozen'),state) if upgrading else content
            existed = os.path.lexists(unit)
            journal=state/'upgrade.json'
            resumed=upgrading and journal.exists() and read_json(journal)==dict(previous=current['release'],candidate=release_id)
            if upgrading and not existed:raise ValueError('unit_conflict')
            if existed and (unit.is_symlink() or unit.read_text() not in ([previous_content,content] if resumed else [previous_content])):
                raise ValueError('unit_conflict')
            if systemctl('show-environment').returncode:
                raise ValueError('user_service_unavailable')
            if not existed:
                # Exclusive create: never overwrite another installer or manual unit.
                with open(unit, 'x', encoding='utf8') as stream:
                    stream.write(content)
            elif upgrading:
                atomic_json(journal,dict(previous=current['release'],candidate=release_id))
                stop_idle_service(state,unit_name)
            try:
                if upgrading:atomic_text(unit,content)
                for args in [('daemon-reload',), ('enable', unit_name), ('start', unit_name)]:
                    if systemctl(*args).returncode:
                        raise ValueError('service_start_failed')
                deadline = time.monotonic()+10
                while True:
                    try:
                        health = hello(state)
                        if health['release'] != release_id or health['installationId'] != identity['installationId']:
                            raise ValueError('service_identity_mismatch')
                        break
                    except (OSError, TimeoutError):
                        if time.monotonic() >= deadline:
                            raise ValueError('service_health_timeout')
                        time.sleep(.1)
            except Exception:
                if upgrading:
                    systemctl('stop',unit_name)
                    atomic_text(unit,previous_content)
                    systemctl('daemon-reload')
                    if systemctl('start',unit_name).returncode:raise ValueError('upgrade_rollback_failed') from None
                elif not existed:
                    systemctl('disable', '--now', unit_name)
                    unit.unlink(missing_ok=True)
                    systemctl('daemon-reload')
                raise
        atomic_json(current_file, dict(release=release_id, mode=mode, format='frozen' if frozen else 'source'))
        (state/'upgrade.json').unlink(missing_ok=True)
        return dict(ok=True, release=release_id, installationId=identity['installationId'],
                    mode=mode, entry=str(entry), state=str(state), reused=reused,
                    launcher=command, format='frozen' if frozen else 'source',
                    serviceUnit=unit_name if mode == 'user-service' else None,
                    persistenceVerified=False)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        answer = install(BUNDLE, OPTIONS)
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) else type(error).__name__
        answer = dict(ok=False, code=code)
    print('LUCYNA_HOST_V1 '+json.dumps(answer), flush=True)
