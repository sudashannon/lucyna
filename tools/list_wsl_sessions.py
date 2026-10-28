#!/usr/bin/env python3
"""Read only OMP session headers and titles for one work root, never transcript bodies."""
import json
import os
from pathlib import Path
import sys
from runtime_config import load_runtime

def main():
    if len(sys.argv) not in (2, 3):
        raise ValueError('work root required')
    root = Path(sys.argv[1]).resolve(strict=True)
    runtime = load_runtime()
    allowed = runtime['workRoot'].resolve(strict=True)
    if allowed not in root.parents or not (root / 'SESSION.md').is_file():
        raise ValueError('invalid work root')
    agent = Path(sys.argv[2]) if len(sys.argv) == 3 else runtime['wslAgentDir']
    if not agent.is_absolute() or '..' in agent.parts:
        raise ValueError('invalid agent directory')
    sessions = agent / 'sessions'
    out = []
    for bucket in sessions.iterdir() if sessions.exists() else []:
        if not bucket.is_dir() or bucket.is_symlink():
            continue
        for file in bucket.iterdir():
            if file.is_symlink() or not file.name.endswith('.jsonl') or not file.is_file():
                continue
            try:
                with file.open('rb') as f:
                    first = f.readline(65537)
                    if len(first) > 65536:
                        continue
                    first_record = json.loads(first)
                    second = f.readline(65537) if first_record.get('type') != 'session' else b''
                if len(second) > 65536:
                    continue
                records = [first_record] + ([json.loads(second)] if second.strip() else [])
                header = next((x for x in records if x.get('type') == 'session'), None)
                if not header or not isinstance(header.get('cwd'), str):
                    continue
                cwd = Path(header['cwd'])
                if cwd != root and root not in cwd.parents:
                    continue
                title = next((x.get('title') for x in records if x.get('type') == 'title' and isinstance(x.get('title'), str)), '')
                out.append({'path': str(file), 'id': str(header.get('id', ''))[:128], 'title': title[:200], 'cwd': str(cwd), 'modified': file.stat().st_mtime})
            except (OSError, ValueError, TypeError, AttributeError):
                continue
    out.sort(key=lambda x: x['modified'], reverse=True)
    print(json.dumps({'sessions': out[:200], 'total': len(out)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
