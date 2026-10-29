"""Work capabilities. Shared skills are readable; commands never mount user home."""
import asyncio
import difflib
import json
import os
from pathlib import Path
import signal
import urllib.request
import uuid

from work import bounded_file, digest, local_path, private_name, tool, check_frozen, sandbox_command

KNOWLEDGE_READ = {'wiki_search','wiki_read','wiki_context','wiki_overview','wiki_claim_search','wiki_claim_get','wiki_claims','todo_list'}


def knowledge(args):
    name = args.get('name', 'list')
    if name != 'list' and name not in KNOWLEDGE_READ:
        raise ValueError('公共知识只开放列出的读取接口')
    request_id = str(uuid.uuid4())
    payload = {'jsonrpc':'2.0','id':request_id,'method':'tools/list' if name == 'list' else 'tools/call',
        'params':{} if name == 'list' else {'name':name,'arguments':args.get('arguments') or {}}}
    request = urllib.request.Request('http://127.0.0.1:18989/mcp',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Accept':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=20) as response:
            raw = response.read(256*1024+1)
        if len(raw)>256*1024:
            raise ValueError('公共知识结果过大，请缩小查询')
        value=json.loads(raw)
        if value.get('id')!=request_id or 'error' in value:
            raise ValueError('公共知识读取失败')
        result=value['result']
        return {'tools':[t for t in result.get('tools',[]) if t.get('name') in KNOWLEDGE_READ]} if name=='list' else result
    except (OSError,KeyError):
        raise ValueError('Stele 只读接口暂不可用') from None


def walk_files(root, limit=10000):
    count = 0
    for folder, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not private_name(d) and d not in ('node_modules', '.agent-tmp', '__pycache__') and not (Path(folder)/d).is_symlink())
        for name in sorted(files):
            if private_name(name):
                continue
            path = Path(folder)/name
            count += 1
            if count > limit:
                raise ValueError('Work 文件过多，请缩小任务输入')
            if path.is_symlink() or path.stat().st_nlink != 1:
                raise ValueError('不支持链接文件：'+str(path.relative_to(root)))
            yield path


