"""Atomic immutable paste files in OMP's native Linux session artifact store."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import uuid

LIMIT = 4 * 1024 * 1024


def main():
    payload = json.load(sys.stdin)
    source = Path(payload['sessionFile'])
    if not source.is_absolute() or source.suffix != '.jsonl':
        raise ValueError('invalid native session path')
    files = payload['files']
    if not isinstance(files, list) or len(files) > 8:
        raise ValueError('invalid attachment count')
    total, ids, items = 0, set(), []
    for item in files:
        ident, text = item['id'], item['text']
        if not isinstance(ident, str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,100}', ident) or ident in ids or not isinstance(text, str) or not text:
            raise ValueError('invalid text attachment')
        data = text.encode('utf-8')
        total += len(data)
        if total > LIMIT:
            raise ValueError('text attachments exceed 4 MiB')
        ids.add(ident)
        items.append((ident, text, data))
    source.parent.mkdir(parents=True, exist_ok=True)
    artifact = source.with_suffix('')
    artifact.mkdir(exist_ok=True)
    # Hold directory descriptors so a concurrent rename cannot redirect writes.
    parent = os.open(artifact, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.mkdir('local', mode=0o700, dir_fd=parent)
        except FileExistsError:
            pass
        local = os.open('local', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)
    result = []
    try:
        for ident, text, data in items:
            name = 'paste-lucyna-' + hashlib.sha256(data).hexdigest()[:32] + '.md'
            temporary = '.lucyna-paste-' + uuid.uuid4().hex + '.tmp'
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=local)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(temporary, name, src_dir_fd=local, dst_dir_fd=local, follow_symlinks=False)
                except FileExistsError:
                    existing = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=local)
                    with os.fdopen(existing, 'rb') as stream:
                        if stream.read(LIMIT + 1) != data:
                            raise ValueError('existing text attachment differs; original preserved')
            finally:
                os.unlink(temporary, dir_fd=local)
            result.append({'id': ident, 'name': name, 'url': 'local://' + name,
                           'bytes': len(data), 'lines': len(re.split(r'\r\n|\r|\n', text))})
    finally:
        os.close(local)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
