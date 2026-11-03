"""Real Linux Git repositories, no user repository or network credentials."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch
from contextlib import contextmanager

spec=importlib.util.spec_from_file_location('workspace',Path(__file__).resolve().parents[1]/'src/git_workspace.py')
workspace=importlib.util.module_from_spec(spec);spec.loader.exec_module(workspace)


class GitWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='lucyna-git-transactions-');self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.repo=self.base/'repo';self.root=self.base/'work';self.member=self.root/'repos/app'
        self.git('init','-q','-b','main',str(self.repo));self.git('-C',str(self.repo),'config','user.name','Test');self.git('-C',str(self.repo),'config','user.email','test@example.invalid')
        (self.repo/'a.txt').write_text('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')
        self.git('-C',str(self.repo),'add','.');self.git('-C',str(self.repo),'commit','-qm','initial')
        (self.root/'repos').mkdir(parents=True);(self.root/'SESSION.md').write_text('# Test')
        self.git('-C',str(self.repo),'worktree','add','-qb','feature',str(self.member))
        self.meta=dict(name='app',path='repos/app',repo=str(self.repo/'.git'),branch='feature',base='main',baseSha=self.git('-C',str(self.member),'rev-parse','HEAD'))
        (self.root/'work.json').write_text(json.dumps(dict(version=1,members=[self.meta])))
        self.service=workspace.GitWorkspace(self.base/'state')

    def git(self,*args):
        return subprocess.run(['git',*args],check=True,capture_output=True,text=True).stdout.strip()

    def read(self,action,**options):return self.service.dispatch(str(self.root),'app',action,options)

    def act(self,action,**options):
        options.setdefault('expected',self.read('snapshot',file=options.get('file',''))['token']);options.setdefault('operationId',uuid.uuid4().hex)
        return self.read(action,**options)

    def changed(self):
        (self.member/'a.txt').write_text('ONE\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n')

    def test_stage_unstage_literal_paths_and_unborn(self):
        file='-新*\nfile.txt';(self.member/file).write_text('new')
        self.assertEqual(self.act('stage',file=file)['status'],'completed')
        self.assertIn(file,self.read('snapshot')['files'][0]['path'] if len(self.read('snapshot')['files'])==1 else '')
        self.assertEqual(self.act('unstage',file=file)['status'],'completed');self.assertTrue((self.member/file).exists())
        self.git('-C',str(self.member),'checkout','--orphan','empty');self.git('-C',str(self.member),'rm','-rf','.')
        (self.member/'new').write_text('first');self.assertEqual(self.act('stage',file='new')['status'],'completed')
        result=self.act('commit',message='first commit');self.assertEqual(result['status'],'completed',result)
        self.assertEqual(self.git('-C',str(self.member),'show','--format=%P','--no-patch','HEAD'),'')

    def test_stale_snapshot_and_native_index_lock_preserve_contents(self):
        self.changed();snap=self.read('snapshot',file='a.txt');(self.member/'a.txt').write_text('other\n')
        self.assertEqual(self.act('stage',file='a.txt',expected=snap['token'])['status'],'failed')
        lock=workspace.git_path(self.member,'index.lock');lock.write_text('external lock')
        before=workspace.git_path(self.member,'index').read_bytes()
        self.assertEqual(self.act('stage',file='a.txt')['status'],'failed');self.assertEqual(lock.read_text(),'external lock');self.assertEqual(workspace.git_path(self.member,'index').read_bytes(),before)

    def test_line_stage_and_unstage_keep_other_changes(self):
        self.changed();catalog=self.read('patches',file='a.txt',scope='unstaged')
        lines=[line for h in catalog['hunks'] for line in h['lines']]
        selection=[line['id'] for line in lines if line['text'] in ('-one','+ONE')]
        r=self.act('stage-selection',file='a.txt',selection=selection,expected=catalog['snapshot']['token']);self.assertEqual(r['status'],'completed',r)
        staged=self.git('-C',str(self.member),'show',':a.txt');self.assertTrue(staged.startswith('ONE\ntwo\n'));self.assertTrue(staged.endswith('ten'))
        catalog=self.read('patches',file='a.txt',scope='staged');selection=[line['id'] for h in catalog['hunks'] for line in h['lines']]
        r=self.act('unstage-selection',file='a.txt',selection=selection,expected=catalog['snapshot']['token']);self.assertEqual(r['status'],'completed',r)
        self.assertEqual(self.git('-C',str(self.member),'diff','--cached'),'');self.assertTrue((self.member/'a.txt').read_text().startswith('ONE\nTWO'))

    def test_multiple_hunks_and_only_addition_selection(self):
        self.changed();catalog=self.read('patches',file='a.txt',scope='unstaged')
        chosen=[line['id'] for h in catalog['hunks'] for line in h['lines'] if line['text'] in ('+ONE','-ten','+TEN')]
        r=self.act('stage-selection',file='a.txt',selection=chosen,expected=catalog['snapshot']['token']);self.assertEqual(r['status'],'completed',r)
        staged=self.git('-C',str(self.member),'show',':a.txt');self.assertTrue(staged.startswith('one\nONE\n'));self.assertTrue(staged.endswith('TEN'))

    def test_commit_hooks_signing_failure_and_durable_idempotence(self):
        self.changed();self.act('stage',file='a.txt');expected=self.read('snapshot')['token'];op=uuid.uuid4().hex
        before=self.git('-C',str(self.member),'rev-parse','HEAD')
        r=self.act('commit',expected=expected,operationId=op,message='reviewed');self.assertEqual(r['status'],'completed',r)
        self.assertEqual(self.act('commit',expected=expected,operationId=op,message='reviewed'),r)
        reopened=workspace.GitWorkspace(self.base/'state');self.assertEqual(reopened.dispatch(str(self.root),'app','operation',dict(operationId=op)),r)
        self.assertEqual(r['result']['parent'],before)
        with self.assertRaisesRegex(ValueError,'参数发生变化'):self.act('commit',expected=expected,operationId=op,message='different')
        (self.member/'a.txt').write_text('sign failure');self.act('stage',file='a.txt')
        self.git('-C',str(self.member),'config','commit.gpgsign','true');self.git('-C',str(self.member),'config','gpg.program','/bin/false')
        head=self.git('-C',str(self.member),'rev-parse','HEAD');r=self.act('commit',message='must fail');self.assertEqual(r['status'],'failed');self.assertEqual(self.git('-C',str(self.member),'rev-parse','HEAD'),head)

    def test_mutating_hook_aborts_without_changing_original_index_or_head(self):
        self.changed();self.act('stage',file='a.txt');hooks=self.repo/'.git/hooks';hook=hooks/'pre-commit'
        hook.write_text('#!/bin/sh\necho injected > hook.txt\ngit add hook.txt\n');hook.chmod(0o700)
        before=workspace.git_path(self.member,'index').read_bytes();head=self.git('-C',str(self.member),'rev-parse','HEAD')
        result=self.act('commit',message='reviewed only');self.assertEqual(result['status'],'failed',result)
        self.assertIn('hooks',result['result']['message']);self.assertEqual(self.git('-C',str(self.member),'rev-parse','HEAD'),head)
        self.assertEqual(workspace.git_path(self.member,'index').read_bytes(),before)

    def test_concurrent_external_stage_is_preserved_during_commit(self):
        self.changed();self.act('stage',file='a.txt');ready=self.base/'ready';release=self.base/'release'
        hook=self.repo/'.git/hooks/pre-commit';hook.write_text(f'#!/bin/sh\ntouch {ready}\nwhile ! test -e {release}; do sleep 0.03; done\n');hook.chmod(0o700)
        results=[];thread=threading.Thread(target=lambda:results.append(self.act('commit',message='reviewed')));thread.start()
        end=time.time()+8
        while not ready.exists() and thread.is_alive() and time.time()<end:time.sleep(.03)
        if not ready.exists():
            release.touch();thread.join(10);self.fail('hook did not start: '+repr(results))
        (self.member/'external.txt').write_text('external');self.git('-C',str(self.member),'add','external.txt');release.touch();thread.join(10)
        self.assertEqual(results[0]['status'],'completed',results)
        self.assertEqual(self.git('-C',str(self.member),'diff','--cached','--name-only'),'external.txt')
        self.assertEqual(self.git('-C',str(self.member),'ls-tree','--name-only','HEAD'),'a.txt')

    def test_external_stage_between_review_and_freeze_cannot_enter_commit(self):
        self.changed();self.assertEqual(self.act('stage',file='a.txt')['status'],'completed');expected=self.read('snapshot')['token'];before=self.git('-C',str(self.member),'rev-parse','HEAD');original=workspace.frozen_index
        @contextmanager
        def race(member):
            (member/'external.txt').write_text('external stage');self.git('-C',str(member),'add','external.txt')
            with original(member) as frozen:yield frozen
        with patch.object(workspace,'frozen_index',race):result=self.act('commit',expected=expected,message='reviewed tree')
        self.assertEqual(result['status'],'failed',result);self.assertEqual(self.git('-C',str(self.member),'rev-parse','HEAD'),before)
        self.assertIn('external.txt',self.git('-C',str(self.member),'diff','--cached','--name-only'))

    def test_binary_symlink_rename_and_delete_file_level_operations(self):
        (self.member/'binary.bin').write_bytes(b'\0\xffbinary');self.assertEqual(self.act('stage',file='binary.bin')['status'],'completed')
        self.assertEqual(subprocess.check_output(['git','-C',str(self.member),'show',':binary.bin']),b'\0\xffbinary')
        link=self.member/'outside-link';link.symlink_to(self.base/'secret');self.assertEqual(self.act('stage',file='outside-link')['status'],'completed')
        self.assertTrue(self.git('-C',str(self.member),'ls-files','-s','outside-link').startswith('120000'))
        self.git('-C',str(self.member),'mv','a.txt','renamed\n中文.txt');self.assertEqual(self.act('unstage',file='renamed\n中文.txt')['status'],'completed')
        self.assertEqual(self.git('-C',str(self.member),'show',':a.txt').splitlines()[0],'one');self.assertTrue((self.member/'renamed\n中文.txt').exists())
        self.assertEqual(self.act('stage',file='a.txt')['status'],'completed');self.assertEqual(self.git('-C',str(self.member),'ls-files','a.txt'),'')

    def test_branch_and_worktree_registration_and_activity_guard(self):
        self.assertEqual(self.act('branch-create',branch='next')['status'],'completed')
        self.service.active=lambda root:True
        self.assertEqual(self.act('branch-switch',branch='next')['status'],'failed')
        self.service.active=lambda root:False
        r=self.act('branch-switch',branch='next');self.assertEqual(r['status'],'completed',r)
        self.assertEqual(json.loads((self.root/'work.json').read_text())['members'][0]['branch'],'next')
        self.assertEqual(self.act('worktree-create',name='second',branch='second')['status'],'completed')
        self.assertTrue((self.root/'repos/second/.git').is_file())
        r=self.act('worktree-move',name='renamed');self.assertEqual(r['status'],'completed',r)
        self.assertEqual(json.loads((self.root/'work.json').read_text())['members'][0]['name'],'renamed')
        r=self.service.dispatch(str(self.root),'renamed','snapshot')
        result=self.service.dispatch(str(self.root),'renamed','worktree-remove',dict(operationId=uuid.uuid4().hex,expected=r['token']))
        self.assertEqual(result['status'],'completed',result);self.assertFalse((self.root/'repos/renamed').exists())

    def test_lfs_review_checkout_and_switch_keep_pointers(self):
        if subprocess.run(['git','lfs','version'],capture_output=True).returncode:
            self.skipTest('Git LFS is unavailable')
        repo, member = str(self.repo), str(self.member)
        self.git('-C',repo,'lfs','install','--local','--skip-repo')
        self.git('-C',member,'lfs','track','*.bin')
        (self.member/'asset.bin').write_bytes(b'a'*1024**2)
        self.git('-C',member,'add','.gitattributes','asset.bin')
        self.git('-C',member,'commit','-qm','Add asset')
        config = (self.repo/'.git/config').read_bytes()
        result = self.act('worktree-create',name='review',branch='review',lfsMode='review')
        self.assertEqual(result['status'],'completed',result)
        asset = self.root/'repos/review/asset.bin'
        self.assertLess(asset.stat().st_size,1024)
        self.assertEqual((self.repo/'.git/config').read_bytes(),config)

        self.git('-C',repo,'merge','--ff-only','feature')
        (self.repo/'asset.bin').write_bytes(b'b'*2*1024**2)
        self.git('-C',repo,'add','asset.bin')
        self.git('-C',repo,'commit','-qm','Update asset')
        self.git('-C',repo,'branch','review-next')
        snapshot = self.service.dispatch(str(self.root),'review','snapshot')
        self.assertEqual(snapshot['lfsMode'],'review')
        result = self.service.dispatch(str(self.root),'review','branch-switch',
            dict(branch='review-next',expected=snapshot['token'],operationId=uuid.uuid4().hex))
        self.assertEqual(result['status'],'completed',result)
        self.assertIn(b'size 2097152',asset.read_bytes())

    def test_worktree_removal_refuses_ignored_files(self):
        (self.member/'.gitignore').write_text('build.log\n')
        self.git('-C',str(self.member),'add','.gitignore')
        self.git('-C',str(self.member),'commit','-qm','Ignore build log')
        output = self.member/'build.log'
        output.write_text('Retain this evidence')
        result = self.act('worktree-remove')
        self.assertEqual(result['status'],'failed',result)
        self.assertIn('忽略',result['result']['message'])
        self.assertEqual(output.read_text(),'Retain this evidence')

    def test_fetch_and_push_to_local_bare_remote(self):
        remote=self.base/'remote.git';self.git('init','--bare','-q',str(remote));self.git('-C',str(self.member),'remote','add','origin',str(remote))
        r=self.act('push',remote='origin',branch='feature');self.assertEqual(r['status'],'completed',r)
        self.assertEqual(self.git('--git-dir',str(remote),'rev-parse','refs/heads/feature'),self.git('-C',str(self.member),'rev-parse','HEAD'))
        self.assertEqual(self.act('fetch',remote='origin')['status'],'completed')
        self.assertEqual(self.act('push',remote='--all',branch='feature')['status'],'failed')

    def test_insertion_deletion_and_missing_final_newline_partial_roundtrip(self):
        for i,(old,new) in enumerate([('a\nb\nc\n','a\ninsert\nb\nc\n'),('a\nb\nc\n','a\nc\n'),('a\nb','a\nB'),('a\n','a\nnew'),('a\nb\nc\n','A\nb\nC\n')]):
            file=f'case-{i}.txt';(self.member/file).write_text(old);self.git('-C',str(self.member),'add',file);self.git('-C',str(self.member),'commit','-qm','case')
            (self.member/file).write_text(new);catalog=self.read('patches',file=file,scope='unstaged');selection=[line['id'] for h in catalog['hunks'] for line in h['lines']]
            result=self.act('stage-selection',file=file,selection=selection,expected=catalog['snapshot']['token']);self.assertEqual(result['status'],'completed',(i,result))
            blob=subprocess.check_output(['git','-C',str(self.member),'show',':'+file]).decode();self.assertEqual(blob,new)
            catalog=self.read('patches',file=file,scope='staged');selection=[line['id'] for h in catalog['hunks'] for line in h['lines']]
            result=self.act('unstage-selection',file=file,selection=selection,expected=catalog['snapshot']['token']);self.assertEqual(result['status'],'completed',(i,result))
            self.assertEqual(subprocess.check_output(['git','-C',str(self.member),'show',':'+file]).decode(),old)
            self.assertEqual((self.member/file).read_text(),new)

    def test_split_index_and_merge_refusal_preserve_external_state(self):
        self.git('-C',str(self.member),'update-index','--split-index');self.changed()
        r=self.act('stage',file='a.txt');self.assertEqual(r['status'],'completed',r)
        self.assertEqual(self.act('commit',message='split index')['status'],'completed')
        self.assertEqual(self.act('branch-merge',branch='main')['status'],'completed')
        self.assertEqual(self.git('-C',str(self.member),'status','--porcelain'),'')
        self.git('-C',str(self.repo),'commit','--allow-empty','-qm','diverged')
        before=self.git('-C',str(self.member),'rev-parse','HEAD');r=self.act('branch-merge',branch='main');self.assertEqual(r['status'],'failed',r)
        self.assertEqual(self.git('-C',str(self.member),'rev-parse','HEAD'),before)


if __name__=='__main__':unittest.main()
