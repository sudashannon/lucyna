"""Boundaries and recovery for Work capabilities and experiment promotion."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools/work-runner'))
from capabilities import command, skill_tool, search, snapshot, change, knowledge
from evolution import specification, promote, atomic_json, evaluation_score
from work import digest, verify
from storage import Store
from runner import Runner


class Evolution(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name);self.root=self.base/'work';self.root.mkdir()
        for name,content in {'SESSION.md':'# Work\n状态: active\n','work.json':'{"version":1,"members":[]}',
            'workflow.py':'VALUE = 1\n','train.py':'print(1)','holdout.py':'print(2)'}.items():(self.root/name).write_text(content)
        self.raw={'targets':['workflow.py'],'training':{'argv':['/usr/bin/python3','train.py'],'files':['train.py']},
            'validation':{'argv':['/usr/bin/python3','holdout.py'],'files':['holdout.py']},'iterations':2}
        self.spec=specification(self.raw,str(self.root))
        self.run={'root':str(self.root),'frozen':self.spec['frozen'],'privateLog':'SESSION-own.md'}

    def test_frozen_split_and_target_contract(self):
        with self.assertRaises(ValueError):specification(dict(self.raw,targets=['holdout.py']),str(self.root))
        with self.assertRaises(ValueError):specification(dict(self.raw,validation=self.raw['training']),str(self.root))
        with self.assertRaises(ValueError):specification(dict(self.raw,iterations=100),str(self.root))
        with self.assertRaises(ValueError):specification(dict(self.raw,targets=['../escape']),str(self.root))

    def test_scores_reject_invalid_or_contradictory_outputs(self):
        self.assertEqual(evaluation_score({'output':'log\n{"passed":3,"total":4}','exitCode':1}),.75)
        for output,code in [('not JSON',0),('{"score":1}',1),('{"score":0.5}',2),('{"score":NaN}',0),('{"passed":5,"total":4}',0)]:
            with self.subTest(output=output),self.assertRaises(ValueError):evaluation_score({'output':output,'exitCode':code})

    def test_training_process_cannot_read_holdout_file(self):
        script='from pathlib import Path\ntry:\n assert Path("holdout.py").read_text()==""\nexcept PermissionError:pass\nprint("held-out input hidden")'
        run=dict(self.run,hidden=['holdout.py'],verificationSpec={'argv':['/usr/bin/python3','-c',script],'cwd':'.'})
        result=asyncio.run(verify(run));self.assertTrue(result['passed'],result)

    def test_command_writes_only_work_and_protects_metadata(self):
        (self.root/'.env').write_text('private')
        script='from pathlib import Path\nassert not Path("/home").exists()\nPath("output.txt").write_text("made")\nfor p in ["SESSION.md","work.json","train.py"]:\n try:Path(p).write_text("bad")\n except OSError:pass\n else:raise AssertionError(p)\nprint("sandbox ok")'
        result=asyncio.run(command(self.run,{'argv':['/usr/bin/python3','-c',script]}))
        self.assertEqual(result['exitCode'],0,result);self.assertEqual((self.root/'output.txt').read_text(),'made')
        self.assertIn('active',(self.root/'SESSION.md').read_text())
        with self.assertRaises(ValueError):asyncio.run(command(self.run,{'argv':['/home/user/bin/tool']}))

    def test_shared_skill_read_and_search(self):
        skills=self.base/'skills';(skills/'example/scripts').mkdir(parents=True)
        (skills/'example/SKILL.md').write_text('# Example\nUse a deterministic check.')
        config={'helper':str(skills/'example/scripts/helper.py'),'agentDir':str(self.base/'agent')}
        self.assertEqual(skill_tool(config,'list_work_skills',{})['skills'][0]['name'],'example')
        self.assertIn('deterministic',skill_tool(config,'read_work_skill',{'skill':'example'})['content'])
        with self.assertRaises(ValueError):skill_tool(config,'read_work_skill',{'skill':'example','path':'../../../outside'})
        with self.assertRaises(ValueError):knowledge({'name':'wiki_claim_upsert'})
        self.assertEqual(search(self.run,{'query':'VALUE'})['matches'][0]['path'],'workflow.py')

    def promotion_fixture(self):
        directory=self.base/'state';folder=directory/'runs/run/evolution';(folder/'initial').mkdir(parents=True)
        (folder/'initial/workflow.py').write_text('VALUE = 1\n')
        candidate=folder/'candidate';candidate.mkdir();(candidate/'workflow.py').write_text('VALUE = 2\n')
        delta=change('workflow.py',b'VALUE = 1\n',b'VALUE = 2\n')
        result={'eligible':True,'bestCandidate':'candidate','bestArtifact':str(candidate),'changes':[delta]}
        atomic_json(folder/'request.json',{'hashes':snapshot(str(self.root))})
        atomic_json(folder/'result.json',result)
        run=dict(self.run,id='run',requestKey='key',state='waiting_review',mode='evolution',evolution=result)
        store=Store(directory/'runs.sqlite3');store.save(run,new=True)
        runner=SimpleNamespace(directory=directory,store=store,save=lambda r,k,m:store.save(r,{'type':k,'message':m}))
        return runner,run,folder

    def test_adopt_rollback_and_external_drift(self):
        runner,run,folder=self.promotion_fixture()
        (self.root/'workflow.py').write_text('external')
        with self.assertRaisesRegex(ValueError,'变化'):promote(runner,run)
        (self.root/'workflow.py').write_text('VALUE = 1\n')
        promote(runner,run);self.assertEqual((self.root/'workflow.py').read_text(),'VALUE = 2\n')
        (self.root/'workflow.py').write_text('new human change')
        with self.assertRaisesRegex(ValueError,'其他操作'):promote(runner,run,True)
        (self.root/'workflow.py').write_text('VALUE = 2\n')
        promote(runner,run,True);self.assertEqual((self.root/'workflow.py').read_text(),'VALUE = 1\n')

    def test_partial_promotion_reconciles_without_clobber(self):
        runner,run,folder=self.promotion_fixture()
        result=json.loads((folder/'result.json').read_text())
        atomic_json(folder/'promotion.json',{'state':'applying','candidateId':'candidate','files':result['changes']})
        (self.root/'workflow.py').write_text('VALUE = 2\n')
        promote(runner,run)
        self.assertEqual(json.loads((folder/'promotion.json').read_text())['state'],'applied')
        self.assertEqual(run['state'],'completed')

    def test_modified_candidate_is_not_promoted(self):
        runner,run,folder=self.promotion_fixture()
        (folder/'candidate/workflow.py').write_text('tampered')
        with self.assertRaisesRegex(ValueError,'快照发生变化'):promote(runner,run)
        self.assertEqual((self.root/'workflow.py').read_text(),'VALUE = 1\n')

    def test_dispatch_routes_adopt_and_rollback(self):
        runner,run,_=self.promotion_fixture()
        runner.admission=asyncio.Lock();runner.tasks={}
        async def validate(_):pass
        runner.validate=validate
        result=asyncio.run(Runner.dispatch(runner,{'op':'adopt','runId':'run'}))
        self.assertEqual(result['reason'],'applied')
        result=asyncio.run(Runner.dispatch(runner,{'op':'rollback','runId':'run'}))
        self.assertEqual(result['reason'],'rolled_back')


if __name__=='__main__':unittest.main()
