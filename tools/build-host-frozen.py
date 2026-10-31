"""Build a Linux host distribution; run with the locked build environment."""
import argparse
import gzip
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import tempfile

SOURCE = Path(__file__).resolve().parent/'lucyna-host'
sys.path.insert(0, str(SOURCE))
import artifacts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64'):
        raise SystemExit('Build on the target Linux architecture')
    if importlib.metadata.version('pyinstaller') != '6.22.3':
        raise SystemExit('Install requirements-build.txt in an isolated build environment')
    libc, libc_version = platform.libc_ver()
    if libc != 'glibc':
        raise SystemExit('Only glibc builds are supported')
    destination = Path(args.output).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    target = dict(os='Linux', arch=platform.machine(), glibcMin=libc_version,
                  python=platform.python_version(), pyinstaller='6.22.3')
    with tempfile.TemporaryDirectory(prefix='lucyna-freeze-') as temporary:
        work = Path(temporary)
        env = dict(os.environ, PYINSTALLER_CONFIG_DIR=str(work/'cache'), SOURCE_DATE_EPOCH='0', PYTHONHASHSEED='0')
        subprocess.run([sys.executable, '-m', 'PyInstaller', '--onedir', '--noupx',
                        '--name', 'lucyna-host', '--paths', str(SOURCE.parent/'work-runner'), '--distpath', str(work/'dist'),
                        '--workpath', str(work/'build'), '--specpath', str(work),
                        str(SOURCE/'host.py')], check=True, env=env)
        folder = work/'dist/lucyna-host'
        manifest = artifacts.create_manifest(folder, target)
        (folder/'manifest.json').write_bytes(artifacts.canonical(manifest)+b'\n')
        artifacts.validate_directory(folder, manifest['release'])
        subprocess.run([folder/'lucyna-host', 'self-test'], check=True, env=env, timeout=20)
        name = 'host-linux-'+target['arch']+'.tar.gz'
        archive = destination/name
        stage = destination/(name+'.tmp')
        with stage.open('wb') as output, gzip.GzipFile(filename='', fileobj=output, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as tar:
                for path in sorted(folder.rglob('*')):
                    relative = path.relative_to(folder).as_posix()
                    info = tar.gettarinfo(str(path), relative)
                    info.uid = info.gid = 0
                    info.uname = info.gname = ''
                    info.mtime = 0
                    info.mode = 0o700 if info.isdir() or info.mode & 0o111 else 0o600
                    info.pax_headers = {}
                    if info.isfile():
                        with path.open('rb') as stream:
                            tar.addfile(info, stream)
                    else:
                        tar.addfile(info)
        os.replace(stage, archive)
        index = dict(version=2, format='pyinstaller-onedir', release=manifest['release'], target=target,
                     archive=name, bytes=archive.stat().st_size,
                     sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
                     buildDependencies={name: importlib.metadata.version(name) for name in
                                        ('pyinstaller', 'pyinstaller-hooks-contrib', 'altgraph', 'packaging', 'setuptools')})
        index_path = destination/'index.json'
        temporary_index = destination/'index.json.tmp'
        temporary_index.write_text(json.dumps(index, indent=2)+'\n')
        os.replace(temporary_index, index_path)
        print(json.dumps(dict(index=str(index_path), **index)))


if __name__ == '__main__':
    main()
