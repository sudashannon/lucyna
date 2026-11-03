"""Build the pinned backend with Go; no Go/Bun installation is used at runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--go', default='go')
parser.add_argument('--os', default='windows')
parser.add_argument('--arch', default='amd64')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
source = root / 'third_party/stele'
out = root / 'resources/knowledge-engine'
out.mkdir(parents=True, exist_ok=True)
hashes = {p.relative_to(source).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(source.rglob('*')) if p.is_file()}
source_hash = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
name = 'stele-' + source_hash[:16] + ('.exe' if args.os == 'windows' else '')
environment = {**os.environ, 'CGO_ENABLED': '0', 'GOOS': args.os, 'GOARCH': args.arch}
subprocess.run([args.go, 'build', '-trimpath', '-ldflags=-s -w', '-o', str(out / name), '.'], cwd=source, env=environment, check=True)
manifest = {'schema': 1, 'platform': args.os, 'arch': args.arch, 'binary': name, 'sha256': hashlib.sha256((out / name).read_bytes()).hexdigest(), 'sourceHash': source_hash}
embedding = root / 'third_party/ternlight-base'
manifest['embeddingFiles'] = {p.relative_to(embedding).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(embedding.rglob('*')) if p.is_file()}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
