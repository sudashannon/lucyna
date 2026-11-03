"""Apply the version-pinned native RPC patch; never change an installed OMP."""
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
files = Path(__file__).resolve().parent
expected = '3fedf8d53267e32a6d7521ce725fdcc4a36fdc67'
if subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() != expected:
    raise SystemExit('Expected the pinned OMP v18.15.0 commit')
patch = files/'omp-18.15.0-tasks.patch'
check = subprocess.run(['git', '-C', str(root), 'apply', '--reverse', '--check', str(patch)], capture_output=True)
if check.returncode:
    subprocess.run(['git', '-C', str(root), 'apply', '--check', str(patch)], check=True)
    subprocess.run(['git', '-C', str(root), 'apply', str(patch)], check=True)
shutil.copyfile(files/'rpc-background-tasks.ts', root/'packages/coding-agent/src/modes/rpc/rpc-background-tasks.ts')
shutil.copyfile(files/'rpc-background-tasks.test.ts', root/'packages/coding-agent/test/rpc-background-tasks.test.ts')
print('Lucyna task RPC patch ready')
