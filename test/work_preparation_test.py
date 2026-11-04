"""Automatic MD -> real SDK preparation -> sandbox -> AntOmniEvo -> manual adoption."""
import asyncio
import copy
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

REPO=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(REPO/'tools/work-runner'))
from automatic import Automatic
from capabilities import snapshot
from evolution import specification, atomic_json
from preparation import validate_plan, folder_for, document_snapshot, fingerprint, list_sources, PREP_TOKENS
from runner import Runner
from work import digest

ORIGINAL='def add(a,b):\n    return a\n'
GOOD='def add(a,b):\n    return a+b\n'
BAD='def add(a,b):\n    return 0\n'
MD='# Work\n目标：修复 workflow.py 的整数相加。\n验收：add(a,b) 必须返回两个整数之和，包括零与负数。\n状态: active\n'


def plan():
    files={}
    for split,cases in [('train',[(1,0,1),(1,2,3)]),('holdout',[(-3,0,-3),(-2,4,2)])]:
        files['__lucyna_eval__/'+split+'.py']=('import sys,json\nsys.path.insert(0,".")\nfrom workflow import add\n'
          'cases='+repr(cases)+'\npassed=sum(add(a,b)==expected for a,b,expected in cases)\n'
          'print(json.dumps({"passed":passed,"total":len(cases)}))\nsys.exit(0 if passed==len(cases) else 1)\n')
    check=lambda split:{'argv':['/usr/bin/python3','__lucyna_eval__/'+split+'.py'],'cwd':'.','files':['__lucyna_eval__/'+split+'.py']}
    return {'objective':'修复整数相加','acceptance':'零与负数等独立用例全部通过','targets':['workflow.py'],'inputs':['workflow.py'],
      'training':check('train'),'validation':check('holdout'),'generated':files,
      'evidence':[{'purpose':'objective','path':'SESSION.md','quote':'目标：修复 workflow.py 的整数相加。'},
                  {'purpose':'acceptance','path':'SESSION.md','quote':'验收：add(a,b) 必须返回两个整数之和，包括零与负数。'}],
      'controls':[{'label':'正确加法','expected':'pass','files':{'workflow.py':GOOD}},
                  {'label':'错误常量输出','expected':'fail','files':{'workflow.py':BAD}}]}


