#!/usr/bin/env python3
"""Launch native OMP with the user's interactive login environment.

Shell startup output is captured, never mixed into RPC stdout. Credentials stay
in process memory; arguments are passed literally, not interpolated into a shell.
"""
import os
import pwd
import subprocess
import sys

MARKER = b'\0LUCYNA_ENV\0'


def interactive_environment():
    shell = pwd.getpwuid(os.getuid()).pw_shell or '/bin/bash'
    result = subprocess.run(
        [shell, '-ilc', "printf '\\0LUCYNA_ENV\\0'; exec /usr/bin/env -0"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=25, check=True,
    )
    if MARKER not in result.stdout:
        raise RuntimeError('Shell did not return an environment')
    payload = result.stdout.split(MARKER, 1)[1]
    return {os.fsdecode(key): os.fsdecode(value) for entry in payload.split(b'\0')
            if b'=' in entry for key, value in [entry.split(b'=', 1)]}


def main():
    if len(sys.argv) < 4 or sys.argv[1] != '--agent-dir':
        raise ValueError('Expected --agent-dir DIRECTORY EXECUTABLE [ARGS...]')
    environment = interactive_environment()
    environment['PI_CODING_AGENT_DIR'] = sys.argv[2]
    environment['OMP_PROFILE'] = ''
    os.execvpe(sys.argv[3], sys.argv[3:], environment)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not print shell output, commands, or environment values.
        print('WSL environment startup failed (' + type(error).__name__ + '). Check your interactive shell startup files.', file=sys.stderr)
        sys.exit(1)
