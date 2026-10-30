"""Real AntOmniEvo Optimizer adapter. Runs only in the pinned optional venv."""
import asyncio
import json
import os
from pathlib import Path
import sys
import time

from antomnievo.interface.system import System
from antomnievo.interface.evaluator import Evaluator
from antomnievo.interface.proposer import Proposer
from antomnievo.interface.data_inst import DataInst
from antomnievo.model.antomnievo_data import ProposalResult
from antomnievo.model.evaluation_result import EvaluationResult
from antomnievo.model.system_result import SystemResult
from antomnievo.model.rollout_result import RolloutResult
from antomnievo.model.trajectory import Trajectory
from antomnievo.model.usage_stats import UsageStats
from antomnievo.model.budget import Budget
from antomnievo.evolution_algorithm.pareto_frontier import ParetoFrontierEvolutionAlgorithm
from antomnievo.store.candidate_store import LocalCandidateStore
from antomnievo.optimizer.optimizer import Optimizer

from work import bounded_file, digest, verify
from capabilities import change
from evolution import atomic_json, evaluation_score as score
from evo_runtime import REVISION
from local_agent import iterate, work_tool


class Context:
    def __init__(self,folder,agent):
        self.agent=agent
        self.folder=folder
        self.request=json.loads((folder/'request.json').read_text())
        self.spec=self.request['spec']
        self.store=LocalCandidateStore(str(folder/'optimizer'),cleanup_unavailable=False)
        progress=folder/'progress.json'
        self.data=json.loads(progress.read_text()) if progress.exists() else {'framework':'AntOmniEvo','revision':REVISION,'candidates':[], 'usedTokens':0,'history':[]}
        pending=self.data.pop('activeProposal',None)
        if pending:
            # The last request may have consumed tokens before its final usage event.
            # Charge its reserved cap conservatively, instead of resetting the budget.
            self.data['usedTokens']=max(self.data['usedTokens'],pending['base']+pending['budget'])
            self.data['usageEstimated']=True
            for row in self.data['candidates']:
                if row['id']==pending['id']:
                    row.update(state='failed',error='生成过程被中断，未完成候选未采纳；该次预留预算按上限计入。')
        self.data['phase']='baseline'
        self.data['agent']='auxiliary'
        self.optimizer=None

    def row(self,key):
        found=next((c for c in self.data['candidates'] if c['id']==key),None)
        if not found:
            meta=self.store.get_meta(key)
            found={'id':key,'generation':meta.generation,'state':'evaluating','training':None,'validation':None,'changes':[]}
            self.data['candidates'].append(found)
        return found

    def publish(self,message):
        if self.optimizer:
            self.data['iteration']=self.optimizer.statistics.current_iteration
        self.data['iterations']=self.spec['iterations']
        self.data['updatedAt']=time.time()
        atomic_json(self.folder/'progress.json',self.data)
        print(json.dumps({'type':'evolution','message':message,'data':self.data},ensure_ascii=False),flush=True)

    def run(self,directory,split):
        return {'root':directory,'privateLog':'SESSION-evolution.md','frozen':self.spec['frozen'],
            'hidden':list(self.spec['validationFrozen']) if split=='training' else [],
            'verificationSpec':self.spec[split]}


class WorkSystem(System):
    def __init__(self,context):
        super().__init__(concurrency=1);self.context=context

    async def _run(self,meta,item):
        ctx=self.context
        ctx.data['phase']='baseline' if meta.generation==0 else 'evaluating'
        result=await verify(ctx.run(meta.artifact_dir,item.id))
        value=score(result)
        row=ctx.row(meta.candidate_id)
        row[item.id]=value
        row[item.id+'Output']=result['output'][:6000]
        row[item.id+'ExitCode']=result['exitCode']
        ctx.publish(('基线' if meta.generation==0 else '候选')+' · '+('训练检查' if item.id=='training' else '留出检查')+f' {value:.0%}')
        return SystemResult(trajectory=Trajectory(),output=RolloutResult(content=json.dumps({'score':value,'output':result['output']})))


class WorkEvaluator(Evaluator):
    def scoring_criteria(self):
        return 'Frozen checks emit a normalized score or passed/total. Only independent validation selects the final candidate.'

    async def _evaluate(self,item,result):
        record=json.loads(result.output.content)
        return EvaluationResult(data_id=item.id,metric_name='fixed_check',score=record['score'],reason=record['output'][:6000])


