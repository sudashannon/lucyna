import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import asyncio
import threading
from unittest.mock import patch
import git_workspace_test as fixtures
workspace=fixtures.workspace

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools/lucyna-host'))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import workspace_files
import install


class RemoteWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='lucyna-remote-files-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)

    def test_relative_file_links_images_paging_and_encoding(self):
        (self.root/'notes').mkdir();(self.root/'notes/a.md').write_text('# 内容\n[文件](../file.txt)',encoding='utf-8');(self.root/'file.txt').write_text('hello')
        (self.root/'image.png').write_bytes(b'png fixture');(self.root/'outside').symlink_to('/etc/passwd')
        self.assertEqual(workspace_files.read(str(self.root),'../file.txt','notes/a.md')['path'],'file.txt')
        self.assertTrue(workspace_files.read(str(self.root),'image.png')['dataUrl'].startswith('data:image/png;base64,'))
        self.assertEqual(next(r for r in workspace_files.listing(str(self.root))['entries'] if r['name']=='outside')['kind'],'blocked')
        for name in ('outside','../../etc/passwd'):
            with self.assertRaises(ValueError):workspace_files.read(str(self.root),name)
        for i in range(205):(self.root/f'item-{i}.txt').write_text('x')
        first=workspace_files.listing(str(self.root),'',dict(query='item-'));self.assertEqual(len(first['entries']),200)
        self.assertEqual(len(workspace_files.listing(str(self.root),'',dict(query='item-',offset=first['nextOffset']))['entries']),5)
        (self.root/'bad.txt').write_bytes(b'\xff');(self.root/'big.txt').write_bytes(b'x'*(1024*1024+1))
        for name in ('bad.txt','big.txt'):
            with self.assertRaises(ValueError):workspace_files.read(str(self.root),name)
        descriptor=os.open(os.fsencode(self.root)+b'/invalid-\xff.txt',os.O_CREAT|os.O_WRONLY,0o600);os.close(descriptor)
        self.assertEqual(workspace_files.listing(str(self.root),'',dict(query='invalid'))['entries'][0]['kind'],'blocked')

    def test_idle_upgrade_locks_admission_and_rejects_live_sessions(self):
        db=sqlite3.connect(self.root/'sessions.sqlite3');db.execute('CREATE TABLE sessions(record TEXT)');db.execute('INSERT INTO sessions VALUES (?)',(json.dumps(dict(status='live')),));db.commit();db.close()
        with patch.object(install,'systemctl') as system:
            with self.assertRaisesRegex(ValueError,'upgrade_busy'):install.stop_idle_service(self.root,'fixture.service')
            system.assert_not_called()
        with sqlite3.connect(self.root/'sessions.sqlite3') as db:db.execute('DELETE FROM sessions')
        checked=[]
        def system(*args):
            if args[0]=='stop':
                other=sqlite3.connect(self.root/'sessions.sqlite3',timeout=.01)
                with self.assertRaises(sqlite3.OperationalError):other.execute('INSERT INTO sessions VALUES (?)',('{}',))
                other.close();checked.append(True)
            return type('Result',(),dict(returncode=0 if args[0]=='stop' else 3))()
        with patch.object(install,'systemctl',side_effect=system):install.stop_idle_service(self.root,'fixture.service')
        self.assertTrue(checked)

    def test_interrupted_operation_is_queryable_and_requires_acknowledgement(self):
        fixture=fixtures.GitWorkspaceTests('runTest');fixture.setUp();self.addCleanup(fixture.doCleanups)
        service=fixture.service;member=fixture.member;root=str(fixture.root);id='interrupted-operation'
        identity=dict(root=root,member='app',repo=str(member),common=str((member/workspace.text(member,'rev-parse','--git-common-dir')).resolve()))
        with service.db() as db:db.execute('INSERT INTO operations VALUES (?,?,?,?,?,?)',(id,workspace.canonical(identity),workspace.canonical(dict(action='commit')),'running','{}',1))
        result=service.dispatch(root,'app','operation',dict(operationId=id));self.assertEqual(result['status'],'uncertain')
        fixture.changed();self.assertRaisesRegex(ValueError,'待核对',fixture.act,'stage',file='a.txt')
        service.dispatch(root,'app','acknowledge',dict(operationId=id));self.assertEqual(fixture.act('stage',file='a.txt')['status'],'completed')

    def test_failed_upgrade_restores_previous_unit_and_activation(self):
        import ssh_host_test
        package=ssh_host_test.bundle();prefix=self.root/'installation';home=self.root/'home';home.mkdir()
        def system(*args):return type('Result',(),dict(returncode=3 if args[0]=='is-active' else 0))()
        def health(state):
            return dict(release=package['release'],installationId=json.loads((state/'identity.json').read_text())['installationId'])
        with patch.object(install.Path,'home',return_value=home),patch.object(install,'systemctl',side_effect=system),patch.object(install,'hello',side_effect=health):
            first=install.install(package,dict(prefix=str(prefix),mode='user-service'))
            unit=home/'.config/systemd/user'/first['serviceUnit'];before=unit.read_text();active=(prefix/'state/active.json').read_bytes()
            candidate=json.loads(json.dumps(package));import base64,hashlib
            data=base64.b64decode(candidate['files']['host.py']['data'])+b'\n# candidate release\n';candidate['files']['host.py']=dict(data=base64.b64encode(data).decode(),sha256=hashlib.sha256(data).hexdigest())
            candidate['release']=hashlib.sha256(''.join(name+'\0'+candidate['files'][name]['sha256']+'\n' for name in sorted(candidate['files'])).encode()).hexdigest()
            with self.assertRaisesRegex(ValueError,'service_identity_mismatch'):install.install(candidate,dict(prefix=str(prefix),mode='user-service',upgrade=True))
            self.assertEqual(unit.read_text(),before);self.assertEqual((prefix/'state/active.json').read_bytes(),active)
            package=candidate
            final=install.install(candidate,dict(prefix=str(prefix),mode='user-service',upgrade=True))
            self.assertEqual(final['installationId'],first['installationId']);self.assertNotEqual(final['release'],first['release'])


