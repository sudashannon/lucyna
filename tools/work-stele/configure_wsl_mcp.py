#!/usr/bin/env python3
"""Install the local managed-knowledge bridge into a WSL OMP profile."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time


def configure(config_path, bridge, manifest, data, apply=False):
    config_path = Path(config_path)
    original = config_path.read_bytes()
    config = json.loads(original)
    servers = config.get('mcpServers')
    if not isinstance(servers, dict) or not isinstance(servers.get('stele'), dict):
        raise ValueError('The expected stele MCP entry is missing')
    old = servers['stele']
    new = {'type': 'stdio', 'command': 'python3', 'args': [bridge, '--knowledge-manifest', manifest, '--knowledge-data', data]}
    if old != new and not (old.get('type') == 'http' and old.get('url') in ('http://localhost:18989/mcp', 'http://127.0.0.1:18989/mcp')):
        raise ValueError('The stele entry is not the expected legacy configuration; it was preserved')
    if old == new:
        return {'changed': False, 'servers': len(servers)}
    if not Path(bridge).is_file() or not Path(manifest).is_file():
        raise ValueError('Lucyna bridge or engine manifest does not exist')
    updated = dict(config)
    updated['mcpServers'] = {**servers, 'stele': new}
    payload = (json.dumps(updated, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if not apply:
        return {'changed': True, 'servers': len(servers), 'applied': False}
    mode = config_path.stat().st_mode & 0o777
    backup = config_path.with_name(config_path.name + '.before-lucyna-' + str(time.time_ns()))
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(original)
        f.flush()
        os.fsync(f.fileno())
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix='.mcp-lucyna-', dir=config_path.parent)
        with os.fdopen(fd, 'wb') as f:
            os.fchmod(f.fileno(), mode)
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        if hashlib.sha256(config_path.read_bytes()).digest() != hashlib.sha256(original).digest():
            raise ValueError('The MCP configuration changed during installation; retry after checking it')
        os.replace(temporary, config_path)
        temporary = None
    finally:
        if temporary:
            os.unlink(temporary)
    return {'changed': True, 'servers': len(servers), 'applied': True, 'backup': str(backup)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--bridge', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--data', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(configure(args.config, args.bridge, args.manifest, args.data, args.apply)))