def snapshot(root):
    result, size = {}, 0
    for path in walk_files(root):
        size += path.stat().st_size
        if size > 100*1024*1024:
            raise ValueError('实验输入超过 100 MiB，请缩小 Work')
        result[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    return result


def change(path, before, after):
    old, new = (before or b'').decode('utf-8', errors='replace'), (after or b'').decode('utf-8', errors='replace')
    lines = list(difflib.unified_diff(old.splitlines(), new.splitlines(), fromfile='before/'+path, tofile='after/'+path, lineterm=''))
    return {'path': path, 'beforeSha': digest(before) if before is not None else 'missing',
        'afterSha': digest(after) if after is not None else 'missing', 'diff': '\n'.join(lines)[:24000],
        'added': sum(x.startswith('+') and not x.startswith('+++') for x in lines),
        'removed': sum(x.startswith('-') and not x.startswith('---') for x in lines), 'truncated': len('\n'.join(lines)) > 24000}


def skill_catalog(config):
    roots = [Path(config['helper']).parent.parent.parent, Path(config['agentDir'])/'skills', Path(config['agentDir'])/'managed-skills']
    catalog = {}
    for root in roots:
        if not root.is_dir():
            continue
        for directory in sorted(root.iterdir()):
            # Explicitly configured skill roots may contain symlinks to installed packages.
            entry = directory/'SKILL.md'
            if entry.is_file() and directory.name not in catalog:
                catalog[directory.name] = directory.resolve()
    return catalog


def skill_tool(config, name, args):
    catalog = skill_catalog(config)
    if name == 'list_work_skills':
        return {'skills': [{'name': key, 'summary': bounded_file(folder/'SKILL.md').decode('utf-8')[:1000]} for key,folder in list(catalog.items())[:100]], 'readOnly': True}
    directory = catalog.get(args.get('skill'))
    if not directory:
        raise ValueError('技能不存在，请先列出可用技能')
    path = local_path(str(directory), args.get('path', 'SKILL.md'))
    return {'skill': args['skill'], 'path': args.get('path', 'SKILL.md'), 'content': bounded_file(path).decode('utf-8')[:48000], 'readOnly': True}


def search(run, args):
    query = args.get('query')
    if not isinstance(query, str) or not 1 <= len(query) <= 300:
        raise ValueError('搜索词长度须为 1–300')
    matches = []
    for path in walk_files(run['root']):
        if path.stat().st_size > 1024*1024:
            continue
        try:
            content = path.read_text(encoding='utf-8')
        except UnicodeError:
            continue
        for number,line in enumerate(content.splitlines(), 1):
            if query.casefold() in line.casefold():
                matches.append({'path': path.relative_to(run['root']).as_posix(), 'line': number, 'text': line[:500]})
                if len(matches) == 100:
                    return {'matches': matches, 'truncated': True}
    return {'matches': matches, 'truncated': False}


async def command(run, args):
    argv, cwd = args.get('argv'), args.get('cwd', '.')
    if not isinstance(argv, list) or not 1 <= len(argv) <= 64 or any(not isinstance(a,str) or len(a)>16000 or '\0' in a for a in argv):
        raise ValueError('命令必须是参数数组')
    if not argv[0].startswith('/usr/bin/') or Path(argv[0]).parent != Path('/usr/bin'):
        raise ValueError('命令程序须位于 /usr/bin；可使用 bash -lc 执行 Work 构建脚本')
    local_path(run['root'], cwd, directory=True)
    check_frozen(run)
    result = await sandbox_command(run, argv, cwd, writable=True)
    check_frozen(run)
    return result


async def git_read(run, args, config):
    member, operation = args.get('member'), args.get('operation')
    if operation not in ('status', 'diff', 'log'):
        raise ValueError('Git 只开放 status、diff、log')
    proc = await asyncio.create_subprocess_exec('/usr/bin/python3', config['helper'], 'verify', run['root'], stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    out, _ = await asyncio.wait_for(proc.communicate(), 20)
    if proc.returncode:
        raise ValueError('Work 成员核验失败')
    entry = json.loads(out)
    members = entry.get('members', [])
    item = next((m for m in members if m.get('name') == member or m.get('path') == member), None)
    if not item:
        raise ValueError('请选择已登记的 Git 成员')
    location = Path(item['path'])
    if not location.is_absolute():
        location = Path(run['root'])/location
    if not location.resolve().is_relative_to(Path(run['root'])):
        raise ValueError('Git 成员越出 Work')
    tail = {'status':['status','--short','--branch'], 'diff':['diff','--no-ext-diff','--no-textconv','--stat'], 'log':['log','-10','--format=%h %s']}[operation]
    env = {'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GIT_OPTIONAL_LOCKS':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_PAGER':'cat'}
    process = await asyncio.create_subprocess_exec('/usr/bin/git','--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',str(location),*tail, env=env, stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.STDOUT, start_new_session=True)
    try:
        output,_ = await asyncio.wait_for(process.communicate(),20)
        return {'exitCode':process.returncode,'output':output[:32000].decode('utf-8',errors='replace')}
    finally:
        if process.returncode is None:
            os.killpg(process.pid,signal.SIGKILL)
            await process.wait()


TOOLS = [
    tool('read_work_knowledge','Read existing shared L3 knowledge through Stele. First call name=list for exact schemas. Write interfaces and credentials are never exposed.',{'name':{'type':'string','enum':['list',*sorted(KNOWLEDGE_READ)]},'arguments':{'type':'object'}},[]),
    tool('search_work_files','Search text in Work source and notes. Returns file paths and line numbers.',{'query':{'type':'string'}},['query']),
    tool('list_work_skills','List existing shared skills for read-only use. Skills do not expand tool permissions.',{},[]),
    tool('read_work_skill','Read a skill or its relative supporting file; never modifies the shared skill.',{'skill':{'type':'string'},'path':{'type':'string'}},['skill']),
    tool('run_work_command','Run a command in an offline sandbox: /work writable, /usr read-only, private paths hidden, no host home. Frozen checks, SESSION.md, manifest and logs are read-only. Use file tools for progress/log edits. Cwd is relative to Work.',{'argv':{'type':'array','items':{'type':'string'}},'cwd':{'type':'string'}},['argv']),
    tool('inspect_work_git','Read status/diff summary/recent log of a verified member. No Git mutations.',{'member':{'type':'string'},'operation':{'type':'string','enum':['status','diff','log']}},['member','operation']),
]
