import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('details', Path(__file__).resolve().parents[1] / 'src/work-details.py')
details = importlib.util.module_from_spec(spec); spec.loader.exec_module(details)

class WorkDetailsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lucyna-work-details-'); self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name); self.repo = self.parent / 'repository'; self.root = self.parent / 'work'
        self.git('init','-q','-b','main',str(self.repo)); self.git('-C',str(self.repo),'config','user.name','Fixture'); self.git('-C',str(self.repo),'config','user.email','fixture@example.invalid')
        (self.repo/'tracked.txt').write_text('base\n'); self.git('-C',str(self.repo),'add','.'); self.git('-C',str(self.repo),'commit','-qm','base')
        self.sha = self.git('-C',str(self.repo),'rev-parse','HEAD'); (self.root/'repos').mkdir(parents=True)
        self.member=self.root/'repos/app'; self.git('-C',str(self.repo),'worktree','add','-qb','feature',str(self.member))
        self.meta={'name':'app','path':'repos/app','repo':str(self.repo/'.git'),'branch':'feature','base':'main','baseSha':self.sha,'mr':None}
        (self.root/'work.json').write_text(json.dumps({'version':1,'members':[self.meta]}))
        (self.root/'SESSION.md').write_text('# Work\n## 定位\n- **状态**: `active`\n- 未决: 设备未验收\n## 主题页索引\n[Known](notes/known.md)\n## 日志索引\nSESSION-abcdef01.md\n## Evidence\n.agent-tmp/check/result.json\n')
    def git(self,*args):
        return subprocess.run(['git',*args],capture_output=True,text=True,check=True).stdout.strip()
    def test_native_git_scopes_and_index_unchanged(self):
        f=self.member/'tracked.txt'; f.write_text('base\ncommitted\n'); self.git('-C',str(self.member),'commit','-am','change','-q')
        f.write_text('base\ncommitted\nstaged\n'); self.git('-C',str(self.member),'add','tracked.txt'); f.write_text('base\ncommitted\nstaged\nunstaged\n')
        (self.member/'new with space.txt').write_text('new')
        index=Path(self.git('-C',str(self.member),'rev-parse','--git-path','index')); before=index.read_bytes(); manifest=(self.root/'work.json').read_bytes()
        r=details.details(str(self.root)); m=r['members'][0]
        self.assertEqual(m['counts'],{'staged':1,'unstaged':1,'untracked':1,'conflicts':0}); self.assertEqual(m['baseAhead'],1)
        self.assertEqual(len(m['worktrees']),2); self.assertEqual(r['issues'],[])
        for scope,expected,absent in [('unstaged','+unstaged','+staged'),('staged','+staged','+unstaged'),('baseline','+committed','+staged')]:
            diff=details.inspect_git(str(self.root),'app','diff',scope)['text'];self.assertIn(expected,diff);self.assertNotIn(absent,diff)
        self.assertIn('change',details.inspect_git(str(self.root),'app','commits')['text']); self.assertIn('feature',details.inspect_git(str(self.root),'app','branches')['text'])
        self.assertEqual(index.read_bytes(),before);self.assertEqual((self.root/'work.json').read_bytes(),manifest)
    def test_detached_head_and_drift_are_warnings(self):
        self.git('-C',str(self.member),'checkout','--detach','-q'); r=details.details(str(self.root))
        self.assertEqual(r['kind'],'work');self.assertTrue(r['members'][0]['detached']);self.assertEqual(r['members'][0]['branch'],'detached HEAD')
        self.assertEqual([(x['code'],x['severity']) for x in r['issues']],[('branch_mismatch','warning')])
    def test_assets_include_unindexed_but_not_external_symlinks(self):
        (self.root/'notes').mkdir(); (self.root/'notes/known.md').write_text('# Known');(self.root/'notes/new.md').write_text('# New shared note')
        (self.root/'notes/outside.md').symlink_to(self.repo/'tracked.txt');(self.root/'SESSION-abcdef01.md').write_text('# Session');(self.root/'SESSION-abcdef02.md').write_text('# Other')
        (self.root/'.agent-tmp/check').mkdir(parents=True);(self.root/'.agent-tmp/check/result.json').write_text('{}')
        result=details.details(str(self.root)); assets={a['path']:a for a in result['assets']}
        self.assertTrue(assets['notes/known.md']['indexed']);self.assertFalse(assets['notes/new.md']['indexed']);self.assertEqual(assets['notes/new.md']['title'],'New shared note')
        self.assertFalse(assets['SESSION-abcdef02.md']['indexed']);self.assertIn('unavailable',assets['notes/outside.md']);self.assertIn('.agent-tmp/check/result.json',assets)
    def test_path_and_action_boundaries(self):
        for name in ['../app','/tmp','unknown']:
            with self.assertRaises((ValueError,FileNotFoundError)):details.inspect_git(str(self.root),name,'changes')
        with self.assertRaises(ValueError):details.inspect_git(str(self.root),'app','diff',filename='../../outside')
        with self.assertRaises(ValueError):details.inspect_git(str(self.root),'app','checkout')
        self.meta['repo']=str(self.parent/'wrong');(self.root/'work.json').write_text(json.dumps({'version':1,'members':[self.meta]}))
        with self.assertRaises(ValueError):details.inspect_git(str(self.root),'app','changes')
    def test_rename_and_conflict_states(self):
        self.git('-C',str(self.member),'mv','tracked.txt','renamed file.txt');s=details.status(self.member)
        self.assertEqual(s['files'][0]['oldPath'],'tracked.txt');self.assertEqual(s['counts']['staged'],1)
        self.git('-C',str(self.member),'reset','--hard','-q');(self.member/'tracked.txt').write_text('feature\n');self.git('-C',str(self.member),'commit','-am','feature','-q')
        (self.repo/'tracked.txt').write_text('main\n');self.git('-C',str(self.repo),'commit','-am','main','-q')
        subprocess.run(['git','-C',str(self.member),'merge','main'],capture_output=True)
        s=details.status(self.member);self.assertEqual(s['counts']['conflicts'],1);self.assertTrue(s['files'][0]['conflict'])
    def test_old_git_worktree_quoted_paths_and_non_origin_remote(self):
        other=self.parent/'tree with space\n汉字';self.git('-C',str(self.repo),'worktree','add','-qb','other',str(other))
        try:
            rows,_=details.trees(self.member);self.assertIn(str(other),[row['path'] for row in rows])
        except ValueError as error:
            self.assertIn('含换行',str(error))
            self.assertIn('worktreesError',details.details(str(self.root))['members'][0])
        self.git('-C',str(self.repo),'remote','add','sysdev','git@gitlab.example.test:team/app.git')
        self.assertEqual(details.remote_identity(self.member,'https://gitlab.example.test/team/app/-/merge_requests/7'),('gitlab.example.test','team/app'))
        self.assertEqual(details.remote_identity(self.member,7),('gitlab.example.test','team/app'))
        self.git('-C',str(self.repo),'remote','add','fork','https://gitlab.example.test/other/app.git')
        with self.assertRaises(ValueError):details.remote_identity(self.member,7)

if __name__=='__main__':unittest.main()
