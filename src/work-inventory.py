"""Read-only desktop inventory. Does not change the strict Work lifecycle helper.

Collect independent diagnostics rather than hiding later members after a failure.
Only branch drift and positive numeric MR identifiers are non-blocking; unknown
filesystem/Git failures remain errors. All Git commands disable optional locks.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import subprocess
import time


def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True,
                            text=True, encoding='utf-8', timeout=15, env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    if result.returncode:
        raise ValueError(result.stderr.strip() or f'git {args[0]} 失败')
    return result.stdout.strip()


def inspect(root):
    root = Path(root).expanduser()
    issues = []
    result = {'name': root.name, 'root': str(root), 'kind': 'work', 'members': [],
              'issues': issues, 'paths': [str(root)], 'branch': '-', 'dirty': 0,
              'sessions': [], 'notes': [], 'state': '-', 'worktrees': 0, 'mergeState': 'unknown'}

    def add(code, message, member=None, severity='error', actual=None, expected=None):
        issue = {'code': code, 'severity': severity, 'message': message}
        if member is not None: issue['member'] = member
        if actual is not None: issue['actual'] = str(actual)
        if expected is not None: issue['expected'] = str(expected)
        issues.append(issue)

    def finish():
        errors = [i for i in issues if i['severity'] == 'error']
        result['health'] = 'error' if errors else 'warning' if any(i['severity'] == 'warning' for i in issues) else 'ok'
        if errors:
            result['kind'] = 'invalid'
            result['error'] = '；'.join((i.get('member', '') + '：' if i.get('member') else '') + i['message'] for i in errors)
        return result

    if root.is_symlink() or not root.is_dir():
        add('root_invalid', '工作根不存在、不是目录或为符号链接'); return finish()
    root = root.resolve()
    result['root'] = str(root)
    try:
        content = (root / 'SESSION.md').read_text(encoding='utf-8')
        result['idleDays'] = max(0, int((time.time() - (root / 'SESSION.md').stat().st_mtime) // 86400))
        match = re.search(r'(?m)^\s*-\s*\*{0,2}状态\*{0,2}[:：]\s*`?([a-z]+)', content)
        if match: result['state'] = match[1]
    except (OSError, UnicodeError) as e:
        add('session_read', '无法读取 SESSION.md：' + str(e))
    try:
        manifest = root / 'work.json'
        data = json.loads(manifest.read_text(encoding='utf-8')) if manifest.exists() else {'version': 1, 'members': []}
    except (OSError, ValueError) as e:
        add('manifest_read', '无法读取 work.json：' + str(e)); return finish()
    if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('members'), list):
        add('manifest_schema', 'work.json 需要 version: 1 和 members 数组'); return finish()
    if not data['members']:
        result['kind'] = 'gitless'; result['mergeState'] = 'n/a'
        if data != {'version': 1, 'members': []}: add('gitless_manifest', '无 Git 成员的 work.json 包含不支持的字段')
        if (root / '.git').exists() or (root / '.git').is_symlink(): add('gitless_repo', '无 Git 成员的工作根中存在 .git')
        repos = root / 'repos'
        if repos.is_symlink() or repos.exists() and (not repos.is_dir() or any(repos.iterdir())):
            add('gitless_repos', '工作根存在未登记的 repos 内容')
    names = set()
    for item in data['members']:
        if not isinstance(item, dict):
            add('member_schema', '成员记录必须是对象'); continue
        name, rel, repo, branch = (item.get(k) for k in ('name', 'path', 'repo', 'branch'))
        label = name if isinstance(name, str) else '未命名成员'
        # Check independent metadata even if this member's path cannot be read.
        base, sha, mr = item.get('base'), item.get('baseSha'), item.get('mr')
        if not isinstance(base, str) or not base: add('base_missing', '缺少基线引用 base', label)
        sha_valid = isinstance(sha, str) and bool(re.fullmatch(r'[0-9a-fA-F]{40}', sha))
        if not sha_valid: add('base_sha_format', 'baseSha 必须是完整的 40 位提交哈希', label)
        if type(mr) is int and 0 < mr <= 9007199254740991:
            mr = str(mr)
            add('mr_numeric', '数字 MR 已兼容，按字符串读取；原登记保持不变', label, 'info', mr)
        elif mr is not None and not isinstance(mr, str):
            add('mr_type', 'MR 应为字符串、正整数或空值', label)
        if not all(isinstance(x, str) and x for x in (name, rel, repo, branch)):
            add('member_schema', '成员缺少 name、path、repo 或 branch', label); continue
        if name in names: add('member_duplicate', '成员名称重复', name)
        names.add(name)
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name):
            add('member_name', '成员名称格式无效', name); continue
        if Path(rel).parts != ('repos', name):
            add('member_path', f'成员路径应为 repos/{name}', name, actual=rel); continue
        member = root / rel
        if (root / 'repos').is_symlink() or member.is_symlink():
            add('member_symlink', '成员路径包含符号链接', name); continue
        if not member.is_dir(): add('member_missing', '成员目录不存在', name); continue
        if not member.resolve().is_relative_to(root / 'repos'):
            add('member_outside', '成员路径超出工作根 repos 目录', name); continue
        row = {'name': name, 'path': str(member), 'repo': repo, 'branch': branch,
               'registeredBranch': branch, 'base': base, 'baseSha': sha, 'mr': mr, 'dirty': 0}
        result['members'].append(row); result['paths'].append(str(member))
        def check(code, command, handler):
            try: handler(git(member, *command))
            except (OSError, ValueError, subprocess.SubprocessError) as e:
                add(code, str(e), name)
        def top(value):
            if Path(value).resolve() != member.resolve(): add('top_mismatch', 'Git 根目录与成员路径不一致', name, actual=value, expected=str(member))
        def common(value):
            actual = Path(value)
            actual = (member / actual).resolve() if not actual.is_absolute() else actual.resolve()
            if actual != Path(repo).expanduser().resolve(): add('common_mismatch', 'Git 仓库归属与登记不一致', name, actual=str(actual), expected=repo)
        def current(value):
            row['branch'] = value or 'detached HEAD'
            row['detached'] = not value
            if value != branch: add('branch_mismatch', '当前分支与 work 登记不一致', name, 'warning', value, branch)
        check('git_top', ('rev-parse', '--show-toplevel'), top)
        check('git_common', ('rev-parse', '--git-common-dir'), common)
        check('git_branch', ('branch', '--show-current'), current)
        check('git_head', ('rev-parse', 'HEAD'), lambda value: row.update(head=value))
        if sha_valid: check('base_sha_missing', ('cat-file', '-e', sha + '^{commit}'), lambda _: None)
        check('git_status', ('status', '--porcelain', '--untracked-files=no'), lambda value: row.update(dirty=len(value.splitlines())))
    result['worktrees'] = len(result['members'])
    result['branch'] = result['members'][0]['branch'] if len(result['members']) == 1 else 'multi' if result['members'] else '-'
    result['dirty'] = sum(m['dirty'] for m in result['members'])
    try:
        result['sessions'] = sorted(p.name for p in root.iterdir() if p.is_file() and re.fullmatch(r'SESSION-[^/]+\.md', p.name))
        notes = root / 'notes'
        result['notes'] = sorted(p.name for p in notes.iterdir() if p.is_file() and p.suffix == '.md') if notes.is_dir() else []
    except OSError as e: add('index_read', '会话或笔记目录读取失败：' + str(e))
    return finish()


def safe_inspect(root):
    try: return inspect(root)
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        return {'name': root.name, 'root': str(root), 'kind': 'invalid', 'health': 'error',
                'error': str(e), 'members': [], 'issues': [{'code': 'scan_failed', 'severity': 'error', 'message': str(e)}]}


def list_roots(parent):
    parent = Path(parent).expanduser().resolve(strict=True)
    roots = [p for p in sorted(parent.iterdir()) if p.is_dir() and not p.is_symlink()
             and ((p / 'SESSION.md').is_file() or (p / 'work.json').exists())
             and (not (p / '.git').exists() or (p / 'work.json').exists())]
    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(safe_inspect, roots))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    print(json.dumps(list_roots(args.root), ensure_ascii=False))
