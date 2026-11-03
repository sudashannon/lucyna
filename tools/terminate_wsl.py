#!/usr/bin/env python3
"""Terminate one Lucyna harness and its descendants, identified by launch token."""
import os
import re
import signal
import sys
import time


def identity(pid):
    try:
        with open(f'/proc/{pid}/stat') as stream:
            fields = stream.read().rsplit(') ', 1)[1].split()
        if fields[0] != 'Z':
            return int(fields[1]), fields[19]
    except (OSError, ValueError, IndexError):
        pass
    return None, None


def processes():
    result = {}
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid != os.getuid():
                continue
            pid = int(entry.name)
            value = identity(pid)
            if value[1] is not None:
                result[pid] = value
        except (OSError, ValueError, IndexError):
            pass
    return result


def terminate(token):
    if not re.fullmatch(r'[a-f0-9-]{36}', token):
        raise ValueError('Invalid session token')
    marker = ('LUCYNA_SESSION_TOKEN=' + token).encode()
    owned = {}

    def remaining():
        current = processes()
        for pid, identity in current.items():
            try:
                with open(f'/proc/{pid}/environ', 'rb') as stream:
                    if marker in stream.read().split(b'\0'):
                        owned[pid] = identity[1]
            except OSError:
                pass
        # Include tool children even if they deliberately cleared the environment.
        changed = True
        while changed:
            changed = False
            for pid, (parent, started) in current.items():
                if parent in owned and current.get(parent, (None, None))[1] == owned[parent] and pid not in owned:
                    owned[pid] = started
                    changed = True
        return {pid: started for pid, started in owned.items()
                if current.get(pid, (None, None))[1] == started}

    for sig, grace in [(signal.SIGTERM, 1.5), (signal.SIGKILL, 2.0)]:
        deadline = time.monotonic() + grace
        while True:
            live = remaining()
            if not live:
                return
            for pid, started in live.items():
                # Check start time again immediately before signaling to reject PID reuse.
                if identity(pid)[1] == started:
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            if time.monotonic() >= deadline:
                break
            time.sleep(0.05)
    raise RuntimeError('Session processes have not exited')


if __name__ == '__main__':
    terminate(sys.argv[1])
