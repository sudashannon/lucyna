"""Host-owned experiment specification, worker lifecycle, promotion and rollback."""
import asyncio
import json
import math
import os
from pathlib import Path
import shutil
import signal
import time

from capabilities import snapshot, change
from work import bounded_file, digest, local_path, verification_spec, file_tool
from evo_runtime import python as worker_python, REVISION


def evaluation_score(result):
    try:
        record=json.loads(result['output'].strip().splitlines()[-1])
        if 'score' in record:
            value=float(record['score'])
        else:
            passed,total=record['passed'],record['total']
            if type(passed) is not int or type(total) is not int or total<1 or not 0<=passed<=total:
                raise ValueError()
            value=passed/total
        if not math.isfinite(value) or not 0<=value<=1 or result['exitCode'] not in (0,1) or (value==1 and result['exitCode']!=0):
            raise ValueError()
        return value
    except (ValueError,TypeError,KeyError,IndexError):
        raise ValueError('评分器须在最后一行输出有效 score（0–1）或 passed/total，且退出码与结果一致') from None


def atomic_json(path, value):
    temporary=path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value,stream,ensure_ascii=False)
        stream.flush();os.fsync(stream.fileno())
    temporary.replace(path)


def specification(value, root):
    if not isinstance(value,dict) or set(value)-{'targets','training','validation','iterations'}:
        raise ValueError('无效进化实验配置')
    targets=value.get('targets')
    iterations=value.get('iterations',2)
    if not isinstance(targets,list) or not 1<=len(targets)<=10 or len(set(targets))!=len(targets):
        raise ValueError('请选择 1–10 个不同的 Work 局部优化文件')
    if type(iterations) is not int or not 1<=iterations<=5:
        raise ValueError('候选轮数须为 1–5')
    train,train_hash=verification_spec(value.get('training'),root)
    val,val_hash=verification_spec(value.get('validation'),root)
    if not train or not val or set(train_hash)&set(val_hash) or train['argv']==val['argv']:
        raise ValueError('须提供独立的训练检查和留出检查，冻结文件不能重叠')
    for name in targets:
        if name in ('SESSION.md','work.json') or name.startswith('SESSION-') or name in train_hash or name in val_hash:
            raise ValueError('优化对象不能是 Work 状态、会话日志或评分器')
        bounded_file(local_path(root,name),256*1024).decode('utf-8')
    return {'targets':targets,'iterations':iterations,'training':train,'validation':val,
        'trainFrozen':train_hash,'validationFrozen':val_hash,'frozen':{**train_hash,**val_hash}}


async def run_worker(runner, key):
    run=runner.store.get(key)
    folder=runner.directory/'runs'/key/'evolution'
    folder.mkdir(parents=True,exist_ok=True)
    request_file=folder/'request.json'
    if not request_file.exists():
        hashes=await asyncio.to_thread(snapshot,run['root'])
        initial=folder/'initial';initial.mkdir(exist_ok=True)
        for name in hashes:
            target=initial/name;target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(local_path(run['root'],name),target)
        if snapshot(str(initial))!=hashes or snapshot(run['root'])!=hashes:
            raise ValueError('快照期间 Work 发生变化，请重新创建实验')
        atomic_json(request_file,{'root':run['root'],'objective':run['objective'],'acceptance':run['acceptance'],
            'spec':run['evolutionSpec'],'hashes':hashes,'model':run['model'],'tokenBudget':run['tokenBudget'],
            'omp':runner.config['omp'],'agentDir':runner.config['agentDir'],'helper':runner.config['helper']})
    run.update(state='running',phase='baseline')
    runner.save(run,'evolution_started','AntOmniEvo 已启动，使用隔离候选副本')
    from runner import child_setup, identity
    process=await asyncio.create_subprocess_exec(worker_python(),str(Path(__file__).with_name('evo_worker.py')),str(folder),
        stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,env=await runner.environment(),start_new_session=True,preexec_fn=child_setup,limit=4*1024*1024)
    runner.workers[key]=process
    run['process']=identity(process.pid);runner.store.save(run)
    try:
        while line:=await process.stdout.readline():
            event=json.loads(line)
            if event.get('type')!='evolution':
                continue
            run=runner.store.get(key)
            run.update(evolution=event['data'],phase=event['data'].get('phase','evaluating'),usedTokens=event['data'].get('usedTokens',0))
            if event['data'].get('model'):
                run['effectiveModel']=event['data']['model']
            runner.save(run,'evolution',event.get('message','候选状态更新'))
        await process.wait()
        if process.returncode:
            error_file=folder/'error.json'
            detail=json.loads(error_file.read_text()).get('error','') if error_file.exists() else ''
            raise ValueError('进化实验中断，候选与记录保留。'+detail[:1200])
        result=json.loads((folder/'result.json').read_text())
        run=runner.store.get(key)
        run.update(evolution=result,phase='review',state='waiting_review' if result.get('eligible') else 'completed',
            reason='candidate_ready' if result.get('eligible') else 'no_improvement',usedTokens=result.get('usedTokens',0),
            result='候选已通过留出检查，可查看差异后采纳。' if result.get('eligible') else '本轮未找到通过采纳条件的改进，原 Work 未修改。')
        runner.save(run,run['state'],run['result'])
    finally:
        runner.workers.pop(key,None)
        if process.returncode is None:
            os.killpg(process.pid,signal.SIGKILL)
            await process.wait()


