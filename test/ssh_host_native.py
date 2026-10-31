"""Opt-in WSL OpenSSH acceptance with temporary keys, sshd and user units."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import socket
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=150, **kwargs)


def windows_path(path):
    return run(['wslpath', '-w', str(path)]).stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True, help='WSL path of Windows node.exe')
    parser.add_argument('--report', required=True)
    parser.add_argument('--bundle', help='Linux path of frozen index.json')
    parser.add_argument('--sealed', action='store_true', help='Run SSH commands in a no-Python, no-network root')
    parser.add_argument('--sessions', action='store_true')
    parser.add_argument('--desktop', action='store_true', help='Production Electron settings/session/restart acceptance')
    parser.add_argument('--omp', help='Real OMP executable for isolated no-model RPC acceptance')
    args = parser.parse_args()
    if args.sealed and not args.bundle:
        parser.error('--sealed requires --bundle')
    os.umask(0o077)
    report = {'transport': 'WSL OpenSSH to isolated loopback sshd', 'scenarios': []}
    with tempfile.TemporaryDirectory(prefix='.lh-', dir=Path.home()) as directory:
        folder = Path(directory)
        for key in ('server', 'client'):
            run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(folder/key)])
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        user = pwd.getpwuid(os.getuid()).pw_name
        forced = ''
        if args.sealed:
            from ssh_host_sandbox import make_sandbox
            wrapper, sealed_home = make_sandbox(folder, user)
            forced = 'ForceCommand '+str(wrapper)+'\n'
        sshd_config = folder/'sshd_config'
        sshd_config.write_text(f'''Port {port}
ListenAddress 127.0.0.1
HostKey {folder}/server
PidFile {folder}/sshd.pid
AuthorizedKeysFile {folder}/client.pub
AllowUsers {user}
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes yes
LogLevel ERROR
{forced}
''')
        public = ' '.join((folder/'server.pub').read_text().split()[:2])
        (folder/'known_hosts').write_text(f'[127.0.0.1]:{port} {public}\n')
        (folder/'ssh_config').write_text(f'''Host fixture
 HostName 127.0.0.1
 Port {port}
 User {user}
 IdentityFile {folder}/client
 IdentitiesOnly yes
 UserKnownHostsFile {folder}/known_hosts
''')
        profile = folder/'profile.json'
        profile.write_text(json.dumps({'destination': 'fixture', 'configFile': str(folder/'ssh_config'),
                                      'executor': {'kind': 'wsl-openssh', 'distro': 'Ubuntu-22.04', 'user': user}}))
        units = []
        with open(folder/'sshd.log', 'w') as log:
            sshd = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', str(sshd_config)], stdout=log, stderr=log)
            try:
                for _ in range(100):
                    if sshd.poll() is not None:
                        raise RuntimeError('isolated sshd failed: '+(folder/'sshd.log').read_text())
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=.2):
                            break
                    except OSError:
                        time.sleep(.05)
                run(['ssh', '-F', str(folder/'ssh_config'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'fixture', 'true'])
                if args.sealed:
                    probe = run(['ssh', '-F', str(folder/'ssh_config'), 'fixture',
                                 'command -v python3 || true; command -v python || true; cat /proc/net/route; readlink /proc/self/ns/net']).stdout.splitlines()
                    assert len(probe) == 2 and probe[0].startswith('Iface')
                    assert probe[1] != os.readlink('/proc/self/ns/net')
                    report.update(systemPythonAbsent=True, networkIsolated=True, readOnlyRoot=True)
                    for fault, expected in [('truncate', 'upload_incomplete'), ('corrupt', 'archive_digest_mismatch')]:
                        result = json.loads(run([args.node, windows_path(ROOT/'test/fixtures/deploy-frozen.cjs'),
                                                 windows_path(profile), windows_path(args.bundle),
                                                 '/home/'+user+'/connection', fault]).stdout)
                        assert result.get('code') == expected, result
                        assert not (sealed_home/'connection').exists(), 'failed upload wrote installation'
                        assert not list(sealed_home.glob('.lucyna-bootstrap.*')), 'failed upload leaked staging'
                    report['uploadFailureRecovery'] = ['truncate', 'corrupt']
                if args.desktop:
                    if not args.bundle:
                        raise RuntimeError('--desktop requires --bundle')
                    work = folder/'desktop-work'
                    work.mkdir()
                    (work/'SESSION.md').write_text('# SSH 桌面验收\n\n独立测试工作区。\n')
                    agent_dir = work/'agent'
                    agent_dir.mkdir(mode=0o700)
                    fake = folder/'fake-omp'
                    shutil.copyfile(ROOT/'test/fixtures/remote-fake-omp.py', fake)
                    fake.chmod(0o700)
                    desktop_options = folder/'desktop-options.json'
                    desktop_options.write_text(json.dumps(dict(ssh=json.loads(profile.read_text()), root=str(work),
                        agentDir=str(agent_dir), fakeOmp=str(fake), realOmp=args.omp,
                        prefix=str(folder/'d'), bundle=windows_path(args.bundle),
                        output=windows_path(ROOT/'.runtime/ssh-desktop'/str(int(time.time()))))))
                    try:
                        report['desktop'] = json.loads(run([args.node, windows_path(ROOT/'test/ssh-host-desktop.cjs'),
                            '--options='+windows_path(desktop_options)]).stdout)
                    finally:
                        for state in (folder/'d').glob('*/state'):
                            units.append('lucyna-host-test-'+hashlib.sha256(str(state).encode()).hexdigest()[:12]+'.service')
                for mode in (() if args.desktop else ('connection',) if args.sealed else ('connection', 'user-service')):
                    prefix = Path('/home/'+user)/mode if args.sealed else folder/mode
                    if mode == 'user-service':
                        units.append('lucyna-host-test-'+hashlib.sha256(str(prefix/'state').encode()).hexdigest()[:12]+'.service')
                    command = [args.node, windows_path(ROOT/'tools/ssh-host.cjs'), windows_path(profile), '--prefix='+str(prefix)]
                    command.append('--bundle='+windows_path(args.bundle) if args.bundle else '--source')
                    if mode == 'connection':
                        command.append('--connection')
                    first = json.loads(run(command).stdout)
                    second = json.loads(run(command).stdout)
                    assert not first['reused'] and second['reused']
                    assert first['installationId'] == second['installationId']
                    assert first['release'] == second['release']
                    if mode == 'user-service':
                        assert first['hello']['pid'] == second['hello']['pid'], 'repeat deployment restarted the service'
                    report['scenarios'].append({'mode': mode, 'firstInstall': True, 'repeatReuse': True,
                                                'stableIdentity': True, 'sameDaemon': mode == 'user-service',
                                                'format': first.get('format'), 'release': first['release'], 'persistenceVerified': False})
                    if mode == 'user-service' and args.sessions:
                        installed_file = folder/'installed.json'
                        installed_file.write_text(json.dumps(first))
                        fake = folder/'fake-omp'
                        shutil.copyfile(ROOT/'test/fixtures/remote-fake-omp.py', fake)
                        fake.chmod(0o700)
                        report['sessions'] = []
                        for executable in ([str(fake), args.omp] if args.omp else [str(fake)]):
                            work = folder/('fake-work' if executable == str(fake) else 'real-work')
                            work.mkdir()
                            agent_dir = work/'agent'
                            agent_dir.mkdir(mode=0o700)
                            session_options = folder/'session-options.json'
                            session_options.write_text(json.dumps(dict(root=str(work), omp=executable,
                                                                       agentDir=str(agent_dir), fake=executable == str(fake))))
                            result = json.loads(run([args.node, windows_path(ROOT/'test/fixtures/ssh-session-native.cjs'),
                                                     windows_path(profile), windows_path(installed_file), windows_path(session_options)]).stdout)
                            report['sessions'].append(result)
                if args.sealed:
                    assert not list(sealed_home.glob('.lucyna-bootstrap.*')), 'staging directories leaked'
            except subprocess.CalledProcessError as error:
                raise RuntimeError(error.stderr+'\nFixture sshd: '+(folder/'sshd.log').read_text()) from error
            finally:
                for unit in units:
                    subprocess.run(['systemctl', '--user', 'disable', '--now', unit], capture_output=True, timeout=30)
                    unit_file = Path.home()/'.config/systemd/user'/unit
                    if unit_file.exists() and unit_file.read_text().startswith('# Managed by Lucyna SSH Host v1\n'):
                        unit_file.unlink()
                if units:
                    subprocess.run(['systemctl', '--user', 'daemon-reload'], capture_output=True, timeout=30)
                sshd.terminate()
                sshd.wait(timeout=10)
    report['cleanedUp'] = True
    destination = Path(args.report)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
