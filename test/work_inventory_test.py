import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).resolve().parents[1] / 'src/work-inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='omp-work-inventory-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.common = self.base / 'repository'
        self.run_git('init', '-q', '-b', 'main', str(self.common))
        self.run_git('-C', str(self.common), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture')
        self.sha = self.run_git('-C', str(self.common), 'rev-parse', 'HEAD')
        self.root = self.base / 'works' / 'example'
        (self.root / 'repos').mkdir(parents=True)
        (self.root / 'SESSION.md').write_text('# Fixture\n- 状态: active\n', encoding='utf-8')
        self.run_git('-C', str(self.common), 'worktree', 'add', '-qb', 'current', str(self.root / 'repos/app'))
        self.item = {'name': 'app', 'path': 'repos/app', 'repo': str(self.common / '.git'), 'branch': 'current', 'base': 'main', 'baseSha': self.sha, 'mr': None}

    def run_git(self, *args):
        return subprocess.run(['git', *args], check=True, capture_output=True, text=True, encoding='utf-8').stdout.strip()

    def write(self, members):
        (self.root / 'work.json').write_text(json.dumps({'version': 1, 'members': members}), encoding='utf-8')

    def test_branch_and_numeric_mr_are_read_only_nonblocking(self):
        self.write([{**self.item, 'branch': 'registered-old', 'mr': 171}])
        before = (self.root / 'work.json').read_bytes()
        result = inventory.inspect(self.root)
        self.assertEqual(result['kind'], 'work')
        self.assertEqual(result['health'], 'warning')
        self.assertEqual(result['members'][0]['mr'], '171')
        self.assertEqual({(i['code'], i['severity']) for i in result['issues']}, {('branch_mismatch', 'warning'), ('mr_numeric', 'info')})
        self.assertEqual((self.root / 'work.json').read_bytes(), before)
        self.assertEqual(self.run_git('-C', str(self.root/'repos/app'), 'branch', '--show-current'), 'current')
        self.assertEqual(self.run_git('-C', str(self.root/'repos/app'), 'rev-parse', 'HEAD'), self.sha)

    def test_collect_later_members_and_independent_errors(self):
        self.write([{**self.item, 'branch': 'old', 'mr': 171}, {**self.item, 'name': 'gone', 'path': 'repos/gone', 'baseSha': 'bad', 'mr': {'id': 3}}])
        result = inventory.inspect(self.root)
        self.assertEqual(result['kind'], 'invalid')
        self.assertEqual({i['code'] for i in result['issues']}, {'branch_mismatch','mr_numeric','base_sha_format','mr_type','member_missing'})
        self.assertEqual(len(result['issues']), 5)
        self.assertEqual(len(result['members']), 1)

    def test_all_five_numeric_members_are_returned(self):
        members = []
        for n in range(5):
            name = 'repo'+str(n)
            self.run_git('-C', str(self.common), 'worktree','add','-qb',name,str(self.root/'repos'/name))
            members.append({**self.item,'name':name,'path':'repos/'+name,'branch':name,'mr':n+1})
        self.write(members)
        result = inventory.inspect(self.root)
        self.assertEqual(result['kind'], 'work')
        self.assertEqual(result['health'], 'ok')
        self.assertEqual(len(result['issues']), 5)
        self.assertEqual([m['mr'] for m in result['members']], ['1','2','3','4','5'])

    def test_bad_repo_and_missing_base_remain_blocking(self):
        self.write([{**self.item,'repo':str(self.base/'wrong.git'),'baseSha':'0'*40}])
        result = inventory.inspect(self.root)
        self.assertEqual(result['kind'], 'invalid')
        self.assertEqual({i['code'] for i in result['issues']}, {'common_mismatch','base_sha_missing'})

    def test_detached_head_is_visible_warning_without_blocking_reading(self):
        self.write([self.item])
        self.run_git('-C',str(self.root/'repos/app'),'checkout','--detach','-q')
        result = inventory.inspect(self.root)
        self.assertEqual(result['kind'], 'work')
        self.assertEqual(result['health'], 'warning')
        self.assertTrue(result['members'][0]['detached'])
        self.assertEqual(result['members'][0]['branch'], 'detached HEAD')
        self.assertEqual({(i['code'],i['severity']) for i in result['issues']}, {('branch_mismatch','warning')})

    def test_symlink_cannot_bypass_member_boundary(self):
        try:
            (self.root/'repos/link').symlink_to(self.common, target_is_directory=True)
        except OSError as error:
            if getattr(error, 'winerror', None) == 1314:
                self.skipTest('Windows account lacks symlink privilege; also run this suite on Linux/WSL')
            raise
        self.write([{**self.item,'name':'link','path':'repos/link'}])
        result = inventory.inspect(self.root)
        self.assertEqual(result['kind'],'invalid')
        self.assertIn('member_symlink', {i['code'] for i in result['issues']})

    def test_nonpositive_bool_and_object_mr_remain_invalid(self):
        for value in [0,-2,True,{'id':3}]:
            with self.subTest(value=value):
                self.write([{**self.item,'mr':value}])
                self.assertEqual(inventory.inspect(self.root)['kind'],'invalid')


if __name__ == '__main__': unittest.main()
