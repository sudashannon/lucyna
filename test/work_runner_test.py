"""Offline WSL tests: no model calls, services or personal Work access."""
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tools/work-runner'))
from protocol import FrameDecoder
from runner import Runner
from storage import Store
from work import digest, file_tool, verification_spec, check_frozen, verify


class Files(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'SESSION.md').write_text('# Work\n- **状态**: `active`\n')
        (self.root/'work.json').write_text('{"version":1,"members":[]}')
        (self.root/'notes').mkdir()
        self.run = {'root': str(self.root), 'frozen': {}, 'privateLog': 'SESSION-12345678.md'}

    def write(self, path, content, sha='missing'):
        return file_tool(self.run, 'write_work_file', {'path':path, 'content':content, 'expectedSha256':sha})

    def test_traversal_symlinks_hardlinks_private_paths(self):
        for path in ('../escape', '/tmp/file', 'notes/../../escape', '.git/config', '.env.local', 'repos/a/.git', 'work.json', 'SESSION-other.md'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.write(path, 'bad')
        (self.root/'link').symlink_to('/tmp')
        with self.assertRaises(ValueError):
            self.write('link/escape', 'bad')
        os.link(self.root/'SESSION.md', self.root/'hardlink')
        with self.assertRaises(ValueError):
            file_tool(self.run, 'read_work_file', {'path':'hardlink'})

    def test_compare_and_swap_private_log_and_work_state(self):
        result=self.write('notes/a.md','one')
        (self.root/'notes/a.md').write_text('external change')
        with self.assertRaisesRegex(ValueError, '变化'):
            self.write('notes/a.md','two',result['sha256'])
        result=self.write(self.run['privateLog'],'first\n')
        with self.assertRaisesRegex(ValueError, '追加'):
            self.write(self.run['privateLog'],'replacement',result['sha256'])
        self.write(self.run['privateLog'],'first\nsecond',result['sha256'])
        state=digest((self.root/'SESSION.md').read_bytes())
        with self.assertRaisesRegex(ValueError, '总体状态'):
            self.write('SESSION.md','# Work\n- **状态**: `delivered`\n',state)

    def test_frozen_verification_is_immutable_and_drift_checked(self):
        (self.root/'check.py').write_text('print("ok")')
        spec,frozen=verification_spec({'argv':['/usr/bin/python3','check.py'],'files':['check.py']},str(self.root))
        self.run.update(verificationSpec=spec,frozen=frozen)
        with self.assertRaises(ValueError):
            self.write('check.py','pass',frozen['check.py'])
        (self.root/'check.py').write_text('changed')
        with self.assertRaisesRegex(ValueError, '验收输入'):
            check_frozen(self.run)

    def test_verifier_cannot_write_work_or_read_home_and_reports_failure(self):
        (self.root/'.env').write_text('FIXTURE=private')
        (self.root/'.ssh').mkdir();(self.root/'.ssh/key').write_text('fixture-private')
        script='from pathlib import Path\nassert not Path("/home").exists()\ntry:\n assert Path("/work/.env").read_text()==""\nexcept PermissionError:\n pass\nassert list(Path("/work/.ssh").iterdir())==[]\ntry:\n Path("/work/escape").write_text("bad")\nexcept OSError:\n print("isolated")\nelse:\n raise AssertionError("writable")\n'
        (self.root/'check.py').write_text(script)
        spec,frozen=verification_spec({'argv':['/usr/bin/python3','check.py'],'files':['check.py']},str(self.root))
        self.run.update(verificationSpec=spec,frozen=frozen)
        result=asyncio.run(verify(self.run));self.assertTrue(result['passed'], result);self.assertIn('isolated',result['output'])
        self.assertFalse((self.root/'escape').exists())


class Protocol(unittest.TestCase):
    def test_large_multibyte_message_and_bad_sequences(self):
        payload=json.dumps({'type':'response','text':'测试'*200000},ensure_ascii=False).encode()
        pieces=[payload[i:i+256*1024] for i in range(0,len(payload),256*1024)]
        frames=[{'type':'rpc_chunk','chunkId':'a','index':i,'count':len(pieces),'byteLength':len(payload),'data':base64.b64encode(chunk).decode()} for i,chunk in enumerate(pieces)]
        decoder=FrameDecoder()
        for frame in frames: result=decoder.push(frame)
        self.assertEqual(result['text'],'测试'*200000)
        with self.assertRaises(ValueError): decoder.push(frames[1])
        decoder.push(frames[0])
        with self.assertRaises(ValueError): decoder.push({'type':'response'})
        self.assertIsNone(decoder.pending)
        with self.assertRaises(ValueError): decoder.push(dict(frames[0],data='!!!'))


class FakeRpc:
    def __init__(self):
        self.events=asyncio.Queue()
        self.process=type('Process',(),{'pid':os.getpid()})()
        self.sent=[]
        self.closed=False
        self.creates=0
        self.reader=asyncio.get_running_loop().create_future()

    async def request(self, kind, **data):
        if kind=='get_available_commands':return {'commands':[{'name':'lucyna-file-scope'}]}
        if kind=='prompt':
            await self.events.put({'type':'extension_ui_request','method':'notify','message':'lucyna-file-scope:v1'})
            return None
        if kind=='get_state':
            return {'sessionId':'12345678-fixture', 'sessionFile':str(self.folder/'fixture.jsonl'),'model':{'id':'fake'},'dumpTools':[]}
        if kind=='goal' and data['op']=='get': return {'goal':None}
        if kind=='goal' and data['op']=='create':
            self.creates+=1
            self.folder.mkdir(parents=True, exist_ok=True)
            (self.folder/'fixture.jsonl').write_text('{}\n')
            await self.events.put({'type':'session_settled'})  # startup event must not terminate the run
            await self.events.put({'type':'agent_start'})
            await self.events.put({'type':'goal_updated','goal':{'id':'goal','status':'active','tokensUsed':3}})
            await self.events.put({'type':'host_tool_call','toolName':'ask_work_user','id':'call','arguments':{'question':'Continue?'}})
        return {}

    async def send(self, frame):
        if self.reader.done():
            raise BrokenPipeError('fixture process exited')
        self.sent.append(frame)
        await self.events.put({'type':'goal_updated','goal':{'id':'goal','status':'complete','tokensUsed':7}})
        await self.events.put({'type':'session_settled'})

    async def close(self):
        self.closed=True
        self.reader.cancel()


class Lifecycle(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.root=self.base/'works/a';self.root.mkdir(parents=True)
        (self.root/'SESSION.md').write_text('# Work\n状态: active\n');(self.root/'work.json').write_text('{"version":1,"members":[]}')
        helper=self.base/'helper.py';helper.write_text('print(\'{"kind":"gitless"}\')')
        self.directory=self.base/'state';self.directory.mkdir()
        self.config={'workRoot':str(self.root.parent),'helper':str(helper),'omp':'fake','agentDir':str(self.base),'inheritEnvironment':False}
        self.fake=FakeRpc()
        async def factory(args,*_):
            self.fake.folder=Path(args[args.index('--session-dir')+1]);return self.fake
        self.runner=Runner(self.directory,self.config,factory)
        self.request={'op':'create','requestKey':'one','root':str(self.root),'objective':'Task','acceptance':'Human review'}

    async def asyncTearDown(self):
        for task in list(self.runner.tasks.values()): task.cancel()
        await asyncio.gather(*list(self.runner.tasks.values()),return_exceptions=True)
        self.runner.store.db.close()

    async def until(self,key,state):
        for _ in range(300):
            run=self.runner.store.get(key)
            if run['state']==state:return run
            await asyncio.sleep(.01)
        self.fail(str(run))

    async def test_idempotency_exclusion_answer_replay_and_manual_acceptance(self):
        first=await self.runner.dispatch(self.request)
        duplicate=await self.runner.dispatch(self.request);self.assertEqual(first['id'],duplicate['id'])
        with self.assertRaisesRegex(ValueError,'已有'):
            await self.runner.dispatch(dict(self.request,requestKey='other'))
        with self.assertRaisesRegex(ValueError,'不同任务'):
            await self.runner.dispatch(dict(self.request,objective='changed'))
        run=await self.until(first['id'],'waiting_user')
        with self.assertRaisesRegex(ValueError,'失效'):
            await self.runner.dispatch({'op':'answer','runId':run['id'],'answerKey':'stale','answer':'yes'})
        answer={'op':'answer','runId':run['id'],'answerKey':run['question']['key'],'answer':'yes'}
        await self.runner.dispatch(answer);await self.runner.dispatch(answer)
        final=await self.until(run['id'],'waiting_review');self.assertEqual(final['usedTokens'],7)
        self.assertEqual(len(self.fake.sent),1)
        await self.runner.dispatch({'op':'accept','runId':run['id']});self.assertEqual(self.runner.store.get(run['id'])['state'],'completed')
        page=await self.runner.dispatch({'op':'get','runId':run['id'],'after':0});self.assertTrue(page['events'])
        self.assertEqual((await self.runner.dispatch({'op':'get','runId':run['id'],'after':page['events'][-1]['seq']}))['events'],[])

    async def test_cancel_before_dispatch_and_restart_never_replays(self):
        first=await self.runner.dispatch(self.request)
        stopped=await self.runner.dispatch({'op':'cancel','runId':first['id']});self.assertEqual(stopped['state'],'cancelled')
        again=await self.runner.dispatch(dict(self.request,requestKey='two'))
        waiting=await self.until(again['id'],'waiting_user')
        await self.runner.stop(waiting,False)
        self.assertTrue(self.fake.closed)
        run=self.runner.store.get(waiting['id']);run.update(state='running',question={'key':'old'})
        self.runner.store.save(run)
        reopened=Runner(self.directory,self.config)
        try:
            recovered=reopened.store.get(run['id']);self.assertEqual(recovered['state'],'interrupted');self.assertIsNone(recovered['question']);self.assertFalse(reopened.tasks)
        finally:reopened.store.db.close()

    async def test_process_death_expires_question_without_waiting_for_user(self):
        first=await self.runner.dispatch(self.request)
        waiting=await self.until(first['id'],'waiting_user')
        answer_key=waiting['question']['key']
        self.fake.reader.set_result(None)
        ended=await self.until(first['id'],'interrupted')
        self.assertIsNone(ended['question'])
        with self.assertRaisesRegex(ValueError,'失效'):
            await self.runner.dispatch({'op':'answer','runId':first['id'],'answerKey':answer_key,'answer':'late'})

    async def test_lost_completion_event_uses_journal_without_replaying_objective(self):
        first=await self.runner.dispatch(self.request)
        waiting=await self.until(first['id'],'waiting_user')
        await self.runner.dispatch({'op':'answer','runId':first['id'],'answerKey':waiting['question']['key'],'answer':'yes'})
        run=await self.until(first['id'],'waiting_review')
        await asyncio.gather(*list(self.runner.tasks.values()),return_exceptions=True)
        run=self.runner.store.get(run['id'])
        run.update(state='interrupted',goal={'status':'active','objective':'Original'},goalIntent={'objective':'Original'})
        Path(run['sessionFile']).write_text(json.dumps({'customType':'goal-completed','data':{'objective':'Original'}})+'\n')
        self.runner.store.save(run)
        self.fake.reader=asyncio.get_running_loop().create_future()
        await self.runner.dispatch({'op':'resume','runId':run['id']})
        await self.until(run['id'],'waiting_review')
        self.assertEqual(self.fake.creates,1)


if __name__=='__main__':unittest.main()