class LocalAgentProposer(Proposer):
    def __init__(self,context):
        self.context=context

    async def analyze(self,*args):
        return ProposalResult(success=True)

    async def reflect(self,*args):
        return ProposalResult(success=False,error_message='Reflection chain is disabled for this bounded experiment')

    async def propose(self,parent_id,new_id):
        ctx=self.context;meta=ctx.store.get_meta(new_id);row=ctx.row(new_id)
        parent=ctx.row(parent_id)
        if ctx.data.get('proposalAttempts',0)>=ctx.spec['iterations']:
            row.update(state='failed',error='已达到候选尝试次数上限')
            ctx.publish('候选尝试次数已用完')
            return ProposalResult(success=False,error_message='Proposal attempt budget exhausted')
        remaining=ctx.request['tokenBudget']-ctx.data['usedTokens']
        if remaining<1000:
            return ProposalResult(success=False,error_message='Token budget exhausted')
        limit=max(1000,remaining//max(1,ctx.spec['iterations']-sum(c['generation']>0 for c in ctx.data['candidates'])+1))
        ctx.data['proposalAttempts']=ctx.data.get('proposalAttempts',0)+1
        ctx.data['activeProposal']={'id':new_id,'budget':limit,'base':ctx.data['usedTokens']}
        ctx.data['phase']='proposing';row['state']='proposing';ctx.publish('本地 agent 正在迭代 Work')
        used=0;complete=False;base=ctx.data['usedTokens']
        run=ctx.run(meta.artifact_dir,'training')
        agent={**ctx.agent,'config':dict(ctx.agent['config'])}
        if ctx.request['model']:
            agent['config']['model']=ctx.request['model']
        ctx.data['agent']='auxiliary'
        ctx.data['model']={'id':agent['config']['model'],'name':agent['config']['model'],'provider':'auxiliary'}
        async def tool(name,arguments):
            try:
                value=await work_tool(run,ctx.spec,name,arguments)
            except (ValueError,OSError,UnicodeError) as exc:
                row['lastTool']=name;ctx.publish('本地 agent 工具失败 · '+str(name)+' · '+str(exc)[:500])
                raise
            row['lastTool']=name;ctx.publish('本地 agent 工具 · '+str(name))
            return value
        def usage(event):
            nonlocal used
            used=max(used,event['usedTokens'])
            ctx.data['usedTokens']=base+used;ctx.publish('本地 agent 用量已更新')
        try:
            result=await iterate(agent,{'objective':ctx.request['objective'],'acceptance':ctx.request['acceptance'],
                'targets':ctx.spec['targets'],'tokenBudget':limit,
                'training':{'score':parent.get('training'),'output':parent.get('trainingOutput','')}},tool,usage)
            used=max(used,result['usedTokens']);complete=True
            row['summary']=result.get('text','')
            row['state']='proposed'
            row['changes']=[change(path,bounded_file(ctx.folder/'initial'/path),bounded_file(Path(meta.artifact_dir)/path)) for path in ctx.spec['targets']
                if digest(bounded_file(ctx.folder/'initial'/path))!=digest(bounded_file(Path(meta.artifact_dir)/path))]
            ctx.publish('候选修改已生成，进入独立评估')
            return ProposalResult(success=bool(row['changes']),stats=UsageStats(input_tokens=used))
        except Exception as exc:
            row.update(state='failed',error=str(exc)[:1000]);ctx.publish('候选未完成，保留证据')
            return ProposalResult(success=False,error_message=str(exc)[:1000],stats=UsageStats(input_tokens=used))
        finally:
            # Failed/incomplete calls reserve the cap; SIGKILL is reconciled on restart.
            ctx.data.pop('activeProposal',None)
            ctx.data['usedTokens']=base+(used if complete else max(used,limit))
            if not complete:ctx.data['usageEstimated']=True
            ctx.publish('候选调用结束，预算已记录')


async def main(folder,agent):
    ctx=Context(folder,agent)
    # If the worker completed before the service lost its completion event, replay only its report.
    if (folder/'result.json').exists():
        ctx.data=json.loads((folder/'result.json').read_text());ctx.publish('恢复已完成的实验结果');return
    optimizer=Optimizer(system=WorkSystem(ctx),proposer=LocalAgentProposer(ctx),evaluator=WorkEvaluator(),
        evolution_algorithm=ParetoFrontierEvolutionAlgorithm(ctx.store),candidate_store=ctx.store,
        train_dataset=[DataInst(id='training',query=ctx.request['objective'],golden_answer='frozen training checks')],
        val_dataset=[DataInst(id='validation',query='Independent held-out checks',golden_answer='frozen held-out checks')],
        batch_size=1,budget=Budget(max_iterations=ctx.spec['iterations'],max_system_runs=2+ctx.spec['iterations']*3,max_tokens=ctx.request['tokenBudget']),
        num_proposals=1,initial_artifacts_dir=str(folder/'initial'))
    ctx.optimizer=optimizer
    await optimizer.optimize()
    statistics=optimizer.statistics
    baseline=ctx.row(statistics.root_candidate_id)
    best=ctx.row(statistics.best_candidate_id)
    for row in ctx.data['candidates']:
        if row.get('state')!='failed':
            row['state']=ctx.store.get_meta(row['id']).state
    eligible=(best['id']!=baseline['id'] and best.get('validation') is not None and
        best['validation']>baseline.get('validation',0)+1e-8 and best['validation']>=1 and bool(best.get('changes')))
    ctx.data.update(phase='review',baseline=baseline.get('validation'),bestScore=best.get('validation'),bestCandidate=best['id'],
        bestArtifact=ctx.store.get_meta(best['id']).artifact_dir,eligible=eligible,changes=best.get('changes',[]),
        history=list(statistics.avg_score_history),promotion='pending' if eligible else 'unchanged')
    atomic_json(folder/'result.json',ctx.data)
    ctx.publish('实验完成：候选可采纳' if eligible else '实验完成：保留原方案')


if __name__=='__main__':
    folder=Path(sys.argv[1]);os.umask(0o077)
    try:
        asyncio.run(main(folder,json.loads(sys.stdin.buffer.readline(65536))))
    except BaseException as exc:
        atomic_json(folder/'error.json',{'error':str(exc)[:1200]})
        raise
