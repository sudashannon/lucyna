"""Versioned frozen-package manifests shared by the packer and installer."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat

MAX_BYTES = 256*1024*1024
MAX_FILES = 4096


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def safe_name(name):
    path = PurePosixPath(name)
    if not isinstance(name, str) or not name or path.is_absolute() or str(path) != name or any(
            part in ('.', '..') for part in path.parts) or any(c in name for c in '\\\0\r\n'):
        raise ValueError('unsafe_package_path')
    return name


def inventory(root):
    root = Path(root).resolve()
    entries, total = [], 0
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if name == 'manifest.json':
            continue
        safe_name(name)
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            target = os.readlink(path)
            if os.path.isabs(target) or any(c in target for c in '\\\0\r\n'):
                raise ValueError('unsafe_package_link')
            try:
                resolved = path.resolve(strict=True)
                resolved.relative_to(root)
            except (ValueError, OSError, RuntimeError):
                raise ValueError('unsafe_package_link') from None
            if not resolved.is_file():
                raise ValueError('unsafe_package_link')
            entries.append(dict(path=name, kind='symlink', target=target))
        elif stat.S_ISDIR(mode):
            continue
        elif stat.S_ISREG(mode):
            size = path.stat().st_size
            total += size
            if total > MAX_BYTES:
                raise ValueError('package_too_large')
            entries.append(dict(path=name, kind='file', bytes=size,
                                executable=bool(mode & 0o111), sha256=sha256(path.read_bytes())))
        else:
            raise ValueError('unsafe_package_entry')
        if len(entries) > MAX_FILES:
            raise ValueError('package_too_many_files')
    return entries


def create_manifest(root, target):
    content = dict(version=2, format='pyinstaller-onedir', target=target, files=inventory(root))
    return dict(content, release=sha256(canonical(content)))


def validate_directory(root, expected_release):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('unsafe_package_directory')
    manifest = root/'manifest.json'
    if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 2*1024*1024:
        raise ValueError('invalid_manifest')
    value = json.loads(manifest.read_bytes())
    if set(value) != {'version', 'format', 'target', 'files', 'release'} or value['version'] != 2 or value['format'] != 'pyinstaller-onedir':
        raise ValueError('invalid_manifest')
    content = {key: item for key, item in value.items() if key != 'release'}
    if value['release'] != expected_release or sha256(canonical(content)) != expected_release:
        raise ValueError('release_digest_mismatch')
    if value['files'] != inventory(root):
        raise ValueError('release_modified')
    if not any(item['path'] == 'lucyna-host' and item['kind'] == 'file' and item['executable'] for item in value['files']):
        raise ValueError('missing_host_executable')
    return value
