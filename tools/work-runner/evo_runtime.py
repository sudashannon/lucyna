"""Pinned optional AntOmniEvo runtime; isolated from OMP and user Python packages."""
import json
from pathlib import Path
import shutil
import subprocess

REVISION = '050665afb1d4b8f12e02ae667cf9ebb7548bfc29'


def directory():
    return Path.home()/'.local/share/lucyna/ant-omnievo'/REVISION


def python():
    path = directory()/'venv/bin/python'
    if not path.is_file() or not (directory()/'installed.json').is_file():
        raise ValueError('AntOmniEvo 尚未安装，请从客户端创建进化实验')
    return str(path)


def install():
    target = directory()
    if (target/'installed.json').exists():
        return {'installed':True,'revision':REVISION}
    target.mkdir(parents=True,exist_ok=True)
    source = target/'source'
    commands = []
    if not (source/'.git').exists():
        commands.append(['git','clone','--no-checkout','https://github.com/ant-research/AntOmniEvo.git',str(source)])
    commands.extend([['git','-C',str(source),'checkout','--detach',REVISION],
        ['/usr/bin/python3','-m','venv',str(target/'venv')],
        [str(target/'venv/bin/python'),'-m','pip','install','--disable-pip-version-check',str(source)]])
    for command in commands:
        result = subprocess.run(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=180)
        if result.returncode:
            raise RuntimeError('AntOmniEvo 独立环境安装失败，请检查 GitHub/Python 包源连接；未修改全局 Python')
    subprocess.run([str(target/'venv/bin/python'),'-c','from antomnievo.optimizer.optimizer import Optimizer'],check=True,timeout=20)
    (target/'installed.json').write_text(json.dumps({'revision':REVISION}))
    return {'installed':True,'revision':REVISION}