def promote(runner, run, rollback=False):
    if run.get('mode')!='evolution':
        raise ValueError('此任务不是进化实验')
    folder=runner.directory/'runs'/run['id']/'evolution'
    request=json.loads((folder/'request.json').read_text())
    result=json.loads((folder/'result.json').read_text())
    transaction=folder/'promotion.json'
    if rollback:
        if not transaction.exists():
            raise ValueError('没有可回退的采纳记录')
        promotion=json.loads(transaction.read_text())
        if promotion.get('state')=='rolled_back':
            run.update(state='completed',reason='rolled_back',phase='rolled_back')
            run['result']='已回退本次采纳，Work 文件恢复为采纳前版本；候选和评估记录保留。'
            run['evolution']['promotion']='rolled_back';runner.store.save(run)
            return run
        if promotion.get('state') not in ('applied','rolling_back'):
            raise ValueError('采纳尚未完成，请先继续采纳以核对文件')
    else:
        if transaction.exists():
            promotion=json.loads(transaction.read_text())
            if promotion.get('state')=='applied':
                run.update(state='completed',reason='applied',phase='applied')
                run['result']='最佳候选已采纳到 Work；原快照保留，可校验后回退。'
                run['evolution']['promotion']='applied';runner.store.save(run)
                return run
            if promotion.get('state')!='applying':
                raise ValueError('此候选已回退，重新采纳请创建新实验')
        else:
            if run['state']!='waiting_review' or not result.get('eligible'):
                raise ValueError('尚无可采纳候选')
            if snapshot(run['root'])!=request['hashes']:
                raise ValueError('Work 已变化，未覆盖当前修改；请重新评估')
            promotion={'state':'applying','candidateId':result['bestCandidate'],'files':result['changes']}
            atomic_json(transaction,promotion)
    # Artifact location is recorded by the trusted worker, not chosen by the model/UI.
    candidate=Path(result['bestArtifact'])
    if not candidate.resolve().is_relative_to(folder.resolve()):
        raise ValueError('候选路径异常')
    if not rollback:
        current_snapshot=snapshot(run['root'])
        changed={item['path'] for item in promotion['files']}
        if {k:v for k,v in current_snapshot.items() if k not in changed}!={k:v for k,v in request['hashes'].items() if k not in changed}:
            raise ValueError('Work 依赖已变化，未继续采纳')
    for item in promotion['files']:
        path=local_path(run['root'],item['path'])
        current=digest(bounded_file(path))
        allowed=(item['afterSha'],item['beforeSha']) if not rollback or promotion.get('state')=='rolling_back' else (item['afterSha'],)
        if current not in allowed:
            raise ValueError('文件已被其他操作修改，未覆盖：'+item['path'])
        source=(folder/'initial' if rollback else candidate)/item['path']
        if digest(bounded_file(source))!=(item['beforeSha'] if rollback else item['afterSha']):
            raise ValueError('已评估候选或回退快照发生变化，未写入 Work')
    if rollback:
        promotion['state']='rolling_back';atomic_json(transaction,promotion)
    # Each write is atomic. Intent is durable before the first write; retries reconcile hashes.
    for item in promotion['files']:
        path=item['path'];source=(folder/'initial' if rollback else candidate)/path
        current=digest(bounded_file(local_path(run['root'],path)))
        file_tool(dict(run,privateLog='SESSION-evolution.md'),'write_work_file',{'path':path,'content':bounded_file(source).decode('utf-8'),'expectedSha256':current})
    promotion['state']='rolled_back' if rollback else 'applied'
    atomic_json(transaction,promotion)
    run.update(state='completed',reason=promotion['state'],phase=promotion['state'])
    run['result']='已回退本次采纳，Work 文件恢复为采纳前版本；候选和评估记录保留。' if rollback else '最佳候选已采纳到 Work；原快照保留，可校验后回退。'
    run['evolution'].update(promotion=promotion['state'])
    runner.save(run,promotion['state'],'已回退本次采纳的文件' if rollback else '已采纳候选；原文件快照保留，可按哈希校验回退')
    return run
