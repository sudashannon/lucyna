"""Real AntOmniEvo + AI SDK, deterministic HTTP model, isolated Work and no OMP."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO/'tools/work-runner'))
from automatic import Automatic
from evolution import specification
from local_agent import configuration, iterate, work_tool
from runner import Runner


class LocalAgent(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name); self.root = self.base/'works/workflow'; self.root.mkdir(parents=True)
        self.original = 'def plan_checks(paths):\n    return ["backend"] if any(p.endswith(".py") for p in paths) else []\n'
        self.improved = ('def plan_checks(paths):\n'
            '    return [name for name, yes in [("backend", any(p.endswith(".py") for p in paths)), '
            '("frontend", any(p.endswith((".js", ".ts", ".jsx", ".tsx")) for p in paths)), '
            '("integration", any(p.startswith(("contracts/", "schemas/")) for p in paths))] if yes]\n')
        for name, content in {'SESSION.md':'# Work\n状态: active\n','work.json':'{"version":1,"members":[]}', 'workflow.py':self.original}.items():
            (self.root/name).write_text(content)
        for name, cases in [('train', [(['a.py'],['backend']),(['a.ts'],['frontend']),(['contracts/a'],['integration']),([],[])]),
                            ('holdout', [(['a.js','b.py'],['backend','frontend']),(['schemas/a'],['integration']),(['doc.md'],[]),(['a.ts','b.py','contracts/a'],['backend','frontend','integration'])])]:
            (self.root/(name+'.py')).write_text('import sys,json\nfrom workflow import plan_checks\n# '+('HELD_OUT_SECRET' if name=='holdout' else 'training')+'\ncases='+repr(cases)+'\np=sum(plan_checks(a)==b for a,b in cases)\nprint(json.dumps({"passed":p,"total":len(cases)}))\nsys.exit(0 if p==len(cases) else 1)\n')
        self.profile = {'model':'','tokenBudget':60000,'wallSeconds':120,'objective':'Select backend, frontend and integration checks from changed paths.',
            'acceptance':'Pass checks, retain result for manual adoption.', 'evolution':{'targets':['workflow.py'],'iterations':1,
            'training':{'argv':['/usr/bin/python3','train.py'],'cwd':'.','files':['train.py']},
            'validation':{'argv':['/usr/bin/python3','holdout.py'],'cwd':'.','files':['holdout.py']}}}
        self.spec = specification(self.profile['evolution'], str(self.root))
        self.run = {'root':str(self.root),'privateLog':'SESSION-evolution.md','frozen':self.spec['frozen'],'hidden':['holdout.py'],'verificationSpec':self.spec['training']}
        self.state=self.base/'state';self.state.mkdir()
        helper=self.base/'helper.py';helper.write_text('print(\'{"kind":"gitless"}\')')
        self.config={'workRoot':str(self.root.parent),'helper':str(helper),'omp':'/must-not-be-invoked/omp','agentDir':'/must-not-read'}
        self.runner=Runner(self.state,self.config,rpc_factory=lambda *args:self.fail('OMP called'))
        self.addCleanup(self.runner.store.db.close)

    async def test_host_tools_reject_holdout_aliases_outside_writes_and_stale_hash(self):
        for path in ('holdout.py','./holdout.py','x/../holdout.py','/etc/passwd'):
            with self.assertRaises(ValueError):await work_tool(self.run,self.spec,'read_work_file',{'path':path})
        with self.assertRaises(ValueError):await work_tool(self.run,self.spec,'write_work_file',{'path':'SESSION.md','content':'bad','expectedSha256':'missing'})
        read=await work_tool(self.run,self.spec,'read_work_file',{'path':'workflow.py'})
        with self.assertRaises(ValueError):await work_tool(self.run,self.spec,'write_work_file',{'path':'workflow.py','content':'bad','expectedSha256':'stale'})
        self.assertEqual((self.root/'workflow.py').read_text(),self.original)
        listing=await work_tool(self.run,self.spec,'list_work_files',{'path':'.'})
        self.assertNotIn('holdout.py',[e['path'] for e in listing['entries']])
        with self.assertRaises(ValueError):await work_tool(self.run,self.spec,'bash',{})
        self.assertEqual(len(read['sha256']),64)

    async def test_missing_agent_waits_without_run_or_retry_charge(self):
        now=time.time();auto=Automatic(self.runner,clock=lambda:now,idle_seconds=0)
        auto.configure({'root':str(self.root),'profile':self.profile,'enabled':True})
        await auto.tick();await auto.tick()
        self.assertEqual(auto.view(str(self.root))['status'],'waiting_agent');self.assertEqual(self.runner.store.list(),[])
        with self.assertRaisesRegex(ValueError,'不会回退'):
            await self.runner.create(dict(self.profile,root=str(self.root),mode='evolution',requestKey='missing'))
        with patch('evo_runtime.python', return_value='/unused/python'):
            self.runner.auxiliary={'config':{'model':'fixture'}}
            self.runner.launch=lambda *args,**kwargs:None
            run=await self.runner.create(dict(self.profile,root=str(self.root),mode='evolution',requestKey='restart'),automatic={'trigger':'work_changed_idle'})
        run.update(state='interrupted',reason='service_restarted');self.runner.store.save(run);self.runner.auxiliary=None
        await auto.tick();self.assertEqual(auto.view(str(self.root))['status'],'waiting_agent')
        self.assertEqual(self.runner.store.get(run['id']).get('automaticRetries',0),0)

    async def test_cancelling_inflight_request_terminates_local_process(self):
        started,release=threading.Event(),threading.Event()
        class Slow(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']));started.set();release.wait(10)
        server=ThreadingHTTPServer(('127.0.0.1',0),Slow);threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown);self.addCleanup(release.set)
        agent=configuration({'script':str(REPO/'src/evolution-agent-worker.cjs'),'config':{'version':1,'baseURL':f'http://127.0.0.1:{server.server_port}/v1','model':'fixture','protocol':'chat-completions','timeoutSeconds':60,'autoTitle':False}})
        original=asyncio.create_subprocess_exec;children=[]
        async def spawn(*args,**kwargs):
            process=await original(*args,**kwargs);children.append(process);return process
        with patch('asyncio.create_subprocess_exec',side_effect=spawn):
            pending=asyncio.create_task(iterate(agent,dict(self.profile,tokenBudget=60000,targets=['workflow.py'],training={}),None,lambda e:None))
            for _ in range(100):
                if started.is_set():break
                await asyncio.sleep(.05)
            self.assertTrue(started.is_set());pending.cancel()
            with self.assertRaises(asyncio.CancelledError):await pending
        self.assertEqual(len(children),1);self.assertIsNotNone(children[0].returncode)

    async def test_real_optimizer_calls_local_agent_and_keeps_adoption_manual(self):
        from evo_runtime import python
        try:python()
        except ValueError as exc:self.skipTest(str(exc))
        calls=[];improved=self.improved
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));calls.append(body)
                count=len(calls);name=['read_work_file','write_work_file','verify_work',None][min(count-1,3)]
                args={}
                if name=='read_work_file':args={'path':'workflow.py'}
                if name=='write_work_file':
                    read=json.loads(next(m['content'] for m in reversed(body['messages']) if m['role']=='tool'))
                    args={'path':'workflow.py','content':improved,'expectedSha256':read['sha256']}
                message={'role':'assistant','content':'Work iteration verified.'}
                if name:message={'role':'assistant','content':None,'tool_calls':[{'id':'call_'+str(count),'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]}
                response={'id':'chat_'+str(count),'object':'chat.completion','created':1,'model':'local-fixture','choices':[{'index':0,'message':message,'finish_reason':'tool_calls' if name else 'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}
                raw=json.dumps(response).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        auxiliary={'script':str(REPO/'src/evolution-agent-worker.cjs'),'config':{'version':1,'baseURL':f'http://127.0.0.1:{server.server_port}/v1','model':'local-fixture','protocol':'chat-completions','timeoutSeconds':60,'autoTitle':False,'apiKey':'PRIVATE_FIXTURE_KEY'}}
        now=time.time();auto=self.runner.automatic=Automatic(self.runner,clock=lambda:now,idle_seconds=0)
        await auto.sync({'clientId':'desktop','works':[{'root':str(self.root),'connected':False,'busy':False}],'auxiliary':auxiliary})
        self.assertEqual(self.runner.require_auxiliary()['config']['model'],'local-fixture')
        auto.configure({'root':str(self.root),'profile':self.profile,'enabled':True})
        # Environment/bootstrap and OMP transport are forbidden throughout the full optimizer run.
        with patch.object(self.runner,'environment',side_effect=AssertionError('OMP environment loaded')):
            await auto.tick();await auto.tick()
            await asyncio.wait_for(asyncio.gather(*list(self.runner.tasks.values())),120)
        runs=self.runner.store.list();self.assertEqual(len(runs),1);run=runs[0]
        self.assertEqual(run['state'],'waiting_review',run.get('result'))
        self.assertEqual(run['evolution']['agent'],'auxiliary');self.assertEqual(run['evolution']['baseline'],.25);self.assertEqual(run['evolution']['bestScore'],1)
        self.assertEqual(run['usedTokens'],360);self.assertIsNone(run['sessionId']);self.assertIsNone(run['sessionFile']);self.assertEqual(len(calls),3)
        self.assertEqual((self.root/'workflow.py').read_text(),self.original)
        self.assertNotIn('HELD_OUT_SECRET',json.dumps(calls));self.assertNotIn('PRIVATE_FIXTURE_KEY',json.dumps(runs))
        self.assertFalse(list(self.state.rglob('journals')));self.assertFalse(list(self.state.rglob('overlay.yml')))
        for file in self.state.rglob('*'):
            if file.is_file():self.assertNotIn(b'PRIVATE_FIXTURE_KEY',file.read_bytes(),str(file))
        await auto.tick();self.assertEqual(auto.view(str(self.root))['status'],'review')
        # A service restart cannot recover plaintext credentials from persisted clients or runs.
        restarted=Runner(self.state,self.config);self.addCleanup(restarted.store.db.close);self.assertIsNone(restarted.auxiliary)


if __name__=='__main__':unittest.main()
