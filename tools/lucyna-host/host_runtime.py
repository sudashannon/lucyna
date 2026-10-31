"""Launch source and frozen hosts without leaking the freezer's library paths."""
import os
from pathlib import Path
import sys
import pwd
import re
import select
import signal
import subprocess
import time
import uuid


def root():
    return Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent


def launcher(directory):
    directory = Path(directory)
    if (directory/'lucyna-host').is_file():
        return [str(directory/'lucyna-host')]
    return [sys.executable, '-I', str(directory/'host.py')]


def external_env():
    env = dict(os.environ)
    if getattr(sys, 'frozen', False):
        original = env.pop('LD_LIBRARY_PATH_ORIG', None)
        if original is None:
            env.pop('LD_LIBRARY_PATH', None)
        else:
            env['LD_LIBRARY_PATH'] = original
        for key in tuple(env):
            if key.startswith('_PYI_'):
                env.pop(key)
        env['PYINSTALLER_RESET_ENVIRONMENT'] = '1'
    return env


def login_env():
    """Read the remote user's login environment in memory, never return it over RPC."""
    marker = 'LUCYNA_ENV_'+uuid.uuid4().hex
    shell = pwd.getpwuid(os.getuid()).pw_shell or '/bin/sh'
    process = subprocess.Popen([shell, '-lc', "printf '\\0"+marker+"\\0'; env -0"],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env=external_env(), start_new_session=True)
    output = bytearray()
    deadline = time.monotonic()+10
    try:
        while True:
            remaining = deadline-time.monotonic()
            if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                raise ValueError('login_environment_timeout')
            data = os.read(process.stdout.fileno(), 65536)
            if not data:
                break
            output.extend(data)
            if len(output) > 2*1024*1024:
                raise ValueError('login_environment_too_large')
        if process.wait(timeout=2) != 0:
            raise ValueError('login_environment_failed')
        start = output.find(b'\0'+marker.encode()+b'\0')
        if start < 0:
            raise ValueError('login_environment_failed')
        env = {}
        for item in output[start+len(marker)+2:].split(b'\0'):
            key, separator, value = item.partition(b'=')
            if separator and re.fullmatch(rb'[A-Za-z_][A-Za-z0-9_]*', key):
                env[key.decode()] = os.fsdecode(bytes(value))
        return env
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        process.stdout.close()