class RunnerLeaseWire(unittest.IsolatedAsyncioTestCase):
    async def test_git_helper_holds_lease_until_its_socket_closes(self):
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools/work-runner'))
        from runner import serve
        with tempfile.TemporaryDirectory(prefix='lucyna-lease-wire-') as folder:
            base=Path(folder);root=base/'works/test';root.mkdir(parents=True);(root/'SESSION.md').write_text('# Work');(root/'work.json').write_text('{"version":1,"members":[]}');state=base/'state';state.mkdir()
            helper=base/'helper.py';helper.write_text('print(\'{"kind":"gitless"}\')')
            config=dict(workRoot=str(root.parent),helper=str(helper),omp='not-started',agentDir=str(base))
            task=asyncio.create_task(serve(state,config));release=threading.Event();entered=threading.Event()
            try:
                for _ in range(100):
                    if (state/'runner.sock').exists():break
                    await asyncio.sleep(.02)
                def hold():
                    with workspace.runner_lease(state,str(root)):entered.set();release.wait(10)
                worker=asyncio.create_task(asyncio.to_thread(hold))
                for _ in range(100):
                    if entered.is_set():break
                    await asyncio.sleep(.02)
                self.assertTrue(entered.is_set())
                reader,writer=await asyncio.open_unix_connection(str(state/'runner.sock'))
                writer.write((json.dumps(dict(op='create',root=str(root),requestKey='blocked',objective='blocked',acceptance='never starts'))+'\n').encode());await writer.drain()
                result=json.loads(await reader.readline());self.assertFalse(result['success']);self.assertIn('正在管理',result['error'])
                release.set();await worker;await asyncio.sleep(.05)
                writer.write((json.dumps(dict(op='workspace-lock',root=str(root)))+'\n').encode());await writer.drain();self.assertTrue(json.loads(await reader.readline())['success'])
                writer.close();await writer.wait_closed()
            finally:
                release.set();task.cancel();await asyncio.gather(task,return_exceptions=True)


if __name__=='__main__':unittest.main()
