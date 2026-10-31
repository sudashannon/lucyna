"""Minimal read-only Linux root for SSH command execution, without Python/network."""
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess


def make_sandbox(folder, user):
    root = folder/'rootfs'
    home = folder/'sealed-home'
    home.mkdir(mode=0o700)
    for directory in ('bin', 'usr/bin', 'lib', 'lib64', 'proc', 'dev', 'tmp', 'etc', 'home/'+user):
        (root/directory).mkdir(parents=True, exist_ok=True)
    commands = ['sh', 'uname', 'id', 'getconf', 'stat', 'mktemp', 'head', 'tar', 'gzip',
                'sha256sum', 'mkdir', 'rm', 'cat', 'readlink', 'true']
    copied = set()

    def copy(source, target):
        output = root/str(target).lstrip('/')
        if str(output) in copied:
            return
        copied.add(str(output))
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, output, follow_symlinks=True)

    for name in commands:
        source = shutil.which(name)
        if not source:
            raise RuntimeError('Missing fixture tool: '+name)
        copy(source, '/bin/'+name)
        output = subprocess.run(['ldd', source], capture_output=True, text=True, check=True).stdout
        for library in re.findall(r'(/[^\s()]+)', output):
            copy(library, library)
    # Base glibc ABI, deliberately no libpython or Python stdlib.
    libraries = subprocess.run(['/sbin/ldconfig', '-p'], capture_output=True, text=True, check=True).stdout
    for name in ('libdl.so.2', 'libm.so.6', 'libpthread.so.0', 'librt.so.1', 'libutil.so.1', 'libz.so.1'):
        match = re.search(r'^\s*'+re.escape(name)+r' .* => (\S+)$', libraries, re.MULTILINE)
        if not match:
            raise RuntimeError('Missing base OS library: '+name)
        copy(match.group(1), match.group(1))
    assert not any('python' in p.name.lower() for p in root.rglob('*'))
    (root/'etc/passwd').write_text(f'{user}:x:{os.getuid()}:{os.getgid()}::{"/home/"+user}:/bin/sh\n')
    wrapper = folder/'sealed-command.sh'
    arguments = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--ro-bind', str(root), '/',
                 '--bind', str(home), '/home/'+user, '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
                 '--chdir', '/home/'+user, '--clearenv', '--setenv', 'HOME', '/home/'+user,
                 '--setenv', 'PATH', '/bin:/usr/bin', '--', '/bin/sh', '-c']
    wrapper.write_text('#!/bin/sh\nexec '+shlex.join(arguments)+' "$SSH_ORIGINAL_COMMAND"\n')
    wrapper.chmod(0o700)
    return wrapper, home