class Preparation(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.root=self.base/'works/a';self.root.mkdir(parents=True)
        for name,content in {'SESSION.md':MD,'work.json':'{"version":1,"members":[]}','workflow.py':ORIGINAL}.items():
            (self.root/name).write_text(content)
        self.reads={n:digest((self.root/n).read_bytes()) for n in ['SESSION.md','workflow.py']}
        self.directory=self.base/'state';self.directory.mkdir()
        helper=self.base/'helper.py';helper.write_text('print(\'{"kind":"gitless"}\')')
        self.config={'workRoot':str(self.root.parent),'helper':str(helper),'omp':'/never-start-omp','agentDir':'/never-read'}
        self.runner=Runner(self.directory,self.config,rpc_factory=lambda *a:self.fail('OMP called'))
        self.now=time.time();self.auto=self.runner.automatic=Automatic(self.runner,clock=lambda:self.now,idle_seconds=0)
        self.auto.policy(str(self.root))

    def enable_automatic(self):
        return self.auto.configure({'root':str(self.root),'enabled':True})

    async def asyncTearDown(self):
        await self.auto.shutdown()
        for task in list(self.runner.tasks.values()): task.cancel()
        await asyncio.gather(*list(self.runner.tasks.values()),return_exceptions=True)
        self.runner.store.db.close()

    async def test_default_off_but_manual_work_document_preparation_still_runs(self):
        self.runner.auxiliary={'config':{'model':'fixture'}};calls=[]
        async def blocked(agent,request,host,usage,**kwargs):
            calls.append(request)
            await host('report_work_blocker',{'message':'缺少离线回放样例'})
            return {'usedTokens':100}
        with patch('preparation.iterate',side_effect=blocked):
            await self.auto.tick()
            self.assertEqual(calls,[])
            self.assertFalse(self.auto.view(str(self.root))['enabled'])
            self.auto.request_preparation({'root':str(self.root),'clarification':'沿用 Work 文档里的样例'})
            await self.auto.tick();await asyncio.gather(*list(self.auto.preparing.values()))
        self.assertEqual(calls[0]['clarification'],'沿用 Work 文档里的样例')
        self.assertTrue(self.auto.view(str(self.root))['enabled'])

    async def test_trial_is_read_only_scoped_and_detects_constant_scorer(self):
        (self.root/'unrelated-link').symlink_to('/etc/passwd')
        with (self.root/'large.bin').open('wb') as stream: stream.truncate(120*1024*1024)
        with self.assertRaises(ValueError):snapshot(str(self.root))
        result=await validate_plan(str(self.root),plan(),self.reads)
        self.assertEqual(result['baseline'],{'training':.5,'validation':.5})
        self.assertEqual((self.root/'workflow.py').read_text(),ORIGINAL)
        self.assertFalse((self.root/'__lucyna_eval__').exists())
        self.assertNotIn('large.bin',result['spec']['inputs'])
        invalid=plan()
        invalid['generated']={n:'# '+n+'\nprint(\'{"score":1}\')' for n in invalid['generated']}
        with self.assertRaisesRegex(ValueError,'对照'):await validate_plan(str(self.root),invalid,self.reads)

    async def test_fabricated_evidence_scope_drift_and_shared_checks_are_rejected(self):
        invalid=plan();invalid['evidence'][0]['quote']='This evidence does not exist'
        with self.assertRaisesRegex(ValueError,'原文'):await validate_plan(str(self.root),invalid,self.reads)
        invalid=plan();invalid['inputs']=['../outside']
        with self.assertRaises(ValueError):await validate_plan(str(self.root),invalid,self.reads)
        invalid=plan();invalid['validation']=invalid['training']
        with self.assertRaisesRegex(ValueError,'独立'):await validate_plan(str(self.root),invalid,self.reads)
        invalid=plan();invalid['generated']={n:next(iter(invalid['generated'].values())) for n in invalid['generated']}
        with self.assertRaisesRegex(ValueError,'内容相同'):await validate_plan(str(self.root),invalid,self.reads)
        invalid['training']['argv'][1]='./'+invalid['training']['argv'][1]
        invalid['validation']['argv'][1]='/work/'+invalid['validation']['argv'][1]
        with self.assertRaisesRegex(ValueError,'内容相同'):await validate_plan(str(self.root),invalid,self.reads)
        (self.root/'workflow.py').write_text('concurrent edit')
        with self.assertRaisesRegex(ValueError,'变化'):await validate_plan(str(self.root),plan(),self.reads)

    async def test_control_edits_are_unique_and_reset_to_the_original_between_controls(self):
        candidate=plan()
        for control,replacement in zip(candidate['controls'],['return a+b','return 0']):
            control['files']['workflow.py']={'find':'return a','replace':replacement}
        result=await validate_plan(str(self.root),candidate,self.reads)
        self.assertEqual(result['controls'][0]['scores'],{'training':1,'validation':1})
        self.assertEqual(result['controls'][1]['scores'],{'training':0,'validation':0})
        self.assertEqual((self.root/'workflow.py').read_text(),ORIGINAL)
        candidate['controls'][0]['files']['workflow.py']['find']='a'
        with self.assertRaisesRegex(ValueError,'唯一匹配'):
            await validate_plan(str(self.root),candidate,self.reads)
        candidate['controls'][0]['files']['workflow.py']={'find':'','replace':'return 0'}
        with self.assertRaisesRegex(ValueError,'非空 find'):
            await validate_plan(str(self.root),candidate,self.reads)

    async def test_identical_driver_with_distinct_case_arguments_is_a_valid_holdout(self):
        candidate=plan()
        driver='import sys,json\nsys.path.insert(0,".")\nfrom workflow import add\na,b,want=map(int,sys.argv[1:])\nok=add(a,b)==want\nprint(json.dumps({"passed":int(ok),"total":1}))\nsys.exit(0 if ok else 1)\n'
        candidate['generated']={name:driver for name in candidate['generated']}
        candidate['training']['argv']+=['1','2','3']
        candidate['validation']['argv']+=['-2','4','2']
        result=await validate_plan(str(self.root),candidate,self.reads)
        self.assertEqual(result['baseline'],{'training':0,'validation':0})
        self.assertEqual(result['controls'][0]['scores'],{'training':1,'validation':1})

    async def test_draft_baseline_cannot_publish_a_profile_or_start_an_experiment(self):
        self.enable_automatic()
        self.runner.auxiliary={'config':{'model':'fixture'}}
        async def trial(agent,request,host,usage,**kwargs):
            for name in self.reads:await host('read_work_file',{'path':name})
            draft=plan();draft['controls']=[]
            response=await host('submit_work_evaluation',draft)
            self.assertFalse(response['ready']);self.assertTrue(response['draft'])
            self.assertEqual(response['baseline'],{'training':.5,'validation':.5})
            self.assertIn('passed',response['checks']['training']['output'])
            self.assertEqual(response['handoff']['plan'],draft)
            self.assertEqual(response['handoff']['originalTargets'][0]['content'],ORIGINAL)
            saved=json.loads((folder_for(self.directory,str(self.root),self.auto.policy(str(self.root))['preparation']['id'])/'draft.json').read_text())
            self.assertEqual(saved['plan'],draft)
            self.assertEqual(saved['baseline'],response['baseline'])
            self.assertIsNone(self.auto.policy(str(self.root))['profile'])
            await host('report_work_blocker',{'message':'基线已确认，但正反对照尚未准备好'})
            return {'usedTokens':200}
        with patch('preparation.iterate',side_effect=trial):
            await self.auto.tick();await asyncio.gather(*list(self.auto.preparing.values()))
        self.assertIsNone(self.auto.view(str(self.root))['profile'])
        self.assertEqual(self.auto.view(str(self.root))['status'],'needs_input')
        self.assertEqual(self.runner.store.list(),[])
        self.assertEqual((self.root/'workflow.py').read_text(),ORIGINAL)

    async def test_trial_compile_and_runtime_diagnostics_reach_the_agent(self):
        invalid=plan();invalid['unexpected_field']=True
        with self.assertRaisesRegex(ValueError,'未定义字段：unexpected_field'):
            await validate_plan(str(self.root),invalid,self.reads)
        invalid=plan();invalid['controls']=[]
        invalid['generated']['__lucyna_eval__/train.py']='raise RuntimeError("fixture compiler diagnosis")'
        with self.assertRaisesRegex(ValueError,'fixture compiler diagnosis'):
            await validate_plan(str(self.root),invalid,self.reads)

    async def test_training_only_failure_cannot_publish_an_uninformative_holdout(self):
        invalid=plan();invalid['controls']=[]
        path='__lucyna_eval__/holdout.py'
        invalid['generated'][path]=invalid['generated'][path].replace('(-2, 4, 2)','(-2, 0, -2)')
        with self.assertRaisesRegex(ValueError,'训练已发现失败，但留出检查全部通过'):
            await validate_plan(str(self.root),invalid,self.reads)
        (self.root/'workflow.py').write_text(GOOD)
        self.reads['workflow.py']=digest(GOOD.encode())
        valid=plan();valid['controls']=[]
        self.assertEqual((await validate_plan(str(self.root),valid,self.reads))['baseline'],{'training':1,'validation':1})

    async def test_controls_can_finalize_only_a_previously_validated_draft(self):
        self.enable_automatic()
        self.runner.auxiliary={'config':{'model':'fixture'}}
        async def incremental(agent,request,host,usage,**kwargs):
            with self.assertRaisesRegex(ValueError,'尚无成功草稿'):
                await host('submit_work_evaluation',{'controls':plan()['controls']})
            for name in self.reads:await host('read_work_file',{'path':name})
            draft=plan();draft['controls']=[]
            self.assertTrue((await host('submit_work_evaluation',draft))['draft'])
            with self.assertRaisesRegex(ValueError,'缺少'):
                await host('submit_work_evaluation',{'controls':plan()['controls'],'objective':'Cannot partially change the goal'})
            response=await host('submit_work_evaluation',{'controls':plan()['controls']})
            self.assertTrue(response['ready'])
            return {'usedTokens':100}
        with patch('preparation.iterate',side_effect=incremental):
            await self.auto.tick();await asyncio.gather(*list(self.auto.preparing.values()))
        saved=self.auto.policy(str(self.root))
        self.assertEqual(saved['preparation']['state'],'ready')
        self.assertEqual(saved['profile']['objective'],plan()['objective'])
        self.assertEqual(saved['profile']['evolution']['targets'],['workflow.py'])
        self.assertEqual((self.root/'workflow.py').read_text(),ORIGINAL)

    async def test_compiled_profile_is_work_bound_and_generated_checks_are_immutable(self):
        result=await validate_plan(str(self.root),plan(),self.reads)
        key='a'*32;result['profile']['evolution']['prepared']=key
        folder=folder_for(self.directory,str(self.root),key);folder.mkdir(parents=True)
        atomic_json(folder/'compiled.json',result)
        spec=specification(result['profile']['evolution'],str(self.root),self.directory)
        self.assertEqual(spec['targets'],['workflow.py'])
        altered=copy.deepcopy(result['profile']['evolution']);altered['targets']=['SESSION.md']
        with self.assertRaisesRegex(ValueError,'冻结'):specification(altered,str(self.root),self.directory)
        result['spec']['generated']['__lucyna_eval__/train.py']='print(1)';atomic_json(folder/'compiled.json',result)
        with self.assertRaisesRegex(ValueError,'评测文件已变化'):specification(result['profile']['evolution'],str(self.root),self.directory)

    async def test_blocker_is_cached_manual_retry_is_bounded_and_restart_retains_charge(self):
        self.enable_automatic()
        calls=[];self.runner.auxiliary={'config':{'model':'fixture'}}
        async def blocked(agent,request,host,usage,**kwargs):
            calls.append(request);await host('report_work_blocker',{'message':'缺少离线回放样例，请提供输入与预期结果'});usage({'usedTokens':150});return {'usedTokens':150}
        with patch('preparation.iterate',side_effect=blocked):
            await self.auto.tick();await asyncio.gather(*list(self.auto.preparing.values()))
            for _ in range(3):await self.auto.tick()
            self.assertEqual(len(calls),1);self.assertEqual(self.auto.view(str(self.root))['status'],'needs_input')
            self.auto.request_preparation({'root':str(self.root),'clarification':'使用合成离线数据'})
            await self.auto.tick();await asyncio.gather(*list(self.auto.preparing.values()))
            self.assertEqual(calls[-1]['clarification'],'使用合成离线数据')
            self.auto.request_preparation({'root':str(self.root)})
            await self.auto.tick();self.assertEqual(self.auto.view(str(self.root))['status'],'preparation_limit')
            self.assertEqual(len(calls),2)
        value=self.auto.policy(str(self.root));value['preparation']['state']='checking';self.runner.store.save_automation(value)
        restarted=Automatic(self.runner,clock=lambda:self.now)
        self.assertEqual(restarted.view(str(self.root))['preparation']['state'],'failed')
        self.assertEqual(restarted.view(str(self.root))['preparation']['usedTokens'],150)

    async def test_pause_cancels_preparation_and_does_not_publish_profile(self):
        self.enable_automatic()
        self.runner.auxiliary={'config':{'model':'fixture'}};entered=asyncio.Event()
        async def slow(*args,**kwargs):entered.set();await asyncio.Event().wait()
        with patch('preparation.iterate',side_effect=slow):
            await self.auto.tick();await asyncio.wait_for(entered.wait(),5)
            self.auto.configure({'root':str(self.root),'enabled':False})
            await asyncio.gather(*list(self.auto.preparing.values()),return_exceptions=True)
        value=self.auto.view(str(self.root));self.assertFalse(value['enabled']);self.assertIsNone(value['profile'])
        self.assertEqual(value['preparation']['state'],'paused');self.assertTrue(value['preparation']['usageEstimated'])

    async def test_unlimited_preparation_records_usage_without_fabricating_a_cap(self):
        self.enable_automatic()
        self.runner.auxiliary={'config':{'model':'fixture'}}
        async def fail(agent,request,host,usage,**kwargs):
            self.assertIsNone(request['tokenBudget']);usage({'usedTokens':250000})
            raise ValueError('fixture interruption')
        with patch('preparation.iterate',side_effect=fail):
            await self.auto.tick();await asyncio.gather(*list(self.auto.preparing.values()))
        self.assertEqual(self.auto.view(str(self.root))['preparation']['usedTokens'],250000)
        self.auto.request_preparation({'root':str(self.root)})
        async def block(agent,request,host,usage,**kwargs):
            self.assertIsNone(request['tokenBudget'])
            await host('report_work_blocker',{'message':'缺少必要的离线输入'})
            return {'usedTokens':100}
        with patch('preparation.iterate',side_effect=block):
            await self.auto.tick();await asyncio.gather(*list(self.auto.preparing.values()))
        value=self.auto.view(str(self.root))
        self.assertEqual(sum(a['usedTokens'] for a in value['preparationAttempts']),250100)

    async def test_preparation_timeout_has_a_diagnostic_and_keeps_known_usage(self):
        self.enable_automatic()
        self.runner.auxiliary={'config':{'model':'fixture'}}
        async def slow(agent,request,host,usage,**kwargs):
            usage({'usedTokens':250000})
            await asyncio.Event().wait()
        with patch('preparation.iterate',side_effect=slow),patch('preparation.PREP_SECONDS',.05):
            await self.auto.tick();await asyncio.gather(*list(self.auto.preparing.values()))
        value=self.auto.view(str(self.root))
        self.assertEqual(value['status'],'preparation_failed')
        self.assertIn('运行时限',value['preparation']['message'])
        self.assertEqual(value['preparation']['errorType'],'TimeoutError')
        self.assertEqual(value['preparation']['usedTokens'],250000)
        self.assertTrue(value['preparation']['usageEstimated'])
        self.assertIsNone(value['profile']);self.assertEqual(self.runner.store.list(),[])

    async def test_long_markdown_is_paged_before_model_context_is_expanded(self):
        self.enable_automatic()
        self.runner.auxiliary={'config':{'model':'fixture'}}
        document=MD+'证据与背景。'*10000
        (self.root/'SESSION.md').write_text(document)
        async def read(agent,request,host,usage,**kwargs):
            first=await host('read_work_file',{'path':'SESSION.md'})
            self.assertEqual(first['content'],document[:32000]);self.assertEqual(first['nextOffset'],32000)
            second=await host('read_work_file',{'path':'SESSION.md','offset':first['nextOffset'],'limit':500})
            self.assertEqual(second['content'],document[32000:32500]);self.assertEqual(second['nextOffset'],32500)
            self.assertEqual(second['sha256'],first['sha256'])
            with self.assertRaisesRegex(ValueError,'页大小'):await host('read_work_file',{'path':'SESSION.md','limit':99999})
            await host('report_work_blocker',{'message':'已读取分页文档，尚缺离线样例'})
            return {'usedTokens':100}
        with patch('preparation.iterate',side_effect=read):
            await self.auto.tick();await asyncio.gather(*list(self.auto.preparing.values()))
        self.assertEqual(self.auto.view(str(self.root))['preparation']['state'],'needs_input')

    async def test_source_lookup_is_bounded_and_never_follows_links(self):
        folder=self.root/'repos/member/src';folder.mkdir(parents=True)
        (folder/'timeline.cpp').write_text('int timeline;')
        (folder/'timeline-link.cpp').symlink_to('/etc/passwd')
        hidden=folder/'.git';hidden.mkdir();(hidden/'timeline-secret.cpp').write_text('private')
        result=list_sources(str(self.root),{'path':'repos','recursive':True,'pattern':'*timeline*'})
        self.assertEqual([e['path'] for e in result['entries']],['repos/member/src/timeline.cpp'])
        self.assertTrue(result['entries'][0]['readable'])
        single=list_sources(str(self.root),{'path':'repos/member/src/timeline.cpp','recursive':None,'pattern':None})
        self.assertEqual(single['entries'],result['entries'])
        for index in range(65):(folder/f'{index}.txt').write_text('fixture')
        result=list_sources(str(self.root),{'path':'repos/member/src'})
        self.assertEqual(len(result['entries']),60);self.assertTrue(result['truncated'])
        with self.assertRaises(ValueError):list_sources(str(self.root),{'path':'../'})

    async def test_immediate_pause_and_removed_referenced_documents(self):
        from cli import preparing
        self.enable_automatic()
        self.runner.auxiliary={'config':{'model':'fixture'}}
        with patch('preparation.iterate',side_effect=AssertionError('cancelled task ran')):
            await self.auto.tick()
            self.assertTrue(preparing(self.directory))
            self.auto.configure({'root':str(self.root),'enabled':False})
            await asyncio.gather(*list(self.auto.preparing.values()),return_exceptions=True)
        self.assertFalse(preparing(self.directory))
        value=self.auto.view(str(self.root))
        self.assertEqual(value['preparation']['state'],'paused')
        self.assertEqual(value['preparationAttempts'][0]['usedTokens'],0)
        extra=self.root/'docs/acceptance.md';extra.parent.mkdir();extra.write_text('独立验收依据')
        documents=document_snapshot(str(self.root),['docs/acceptance.md'])
        self.assertIn('docs/acceptance.md',documents)
        extra.write_text('更新后的验收依据')
        self.assertNotEqual(document_snapshot(str(self.root),documents),documents)
        extra.unlink()
        self.assertNotIn('docs/acceptance.md',document_snapshot(str(self.root),documents))

    async def test_document_changes_reprepare_but_manual_profiles_are_preserved(self):
        self.runner.auxiliary={'config':{'model':'fixture'}}
        result=await validate_plan(str(self.root),plan(),self.reads)
        key='b'*32;result['profile']['evolution']['prepared']=key
        folder=folder_for(self.directory,str(self.root),key);folder.mkdir(parents=True);atomic_json(folder/'compiled.json',result)
        value=self.auto.policy(str(self.root));value.update(profile=result['profile'],profileOrigin='agent',profileDocuments=document_snapshot(str(self.root)))
        self.runner.store.save_automation(value)
        self.auto.configure({'root':str(self.root),'enabled':True,'profile':result['profile']})
        (self.root/'SESSION.md').write_text(MD+'\n新的范围说明')
        # Manually saved profiles are never silently regenerated, even after document changes.
        with patch.object(self.auto,'advance_preparation',side_effect=AssertionError('manual profile replaced')),patch('evo_runtime.python',return_value='/unused'):
            self.runner.launch=lambda *a,**k:None
            await self.auto.tick()
        self.assertEqual(self.auto.view(str(self.root))['profileOrigin'],'manual')
        value=self.auto.policy(str(self.root));value.update(profileOrigin='agent',observedFingerprint=None);self.runner.store.save_automation(value)
        called=[]
        async def prepare(value):called.append(value)
        with patch.object(self.auto,'advance_preparation',side_effect=prepare):await self.auto.tick()
        self.assertEqual(len(called),1)

    async def test_real_sdk_prepares_from_md_then_optimizer_iterates_without_omp(self):
        self.enable_automatic()
        from evo_runtime import python
        try:python()
        except ValueError as exc:self.skipTest(str(exc))
        calls=[];counts={'prepare':0,'iterate':0}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*a):pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));calls.append(body)
                stage='prepare' if 'Prepare a bounded' in body['messages'][0]['content'] else 'iterate'
                index=counts[stage];counts[stage]+=1
                names=['read_work_file','read_work_file','submit_work_evaluation'] if stage=='prepare' else ['read_work_file','write_work_file','verify_work']
                name=names[min(index,2)]
                if stage=='prepare':args={'path':'SESSION.md' if index==0 else 'workflow.py'} if index<2 else plan()
                elif index==0:args={'path':'workflow.py'}
                elif index==1:
                    value=json.loads(next(m['content'] for m in reversed(body['messages']) if m['role']=='tool'))
                    args={'path':'workflow.py','expectedSha256':value['sha256'],'content':GOOD}
                else:args={}
                message={'role':'assistant','content':None,'tool_calls':[{'id':'call_'+str(len(calls)),'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]}
                response={'id':'chat_'+str(len(calls)),'object':'chat.completion','created':1,'model':'fixture','choices':[{'index':0,'message':message,'finish_reason':'tool_calls'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}
                raw=json.dumps(response).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        auxiliary={'script':str(REPO/'src/evolution-agent-worker.cjs'),'config':{'version':1,'baseURL':f'http://127.0.0.1:{server.server_port}/v1','model':'fixture','protocol':'chat-completions','timeoutSeconds':60,'autoTitle':False,'apiKey':'PRIVATE_PREPARATION_KEY'}}
        (self.root/'unrelated-link').symlink_to('/etc/passwd')
        with (self.root/'large.bin').open('wb') as stream:stream.truncate(120*1024*1024)
        await self.auto.sync({'clientId':'desktop','works':[{'root':str(self.root),'busy':False,'connected':False}],'auxiliary':auxiliary})
        with patch.object(self.runner,'environment',side_effect=AssertionError('OMP environment loaded')):
            await self.auto.tick();await asyncio.wait_for(asyncio.gather(*list(self.auto.preparing.values())),90)
            self.assertEqual(self.auto.view(str(self.root))['preparation']['state'],'ready',self.auto.view(str(self.root)))
            await self.auto.tick();await self.auto.tick()
            await asyncio.wait_for(asyncio.gather(*list(self.runner.tasks.values())),120)
        run=self.runner.store.list()[0]
        self.assertEqual(run['state'],'waiting_review',run.get('result'))
        self.assertEqual(run['evolution']['baseline'],.5);self.assertEqual(run['evolution']['bestScore'],1)
        self.assertEqual((self.root/'workflow.py').read_text(),ORIGINAL)
        self.assertIsNone(run['sessionId']);self.assertIsNone(run['sessionFile'])
        self.assertEqual(counts['prepare'],3)
        iteration_calls=calls[3:]
        self.assertNotIn('正确加法',json.dumps(iteration_calls,ensure_ascii=False))
        self.assertNotIn('(-2, 4, 2)',json.dumps(iteration_calls))
        self.assertIsNone(run['tokenBudget'])
        # Unrelated files do not block adoption; selected source drift does.
        (self.root/'unrelated.txt').write_text('another task')
        (self.root/'SESSION.md').write_text(MD+'changed')
        with self.assertRaisesRegex(ValueError,'变化'):await self.runner.dispatch({'op':'adopt','runId':run['id']})
        (self.root/'SESSION.md').write_text(MD)
        await self.runner.dispatch({'op':'adopt','runId':run['id']})
        self.assertEqual((self.root/'workflow.py').read_text(),GOOD)
        await self.runner.dispatch({'op':'rollback','runId':run['id']})
        self.assertEqual((self.root/'workflow.py').read_text(),ORIGINAL)
        for p in self.directory.rglob('*'):
            if p.is_file():self.assertNotIn(b'PRIVATE_PREPARATION_KEY',p.read_bytes(),str(p))


if __name__=='__main__':unittest.main()
