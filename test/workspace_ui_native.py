"""Drive the production Electron renderer against disposable real WSL Git."""
import argparse
import json
from pathlib import Path
import subprocess
from git_workspace_test import GitWorkspaceTests

parser=argparse.ArgumentParser();parser.add_argument('--node',required=True)
parser.add_argument('--storage-only',action='store_true');args=parser.parse_args()
fixture=GitWorkspaceTests('runTest');fixture.setUp()
try:
    if not args.storage_only:
        fixture.changed()
        remote=fixture.base/'remote.git'
        fixture.git('init','--bare','-q',str(remote))
        fixture.git('-C',str(fixture.member),'remote','add','origin',str(remote))
    options=fixture.base/'ui-options.json';options.write_text(json.dumps(dict(root=str(fixture.root),state=str(fixture.base/'ui-state'))))
    win=lambda p:subprocess.check_output(['wslpath','-w',str(p)],text=True).strip()
    root=Path(__file__).resolve().parents[1]
    command=[args.node,win(root/'node_modules/electron/cli.js'),win(root/'test/workspace-git-desktop.cjs'),'--options='+win(options)]
    if args.storage_only:
        command.append('--storage-only')
    result=subprocess.run(command,capture_output=True,text=True,timeout=180)
    print(result.stdout)
    if result.returncode:raise RuntimeError(result.stderr)
finally:fixture.doCleanups()
