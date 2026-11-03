"""Build/install a private Linux x64 OMP task runtime. System OMP is untouched."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

parser=argparse.ArgumentParser()
parser.add_argument('--checkout', type=Path, default=Path.home()/'.cache/lucyna-omp-tasks-v18.15.0')
parser.add_argument('--from-build', type=Path, help='Install an already built binary after native RPC validation')
parser.add_argument('--output', type=Path, default=Path.home()/'.local/share/lucyna/omp/18.15.0-tasks1/omp')
args=parser.parse_args()
if platform.system() != 'Linux' or platform.machine() not in ('x86_64','AMD64'):
    raise SystemExit('This installer builds Linux x64; other hosts retain capability-gated native OMP.')
here=Path(__file__).resolve().parent
source=args.checkout.resolve()
cache=Path.home()/'.cache/lucyna-runtime-tools'
cache.mkdir(parents=True,exist_ok=True)

def fetch(url,file,algorithm,expected):
    if not file.exists() or hashlib.new(algorithm,file.read_bytes()).hexdigest()!=expected:
        partial=file.with_suffix(file.suffix+'.download')
        with urllib.request.urlopen(url,timeout=120) as response, partial.open('wb') as output:
            shutil.copyfileobj(response,output)
        if hashlib.new(algorithm,partial.read_bytes()).hexdigest()!=expected:
            raise RuntimeError('Runtime download checksum mismatch')
        partial.replace(file)

if not args.from_build:
    if not source.exists():
        subprocess.run(['git','clone','--depth','1','--branch','v18.15.0','https://github.com/can1357/oh-my-pi.git',str(source)],check=True)
    subprocess.run([sys.executable,str(here/'apply.py'),str(source)],check=True)
    archive=cache/'bun-1.4.4.zip'
    fetch('https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip',archive,'sha256','bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c')
    bun=cache/'bun-linux-x64/bun'
    with zipfile.ZipFile(archive) as contents:
        bun.parent.mkdir(exist_ok=True)
        bun.write_bytes(contents.read('bun-linux-x64/bun'))
    bun.chmod(0o755)
    native=cache/'natives-18.15.0.tgz'
    integrity='rK5UD1Dvee7RLHS3ABfS2SRRcNEqQOYLHfI9Us8H38oW+qr9OMmiMiJ+JYDL2pPJz7FSMewsoAwi1vuuTrQrTg=='
    fetch('https://registry.npmjs.org/@oh-my-pi/pi-natives-linux-x64/-/pi-natives-linux-x64-18.15.0.tgz',native,'sha512',base64.b64decode(integrity).hex())
    with tarfile.open(native) as contents:
        for member in contents.getmembers():
            if member.isfile() and member.name.endswith('.node'):
                (source/'packages/natives/native'/Path(member.name).name).write_bytes(contents.extractfile(member).read())
    env=dict(os.environ,PATH=str(bun.parent)+os.pathsep+os.environ.get('PATH',''))
    for command in ([str(bun),'install','--frozen-lockfile'],[str(bun),'--bun','run','check:ts'],[str(bun),'test','packages/coding-agent/test/rpc-background-tasks.test.ts','packages/coding-agent/test/rpc-cancel-subagent.test.ts'],[str(bun),'packages/coding-agent/scripts/build-binary.ts']):
        subprocess.run(command,cwd=source,env=env,check=True)
    binary=source/'packages/coding-agent/dist/omp'
else:
    binary=args.from_build.resolve()
subprocess.run([sys.executable,str(here/'smoke.py'),str(binary)],check=True)
target=args.output.expanduser().resolve()
target.parent.mkdir(parents=True,exist_ok=True)
temporary=target.with_name('omp.installing')
shutil.copyfile(binary,temporary)
temporary.chmod(0o755)
temporary.replace(target)
shutil.copyfile(here/'OMP-LICENSE',target.with_name('OMP-LICENSE'))
manifest=dict(version='18.15.0-tasks1',sourceCommit='3fedf8d53267e32a6d7521ce725fdcc4a36fdc67',sha256=hashlib.sha256(target.read_bytes()).hexdigest(),patchSha256=hashlib.sha256((here/'omp-18.15.0-tasks.patch').read_bytes()).hexdigest())
target.with_name('manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Installed:',target)
