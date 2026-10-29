#!/usr/bin/env python3
"""Install the user service, bridge stdio, or inspect durable ownership offline."""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import time

UNIT = 'lucyna-work-runner.service'
MARKER = '# Managed by Lucyna Work Runner v1'


def state_dir():
    return Path.home()/'.local/state/lucyna/work-runner'


def output(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def inspect(directory, root=None):
    database = Path(directory)/'runs.sqlite3'
    if not database.exists():
        return []
    with sqlite3.connect(database.as_uri()+'?mode=ro', uri=True) as connection:
        if root is None:
            return [dict(id=key, root=work, state=status, process=json.loads(data).get('process')) for key,work,status,data in connection.execute(
                "SELECT id,root,state,data FROM runs WHERE state NOT IN ('completed','cancelled','failed')")]
        runs = [json.loads(row[0]) for row in connection.execute('SELECT data FROM runs WHERE root=? ORDER BY rowid DESC LIMIT 30', (root,))]
        fields = ('id','root','objective','acceptance','state','reason','createdAt','updatedAt','tokenBudget','usedTokens','elapsedSeconds','wallSeconds','attemptStartedAt','sessionId','effectiveModel','model','result','question','verification','process','mode','phase','evolution')
        output=[]
        for run in runs:
            item={key:run.get(key) for key in fields}
            if run.get('evolution'):
                item['evolution']={key:run['evolution'].get(key) for key in ('framework','phase','baseline','bestScore','promotion','usageEstimated')}
                item['evolution']['candidates']=[]
            item['objective']=(item.get('objective') or '')[:1000]
            item['acceptance']=(item.get('acceptance') or '')[:1000]
            item['result']=(item.get('result') or '')[:4000]
            output.append(item)
        return output


def control(*args):
    env = dict(os.environ, XDG_RUNTIME_DIR='/run/user/'+str(os.getuid()))
    return subprocess.run(['systemctl', '--user', *args], env=env, capture_output=True, text=True, timeout=25)


def unit_arg(value):
    # systemd ExecStart has its own escaping, not shell quoting.
    return '"'+str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$')+'"'


def install(config):
    required = ('workRoot', 'omp', 'agentDir', 'helper')
    config = {key: config[key] for key in required}
    for key, value in config.items():
        if not isinstance(value, str) or not Path(value).is_absolute() or any(c in value for c in '\0\r\n') or not Path(value).exists():
            raise ValueError('无法安装服务：配置路径无效 '+key)
    if not shutil.which('bwrap'):
        raise ValueError('后台文件任务需要 WSL 中的 bubblewrap (bwrap)')
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    source = Path(__file__).resolve().parent
    files = {p.name: p.read_bytes() for p in source.iterdir() if p.suffix in ('.py', '.mjs')}
    launch = source.parent/'launch_wsl.py'
    if launch.exists():
        files['launch_wsl.py'] = launch.read_bytes()
    if 'launch_wsl.py' not in files:
        raise ValueError('缺少 WSL 环境启动器')
    revision = hashlib.sha256(b''.join(name.encode()+files[name] for name in sorted(files))).hexdigest()[:16]
    release = Path.home()/'.local/share/lucyna/work-runner'/revision
    unit = Path.home()/'.config/systemd/user'/UNIT
    unit.parent.mkdir(parents=True, exist_ok=True)
    old = unit.read_text() if unit.exists() else ''
    if old and not old.startswith(MARKER):
        raise ValueError('同名 systemd 单元不属于 Lucyna，未覆盖')
    content = (MARKER+'\n[Unit]\nDescription=Lucyna Work background runner\n\n[Service]\nType=simple\n'
        f'ExecStart=/usr/bin/python3 {unit_arg(release/"cli.py")} serve --state {unit_arg(directory)}\n'
        'Restart=on-failure\nRestartSec=3\nKillMode=control-group\nTimeoutStopSec=12\nUMask=0077\n\n[Install]\nWantedBy=default.target\n')
    config_file = directory/'config.json'
    previous_config = json.loads(config_file.read_text()) if config_file.exists() else None
    changed = old != content or previous_config != config
    active = control('is-active', UNIT).returncode == 0
    if changed and any(run['state'] not in ('completed', 'cancelled', 'failed') for run in inspect(directory)):
        raise ValueError('存在未结束任务，先暂停并取消或完成后才能升级后台服务')
    release.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, data in files.items():
        target = release/name
        if not target.exists():
            target.write_bytes(data)
    if changed:
        if old:
            shutil.copy2(unit, unit.with_suffix('.service.'+str(time.time_ns())+'.bak'))
        if previous_config:
            shutil.copy2(config_file, directory/('config.'+str(time.time_ns())+'.bak'))
        config_file.write_text(json.dumps(config, indent=2)+'\n')
        unit.write_text(content)
        if control('daemon-reload').returncode:
            raise RuntimeError('无法刷新用户级 systemd 配置')
    if control('enable', UNIT).returncode:
        raise RuntimeError('无法启用用户级后台服务')
    if control('restart' if changed and active else 'start', UNIT).returncode:
        raise RuntimeError('无法启动用户级后台服务，请检查 systemd 日志')
    for _ in range(60):
        try:
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(1)
                connection.connect(str(directory/'runner.sock'))
                connection.sendall(b'{"op":"status"}\n')
                reply = json.loads(connection.makefile('rb').readline())
                if reply.get('success'):
                    return dict(reply['data'], revision=revision)
        except (OSError, ValueError):
            pass
        time.sleep(.1)
    raise RuntimeError('后台服务未就绪，请查看用户级 systemd 状态')


def bridge(directory):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(str(Path(directory)/'runner.sock'))
        stream = connection.makefile('rb')
        for line in sys.stdin.buffer:
            if len(line) > 512*1024:
                raise ValueError('请求超过限制')
            connection.sendall(line)
            reply = stream.readline(4*1024*1024+1)
            if not reply or len(reply) > 4*1024*1024:
                raise ValueError('后台服务连接中断或返回过大')
            sys.stdout.buffer.write(reply)
            sys.stdout.buffer.flush()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['install', 'install-evolution', 'serve', 'bridge', 'inspect'])
    parser.add_argument('--state', type=Path, default=state_dir())
    args = parser.parse_args()
    if args.command == 'install':
        output(install(json.loads(sys.stdin.buffer.readline(65536))))
    elif args.command == 'install-evolution':
        from evo_runtime import install as install_evolution
        output(install_evolution())
    elif args.command == 'inspect':
        request = json.loads(sys.stdin.buffer.readline(65536) or b'{}')
        output(inspect(args.state, request.get('root')))
    elif args.command == 'bridge':
        bridge(args.state)
    else:
        from runner import serve
        asyncio.run(serve(args.state, json.loads((args.state/'config.json').read_text())))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print environment or raw subprocess stderr (may contain credentials).
        output({'success': False, 'error': str(error)[:2000]})
        sys.exit(1)
