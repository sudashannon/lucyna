"""Automatic scheduling contracts; temporary Work, fake clock, no model calls."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tools/work-runner'))
from automatic import Automatic
from runner import Runner
from capabilities import snapshot


class Scheduling(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name); self.root = self.base/'works/a'; self.root.mkdir(parents=True)
        for name, value in {'SESSION.md':'# Work\n状态: active', 'work.json':'{"version":1,"members":[]}',
                            'workflow.py':'VALUE = 1\n', 'train.py':'print(1)', 'holdout.py':'print(2)'}.items():
            (self.root/name).write_text(value)
        helper = self.base/'helper.py'; helper.write_text('print(\'{"kind":"gitless"}\')')
        self.directory = self.base/'state'; self.directory.mkdir()
        self.config = {'workRoot':str(self.root.parent), 'helper':str(helper), 'omp':'unused', 'agentDir':str(self.base)}
        self.runner = Runner(self.directory, self.config)
        self.now = time.time(); self.launched = []
        self.runner.launch = lambda key, resume=False:self.launched.append((key, resume))
        self.auto = self.runner.automatic = Automatic(self.runner, clock=lambda:self.now, idle_seconds=10, cooldown=100, daily_limit=2)
        self.profile = {'objective':'Improve routing', 'acceptance':'Held out checks pass', 'model':'', 'tokenBudget':5000, 'wallSeconds':120,
            'evolution':{'targets':['workflow.py'], 'iterations':1,
            'training':{'argv':['/usr/bin/python3','train.py'],'files':['train.py'],'cwd':'.'},
            'validation':{'argv':['/usr/bin/python3','holdout.py'],'files':['holdout.py'],'cwd':'.'}}}
        mocked = patch('evo_runtime.python', return_value='/unused/python'); mocked.start(); self.addCleanup(mocked.stop)

    async def asyncTearDown(self):
        self.runner.store.db.close()

    def configure(self):
        return self.auto.configure({'root':str(self.root),'enabled':True,'profile':copy.deepcopy(self.profile)})

    async def sync(self, busy=False, connected=True):
        await self.auto.sync({'clientId':'desktop','works':[{'root':str(self.root),'busy':busy,'connected':connected}]})

    async def trigger(self):
        await self.auto.tick(); self.now += 11; await self.auto.tick()
        return self.runner.store.get(self.launched[-1][0])

    def end(self, run, state='completed', reason='no_improvement'):
        run.update(state=state, reason=reason); self.runner.store.save(run)

    async def test_missing_configuration_never_invokes_model_and_cannot_escape_work(self):
        await self.sync(); await self.auto.tick()
        self.assertEqual(self.auto.view(str(self.root))['status'],'needs_profile'); self.assertEqual(self.launched,[])
        with self.assertRaises(ValueError):self.auto.configure({'root':'/else','enabled':True})
        self.profile['evolution']['targets']=['holdout.py']
        with self.assertRaises(ValueError):self.configure()

    async def test_busy_stale_clients_and_stable_idle_trigger_exactly_one_run(self):
        self.configure(); await self.sync(busy=True); await self.auto.tick()
        self.assertEqual(self.auto.view(str(self.root))['status'],'waiting_idle')
        self.now += 60; await self.auto.tick()
        self.assertEqual(self.auto.view(str(self.root))['status'],'unknown_client'); self.assertEqual(self.launched,[])
        await self.sync(); run = await self.trigger()
        self.assertEqual(run['automatic']['trigger'],'work_changed_idle'); self.assertEqual(run['tokenBudget'],5000)
        self.assertEqual(run['request']['evolution'],self.profile['evolution'])
        self.end(run); await self.auto.tick(); self.assertEqual(len(self.launched),1)
        self.assertEqual(self.auto.view(str(self.root))['status'],'unchanged')
        self.runner.store.db.close(); self.runner = Runner(self.directory,self.config)
        self.runner.launch=lambda *args,**kwargs:self.fail('Restart duplicated automatic run')
        await self.runner.automatic.tick(); self.assertEqual(len(self.runner.store.list()),1)

    async def test_review_remains_manual_and_disable_survives_new_profile(self):
        self.configure(); run=await self.trigger(); self.end(run,'waiting_review','candidate_ready')
        before=(self.root/'workflow.py').read_bytes()
        for _ in range(3):self.now+=100; await self.auto.tick()
        self.assertEqual(self.auto.view(str(self.root))['status'],'review')
        self.assertEqual((self.root/'workflow.py').read_bytes(),before); self.assertEqual(len(self.launched),1)
        self.auto.configure({'root':str(self.root),'enabled':False}); self.auto.remember(run)
        await self.auto.tick(); self.assertEqual(self.auto.view(str(self.root))['status'],'disabled')
        self.assertEqual(self.auto.configure({'root':str(self.root),'enabled':True})['status'],'review')

    async def test_changed_work_respects_cooldown_and_rolling_daily_limit(self):
        self.configure(); first=await self.trigger(); self.end(first)
        (self.root/'workflow.py').write_text('VALUE = 2'); await self.auto.tick(); self.now+=11; await self.auto.tick()
        self.assertEqual(self.auto.view(str(self.root))['status'],'cooldown'); self.assertEqual(len(self.launched),1)
        self.now+=100; await self.auto.tick(); second=self.runner.store.get(self.launched[-1][0]); self.end(second)
        self.assertEqual(len(self.launched),2)
        (self.root/'workflow.py').write_text('VALUE = 3'); await self.auto.tick(); self.now+=101; await self.auto.tick()
        self.assertEqual(self.auto.view(str(self.root))['status'],'daily_limit'); self.assertEqual(len(self.launched),2)

    async def test_interrupted_snapshot_recovers_with_original_budget_but_never_user_pause(self):
        self.configure(); run=await self.trigger(); self.end(run,'interrupted','service_restarted')
        folder=self.directory/'runs'/run['id']/'evolution'; folder.mkdir(parents=True)
        (folder/'request.json').write_text(json.dumps({'hashes':snapshot(str(self.root))}))
        await self.auto.tick(); self.assertEqual(self.auto.view(str(self.root))['status'],'retrying')
        self.now+=61; await self.auto.tick(); self.assertEqual(self.launched[-1],(run['id'],True))
        saved=self.runner.store.get(run['id']); self.assertEqual(saved['automaticRetries'],1); self.assertEqual(saved['tokenBudget'],5000)
        self.end(saved,'paused','user_stop'); self.now+=1000; await self.auto.tick()
        self.assertEqual(len(self.launched),2); self.assertEqual(self.auto.view(str(self.root))['status'],'paused')

    async def test_drift_and_exhausted_retry_budget_stop_automatic_recovery(self):
        self.configure(); run=await self.trigger(); self.end(run,'interrupted','execution_error')
        folder=self.directory/'runs'/run['id']/'evolution'; folder.mkdir(parents=True)
        (folder/'request.json').write_text(json.dumps({'hashes':snapshot(str(self.root))}))
        (self.root/'workflow.py').write_text('human change')
        await self.auto.tick(); self.now+=61; await self.auto.tick()
        self.assertEqual(self.auto.view(str(self.root))['status'],'blocked'); self.assertEqual(len(self.launched),1)
        run.update(automaticRetries=2); self.runner.store.save(run); self.now+=61; await self.auto.tick()
        self.assertIn('上限',self.auto.view(str(self.root))['message']); self.assertEqual(len(self.launched),1)

    async def test_manual_interruption_is_never_automatically_replayed(self):
        self.configure(); run=await self.trigger(); run.pop('automatic'); self.end(run,'interrupted','service_restarted')
        self.now+=1000; await self.auto.tick(); self.assertEqual(len(self.launched),1)
        self.assertEqual(self.auto.view(str(self.root))['status'],'blocked')

    async def test_lost_scheduler_ack_reuses_durable_run_and_manual_profile_does_not_rerun(self):
        self.configure(); run=await self.trigger(); self.end(run)
        value=self.auto.policy(str(self.root)); value.pop('lastFingerprint'); value.pop('lastStartedAt'); self.runner.store.save_automation(value)
        await self.auto.tick(); self.assertEqual(len(self.launched),1); self.assertEqual(len(self.runner.store.list()),1)
        self.auto.remember(run); await self.auto.tick(); self.assertEqual(len(self.launched),1)


if __name__=='__main__':unittest.main()
