"""Capture the selected Stele backend, never the developer's data or config."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
parser.add_argument('--destination', type=Path, default=Path(__file__).resolve().parents[1] / 'third_party')
args = parser.parse_args()
source = args.source.resolve()
target = args.destination / 'stele'
if target.exists():
    raise SystemExit('Snapshot already exists; review changes before replacing it')
files = list(source.glob('*.go'))
for folder in ['chat', 'internal', 'wiki']:
    files.extend((source / folder).rglob('*.go'))
files = [p for p in files if not p.name.endswith('_test.go')]
files.extend(source / p for p in ['go.mod', 'go.sum', 'assets/report.tmpl.html', 'wiki/taxonomy.yaml'])
hashes = {}
for file in sorted(files):
    relative = file.relative_to(source)
    dest = target / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    content = file.read_bytes()
    dest.write_bytes(content)
    hashes[relative.as_posix()] = hashlib.sha256(content).hexdigest()
(target / 'web/dist').mkdir(parents=True)
(target / 'web/dist/index.html').write_text('<!doctype html><meta charset="utf-8"><title>Lucyna Knowledge Engine</title><p>Managed by Lucyna.</p>\n', encoding='utf-8')
revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
(target / 'UPSTREAM.json').write_text(json.dumps({'project': 'Stele', 'revision': revision, 'files': hashes, 'note': 'Effective backend snapshot includes local extensions. Lucyna modifications are versioned alongside this manifest; the original web UI and user knowledge are excluded.'}, indent=2) + '\n')
package = source / 'node_modules/@ternlight/base'
embedding = args.destination / 'ternlight-base'
for relative in ['package.json', 'LICENSE', 'src/index.js', 'pkg-node/tern_engine.js', 'pkg-node/tern_engine_bg.wasm']:
    dest = embedding / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(package / relative, dest)
print(json.dumps({'backendFiles': len(files), 'revision': revision, 'embedding': 'ternlight-base@0.1.0'}))
