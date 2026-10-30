"""Private-pipe transport to Lucyna's local AI SDK agent. No OMP sessions."""
import asyncio
import ctypes
from functools import lru_cache
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess

from work import TOOLS, file_tool, verify

AGENT_TOOLS = [t for t in TOOLS if t['name'] != 'ask_work_user']


@lru_cache(maxsize=1)
def node_runtime():
    candidates = [shutil.which('node')]
    versions = Path.home()/'.nvm/versions/node'
    if versions.is_dir():
        candidates += [str(p/'bin/node') for p in sorted(versions.iterdir(), reverse=True)]
    candidates += [str(Path.home()/'.local/bin/node'), '/usr/local/bin/node', '/home/linuxbrew/.linuxbrew/bin/node']
    for candidate in candidates:
        if not candidate or not Path(candidate).is_file():
            continue
        try:
            version = subprocess.run([candidate, '--version'], capture_output=True, text=True, timeout=5)
            if version.returncode == 0 and int(version.stdout.strip().lstrip('v').split('.')[0]) >= 22:
                return candidate
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
    raise ValueError('本地 Work agent 需要 WSL Node.js 22 或以上版本')


def configuration(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'script', 'config'}:
        raise ValueError('无效本地 agent 配置')
    script, config = value['script'], value['config']
    if not isinstance(script, str) or not Path(script).is_absolute() or not Path(script).is_file() or Path(script).name != 'evolution-agent-worker.cjs':
        raise ValueError('本地 agent 程序不可用，请重新打开 Lucyna')
    if not isinstance(config, dict) or not config.get('baseURL') or not config.get('model'):
        return None
    if config.get('protocol') not in ('chat-completions', 'responses') or type(config.get('timeoutSeconds')) is not int or not 5 <= config['timeoutSeconds'] <= 120:
        raise ValueError('无效辅助模型配置')
    for key, limit in (('baseURL', 2048), ('model', 200), ('apiKey', 8192)):
        item = config.get(key, '')
        if not isinstance(item, str) or len(item) > limit or any(ord(c) < 32 for c in item):
            raise ValueError('无效辅助模型字段')
    return {'node': node_runtime(), 'script': script, 'config': dict(config)}


async def work_tool(run, spec, name, arguments):
    if not isinstance(arguments, dict):
        raise ValueError('无效工具参数')
    path = arguments.get('path', '.')
    # Compare canonical lexical paths before the existing no-link Work file guard.
    if name in ('read_work_file', 'write_work_file'):
        if not isinstance(path, str) or path != Path(path).as_posix() or '..' in Path(path).parts:
            raise ValueError('无效 Work 文件路径')
        if path in spec['validationFrozen']:
            raise ValueError('留出检查不向迭代 agent 开放')
    if name == 'write_work_file' and path not in spec['targets']:
        raise ValueError('只能修改选定的 Work 迭代对象')
    if name == 'verify_work':
        return await verify(run)
    if name in ('list_work_files', 'read_work_file', 'write_work_file'):
        value = file_tool(run, name, arguments)
        if name == 'list_work_files':
            value['entries'] = [e for e in value['entries'] if e['path'] not in spec['validationFrozen']]
        return value
    raise ValueError('实验工具未开放')


async def iterate(agent, request, tool, update):
    # No interactive shell or OMP credential loading. All children share the worker's
    # process group, so pause/cancel/service shutdown also terminates model requests.
    parent=os.getpid()
    def child_setup():
        ctypes.CDLL(None).prctl(1, signal.SIGKILL)
        if os.getppid()!=parent:
            os._exit(125)
    process = await asyncio.create_subprocess_exec(agent['node'], agent['script'],
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env={'PATH': '/usr/bin:/bin', 'HOME': str(Path.home()), 'LANG': 'C.UTF-8'}, preexec_fn=child_setup, limit=4*1024*1024)
    async def send(value):
        process.stdin.write((json.dumps(value, ensure_ascii=False)+'\n').encode())
        await process.stdin.drain()
    async def receive():
        while line := await process.stdout.readline():
            event = json.loads(line)
            kind = event.get('type')
            if kind == 'tool':
                try:
                    result = await tool(event['name'], event.get('args'))
                except (ValueError, OSError, UnicodeError) as exc:
                    result = {'error': str(exc)[:1200]}
                await send({'id': event['id'], 'result': result})
            elif kind == 'usage':
                if type(event.get('usedTokens')) is not int or event['usedTokens'] < 0:
                    raise ValueError('本地 agent 用量无效')
                update(event)
            elif kind == 'done':
                return event
            elif kind == 'failed':
                raise ValueError(event.get('error', '本地 agent 执行失败')[:1200])
            else:
                raise ValueError('本地 agent 协议无效')
        raise ValueError('本地 agent 意外退出，未创建 OMP 会话')
    try:
        await send({'config': agent['config'], 'request': dict(request, tools=AGENT_TOOLS)})
        return await asyncio.wait_for(receive(), 12*120+30)
    finally:
        process.stdin.close()
        if process.returncode is None:
            process.kill()
        await process.wait()
