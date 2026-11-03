"""Work-local evaluation preparation. Reads originals; executes only disposable copies."""
import asyncio
import fnmatch
import hashlib
from itertools import islice
import json
import os
import posixpath
from pathlib import Path
import re
import tempfile

from capabilities import snapshot
from local_agent import iterate
from work import bounded_file, digest, file_tool, local_path, private_name, tool, verify

PREFIX = '__lucyna_eval__/'
PREP_TOKENS = None  # No cumulative token cap; usage is still recorded.
PREP_SECONDS = 1800


def document_snapshot(root, extra=()):
    names = ['SESSION.md']+list(extra)
    notes = local_path(root, 'notes', directory=True)
    if notes.is_dir():
        documents=[p.relative_to(root).as_posix() for p in sorted(notes.glob('*.md')) if not p.is_symlink()]
        if len(documents)>80: raise ValueError('notes 文档超过 80 份，请缩小文档范围')
        names += documents
    hashes, size = {}, 0
    for name in sorted(set(names)):
        path = local_path(root, name)
        # Removed optional notes invalidate the old profile instead of permanently
        # blocking regeneration with a missing-file error. SESSION.md is required.
        if name != 'SESSION.md' and not path.exists():
            continue
        data = bounded_file(path, 512*1024)
        size += len(data)
        if size > 2*1024*1024:
            raise ValueError('Work 文档超过 2 MiB，请缩小 notes 文档范围')
        hashes[name] = digest(data)
    return hashes


def fingerprint(hashes):
    return hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()


def folder_for(directory, root, key):
    if not isinstance(key, str) or not re.fullmatch('[a-f0-9]{32}', key):
        raise ValueError('无效自动评测版本')
    return Path(directory)/'preparations'/digest(root.encode())/key


def read_prepared(directory, root, value):
    folder = folder_for(directory, root, value.get('prepared'))
    record = json.loads(bounded_file(folder/'compiled.json', 2*1024*1024))
    if record['root'] != root:
        raise ValueError('自动评测不属于此 Work')
    expected = record['profile']['evolution']
    if value != expected:
        raise ValueError('自动评测范围已冻结；请重新准备，或切换为手动配置')
    spec = record['spec']
    for name, content in spec['generated'].items():
        if not name.startswith(PREFIX) or digest(content.encode()) != spec['frozen'][name]:
            raise ValueError('自动评测文件已变化，请重新准备')
    # Recheck every selected original path; unrelated links and artifacts are never traversed.
    snapshot(root, spec['inputs'])
    for name, sha in spec['frozen'].items():
        if name not in spec['generated'] and digest(bounded_file(local_path(root, name))) != sha:
            raise ValueError('引用的检查文件已变化：'+name+'；请重新准备')
    return spec


CHECK = {'type':'object','properties':{'argv':{'type':'array','minItems':1,'maxItems':64,'items':{'type':'string'}},'cwd':{'type':'string'},'files':{'type':'array','minItems':1,'maxItems':30,'items':{'type':'string'}}},'required':['argv','cwd','files'],'additionalProperties':False}
CONTROL_CONTENT = {'anyOf':[{'type':'string'}, {'type':'object','properties':{'find':{'type':'string','minLength':1},'replace':{'type':'string'}},'required':['find','replace'],'additionalProperties':False}], 'description':'Full replacement content, or one exact unique text replacement against the original target. Prefer find/replace for a small control change in a large file.'}
PLAN = {
    'objective':{'type':'string'}, 'acceptance':{'type':'string'},
    'targets':{'type':'array','minItems':1,'maxItems':10,'items':{'type':'string'}}, 'inputs':{'type':'array','minItems':1,'maxItems':5000,'items':{'type':'string'}},
    'training':CHECK, 'validation':CHECK,
    'generated':{'type':'object','minProperties':1,'maxProperties':30,'additionalProperties':{'type':'string'}},
    'evidence':{'type':'array','minItems':2,'maxItems':12,'items':{'type':'object','properties':{'purpose':{'type':'string','enum':['objective','acceptance']},'path':{'type':'string'},'quote':{'type':'string','minLength':8,'maxLength':1200}},'required':['purpose','path','quote'],'additionalProperties':False}},
    'controls':{'type':'array','maxItems':4,'description':'Use [] for a draft baseline trial before constructing controls. A publishable plan needs 2–4 controls: at least one correct implementation (pass) and one incorrect implementation (fail).','items':{'type':'object','properties':{'label':{'type':'string'},'expected':{'type':'string','enum':['pass','fail']},'files':{'type':'object','minProperties':1,'maxProperties':10,'additionalProperties':CONTROL_CONTENT}},'required':['label','expected','files'],'additionalProperties':False}},
}
PREP_TOOLS = [
    tool('list_work_files','Locate relevant source or tests. Prefer exact directories from notes; pattern matches basenames (e.g. *timeline*). recursive=true searches at most 8 levels/5000 entries. Returns at most 60 matches, with file sizes. Do not browse the entire repo level by level.',
         {'path':{'type':'string'},'pattern':{'type':'string','maxLength':120},'recursive':{'type':'boolean'}},[]),
    tool('read_work_file','Read a relevant Work file (default 32000 characters for uncapped preparation). Use nextOffset only for larger files; avoid rereading unchanged files or inventorying all notes.',
         {'path':{'type':'string'},'offset':{'type':'integer','minimum':0},'limit':{'type':'integer','minimum':1,'maximum':32000}},['path']),
    tool('submit_work_evaluation','Trial an evaluation in a disposable offline copy. First submit all plan fields with controls=[] to probe the baseline. After a successful draft, submit ONLY controls to finalize the cached plan, or submit every field to replace the plan. All checks rerun before publication. No original files are changed.',PLAN,['controls']),
    tool('report_work_blocker','Record the precise missing business requirement, offline dependency or source evidence preventing a meaningful evaluation.',{'message':{'type':'string'}},['message']),
]


def original_path(root, name, directory=False):
    if not isinstance(name, str) or name.startswith((PREFIX, '.agent-tmp/')) or name == '.agent-tmp':
        raise ValueError('此路径不属于自动评测的 Work 输入')
    return local_path(root, name, directory=directory)


def list_sources(root, args):
    path=original_path(root,args.get('path') or '.',directory=True)
    pattern=args.get('pattern') or '*';recursive=args.get('recursive')
    if recursive is None:recursive=False
    if not isinstance(pattern,str) or len(pattern)>120 or type(recursive) is not bool:
        raise ValueError('无效文件查找条件')
    pending=[(path,0)];entries=[];visited=0;truncated=False
    while pending:
        folder,depth=pending.pop()
        for item in sorted(islice(folder.iterdir() if folder.is_dir() else [folder],5001-visited)):
            visited+=1
            if visited>5000: return {'entries':entries,'truncated':True}
            if item.is_symlink() or private_name(item.name) or item.name in ('.agent-tmp','__lucyna_eval__','node_modules','__pycache__'):
                continue
            name=item.relative_to(root).as_posix();original_path(root,name)
            directory=item.is_dir()
            if recursive and directory and depth<8: pending.append((item,depth+1))
            elif recursive and directory:truncated=True
            if not fnmatch.fnmatchcase(item.name,pattern):continue
            entry={'path':name,'directory':directory}
            if not directory:
                if not item.is_file() or item.stat().st_nlink!=1:continue
                entry.update(bytes=item.stat().st_size,readable=item.stat().st_size<=1024*1024)
            if len(entries)>=60:return {'entries':entries,'truncated':True}
            entries.append(entry)
    return {'entries':entries,'truncated':truncated}


async def validate_plan(root, plan, reads):
    from evolution import specification, evaluation_score
    from runner import text
    if not isinstance(plan,dict):raise ValueError('评测计划须为对象')
    if set(plan)!=set(PLAN):
        missing=[k for k in PLAN if k not in plan]
        extra=[str(k)[:80] for k in plan if k not in PLAN]
        raise ValueError('完整评测计划字段无效'+('；缺少：'+','.join(missing) if missing else '')+('；未定义字段：'+','.join(extra[:12]) if extra else '')+'。已有成功草稿时可仅提交 controls。')
    if len(json.dumps(plan))>750000:raise ValueError('完整评测计划超过 750000 字符')
    objective, acceptance = text(plan['objective'],'目标'), text(plan['acceptance'],'验收标准',8000)
    evidence = plan['evidence']
    if not isinstance(evidence,list) or not 2 <= len(evidence) <= 12:
        raise ValueError('须引用目标与验收标准的 Markdown 原文')
    for item in evidence:
        if not isinstance(item,dict) or set(item) != {'purpose','path','quote'}:
            raise ValueError('无效评测依据')
        name, quote = item['path'], item['quote']
        if not isinstance(name,str) or name not in reads or not name.endswith('.md') or not isinstance(quote,str) or not 8 <= len(quote) <= 1200:
            raise ValueError('评测依据必须引用已经读取的 Markdown 原文')
        data = bounded_file(original_path(root,name))
        if digest(data) != reads[name] or quote not in data.decode('utf-8'):
            raise ValueError('引用原文不存在或已经变化：'+name)
    if any(e['purpose'] not in ('objective','acceptance') for e in evidence) or {e['purpose'] for e in evidence} != {'objective','acceptance'}:
        raise ValueError('缺少目标或验收标准依据')
    targets, inputs, generated, controls = (plan[k] for k in ('targets','inputs','generated','controls'))
    if not isinstance(targets,list) or not 1 <= len(targets) <= 10 or any(not isinstance(t,str) or t not in reads for t in targets):
        raise ValueError('先读取 1–10 个实际优化文件')
    if not isinstance(inputs,list) or not 1 <= len(inputs) <= 5000 or any(not isinstance(n,str) for n in inputs):
        raise ValueError('须列出实际输入文件及依赖')
    inputs = sorted(set(inputs+targets+list(reads)+['SESSION.md']+(['work.json'] if (Path(root)/'work.json').is_file() else [])))
    for name in inputs:
        original_path(root,name)
    hashes = snapshot(root,inputs)
    if any(hashes[name] != sha for name,sha in reads.items()):
        raise ValueError('准备期间 Work 内容变化，请重新读取')
    if not isinstance(generated,dict) or not 1 <= len(generated) <= 30:
        raise ValueError('须提供 1–30 个生成的评测文件')
    for name, content in generated.items():
        if not name.startswith(PREFIX) or not isinstance(content,str) or len(content.encode()) > 256*1024:
            raise ValueError('评测文件只能写入 '+PREFIX)
        local_path(root,name)
    if sum(len(c.encode()) for c in generated.values()) > 512*1024:
        raise ValueError('生成评测文件超过 512 KiB')
    if not isinstance(controls,list) or len(controls) not in (0,2,3,4):
        raise ValueError('controls=[] 可仅试跑基线；发布配置须提供 2–4 个正反对照')
    for index,control in enumerate(controls):
        if not isinstance(control,dict) or set(control)!={'label','expected','files'}:
            raise ValueError(f'controls[{index}] 必须只包含 label、expected、files；files 为目标路径到完整内容或精确 find/replace 的对象')
        if control['expected'] not in ('pass','fail'):
            raise ValueError(f'controls[{index}].expected 必须为 pass 或 fail')
    if controls and {c['expected'] for c in controls} != {'pass','fail'}:
        raise ValueError('controls 必须同时包含 expected=pass 与 expected=fail 的正反对照')
    with tempfile.TemporaryDirectory(prefix='lucyna-eval-') as temp:
        copy = Path(temp)
        for name in inputs:
            data = bounded_file(original_path(root,name),100*1024*1024)
            if digest(data) != hashes[name]: raise ValueError('快照期间文件变化：'+name)
            dest=copy/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
        for name,content in generated.items():
            dest=local_path(copy,name);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(content)
        spec = specification({'targets':targets,'iterations':2,'training':plan['training'],'validation':plan['validation']},str(copy))
        if set(generated) - set(spec['frozen']):
            raise ValueError('所有生成文件都须列入冻结检查文件')
        # The same generic test driver may take genuinely different cases via
        # argv. Renaming identical scripts alone must not count as a holdout.
        def case_command(split):
            frozen=spec['trainFrozen' if split=='training' else 'validationFrozen']
            normalized=[]
            for arg in spec[split]['argv']:
                name=posixpath.normpath(arg[6:] if arg.startswith('/work/') else posixpath.join(spec[split].get('cwd','.'),arg))
                normalized.append(('file',frozen[name]) if name in frozen else ('arg',arg))
            return normalized
        if set(spec['trainFrozen'].values()) == set(spec['validationFrozen'].values()) and case_command('training')==case_command('validation'):
            raise ValueError('训练与留出检查内容相同，需要不同的行为用例')
        for name in targets:
            if name.startswith(PREFIX): raise ValueError('评测文件不能成为优化对象')
        # Hold-out checks cannot be copied into the visible training input closure.
        check_outputs={}
        async def scores():
            result={}
            for split in ('training','validation'):
                run={'root':str(copy),'frozen':spec['frozen'],'hidden':list(spec['validationFrozen']) if split=='training' else [],'verificationSpec':spec[split]}
                checked=await verify(run)
                check_outputs[split]={'exitCode':checked['exitCode'],'output':checked['output'][-6000:]}
                try:result[split]=evaluation_score(checked)
                except ValueError as exc:
                    raise ValueError(split+'：'+str(exc)+'\n检查输出：\n'+checked['output'][-2000:]) from None
            return result
        baseline=await scores()
        if baseline != await scores(): raise ValueError('基线评分不稳定，不能自动比较')
        if baseline['training']<1 and baseline['validation']==1:
            raise ValueError('训练已发现失败，但留出检查全部通过；当前优化器按留出改善选优，这份评测不能验证已观察缺陷的改善。两组须覆盖同一验收行为，使用不同边界输入；不要把不同功能分到不同组，也不要复制用例、篡改预期或降低标准。两组基线均通过的回归评测仍有效。')
        if not controls:return {'draft':True,'baseline':baseline,'checks':dict(check_outputs)}
        originals={name:(copy/name).read_bytes() for name in targets}
        control_results=[]
        for control in controls:
            text(control.get('label'),'对照说明',500)
            changes=control.get('files')
            if not isinstance(changes,dict) or not changes or set(changes)-set(targets):
                raise ValueError('对照样例只能替换选定优化文件')
            for name,content in changes.items():
                if isinstance(content,dict):
                    if set(content)!={'find','replace'} or not isinstance(content['find'],str) or not content['find'] or not isinstance(content['replace'],str):
                        raise ValueError('对照编辑须为非空 find 与 replace 字符串')
                    original=originals[name].decode('utf-8')
                    if original.count(content['find'])!=1:
                        raise ValueError('对照编辑须唯一匹配原始目标内容：'+name)
                    content=original.replace(content['find'],content['replace'],1)
                if not isinstance(content,str) or len(content.encode())>256*1024: raise ValueError('对照样例过大')
                (copy/name).write_text(content)
            scored=await scores()
            failed=next((split for split,score in scored.items() if (score != 1 if control['expected']=='pass' else score>=1)),None)
            if failed:
                raise ValueError('评测未识别对照样例：'+control['label']+' '+json.dumps(scored)+'\n'+failed+' 输出：\n'+check_outputs[failed]['output'][-2000:])
            control_results.append({'label':control['label'],'expected':control['expected'],'scores':scored})
            for name,data in originals.items(): (copy/name).write_bytes(data)
    if snapshot(root,inputs) != hashes: raise ValueError('评测试跑期间 Work 已变化，请重新准备')
    spec.update(inputs=inputs,generated=generated)
    profile={'objective':objective,'acceptance':acceptance,'model':'','tokenBudget':None,'wallSeconds':1800,
             'evolution':{k:spec[k] for k in ('targets','inputs','iterations','training','validation')}}
    return {'root':root,'profile':profile,'spec':spec,'evidence':evidence,'baseline':baseline,'controls':control_results,'sourceHashes':hashes}


async def prepare(automatic, root, key):
    runner=automatic.runner
    reads={}; result=None; blocker=None; used=0; draft_plan=None
    def progress(state, message, **extra):
        value=automatic.policy(root)
        if value.get('preparation',{}).get('id') != key or not value['enabled']:
            raise asyncio.CancelledError()
        value['preparation'].update(state=state,message=message,**extra)
        automatic.status(value,'preparing',message)
    async def host(name,args):
        nonlocal result,blocker,draft_plan
        if not isinstance(args,dict): raise ValueError('无效准备工具参数')
        if result is not None or blocker is not None: raise ValueError('本次评测准备已结束')
        if name=='list_work_files':
            return await asyncio.to_thread(list_sources,root,args)
        if name=='read_work_file':
            path=args.get('path','.')
            original_path(root,path)
            limit=args.get('limit')
            maximum=32000 if record['tokenBudget'] is None else 6000
            if limit is None:limit=maximum if record['tokenBudget'] is None else 3000
            if type(limit) is not int or not 1<=limit<=maximum:
                raise ValueError(f'读取页大小须为 1–{maximum} 个字符')
            value=file_tool({'root':root},name,args)
            if len(value['content'])>limit:
                value['content']=value['content'][:limit]
                value['nextOffset']=args.get('offset',0)+limit
            if len(reads)>=100 and path not in reads: raise ValueError('读取文件数量达到上限，请缩小任务')
            reads[path]=value['sha256'];progress('reading','正在读取 '+path,sources=list(reads))
            return value
        if name=='report_work_blocker':
            from runner import text
            blocker=text(args.get('message'),'待补充信息',2000)
            return {'recorded':True}
        if name=='submit_work_evaluation':
            plan=args
            if set(args)=={'controls'}:
                if draft_plan is None:raise ValueError('尚无成功草稿；请先提交完整计划与 controls=[]，试跑后可仅追加 controls')
                plan={**draft_plan,'controls':args['controls']}
            progress('checking','正在试跑基线及正反对照检查')
            try:
                trial=await validate_plan(root,plan,reads)
            except (ValueError,OSError,UnicodeError) as exc:
                progress('reading','评测未通过试跑，agent 正在调整：'+str(exc)[:500])
                raise
            if trial.get('draft'):
                draft_plan=json.loads(json.dumps(plan))
                from evolution import atomic_json
                folder=folder_for(runner.directory,root,key);folder.mkdir(parents=True,exist_ok=True)
                atomic_json(folder/'draft.json',{'root':root,'plan':draft_plan,'reads':reads,'baseline':trial['baseline']})
                targets=[]
                for name in plan['targets']:
                    source=bounded_file(original_path(root,name)).decode('utf-8')
                    targets.append({'path':name,'sha256':reads[name],'content':source[:32000],'nextOffset':32000 if len(source)>32000 else None})
                handoff={'plan':draft_plan,'originalTargets':targets,'baseline':trial['baseline'],'checks':trial['checks']}
                progress('reading','基线试跑完成，正在补齐正反对照',draftBaseline=trial['baseline'])
                return {'ready':False,'draft':True,'baseline':trial['baseline'],'checks':trial['checks'],'handoff':handoff,'next':'Draft cached privately. Now submit ONLY {controls:[positive,negative]} to finalize this same plan, or all fields to replace it. Publication still reruns every check; original Work is unchanged.'}
            result=trial
            return {'ready':True,'baseline':result['baseline'],'controls':result['controls']}
        raise ValueError('评测准备工具未开放')
    def usage(event):
        nonlocal used
        used=max(used,event['usedTokens'])
        history=automatic.policy(root).get('preparation',{}).get('steps',[])
        history=(history+[{'tools':event.get('tools',[]),'errors':event.get('errors',[]),'finishReason':event.get('finishReason'),'inputTokens':event.get('inputTokens'),'outputTokens':event.get('outputTokens'),'usedTokens':used}])[-64:]
        progress('reading','内嵌 agent 正在准备评测',usedTokens=used,steps=history)
    record=automatic.policy(root)['preparation']
    complete=False
    try:
        programs={name:os.access('/usr/bin/'+name,os.X_OK) for name in ('python3','bash','gcc','g++','clang','node','cmake','ninja','bazel')}
        response=await asyncio.wait_for(iterate(runner.require_auxiliary(),{'mode':'prepare','work':Path(root).name,'tokenBudget':record['tokenBudget'],'clarification':record.get('clarification',''),'checkedPrograms':programs},host,usage,tools=PREP_TOOLS),PREP_SECONDS)
        used=max(used,response['usedTokens']);complete=True
        value=automatic.policy(root)
        if not value['enabled'] or value['preparation']['id']!=key: return
        if document_snapshot(root,record['documents'])!=record['documents']:
            raise ValueError('准备期间 Work 文档已更新，请重新准备')
        if result is None:
            value['preparation'].update(state='needs_input',message=blocker or '缺少可运行的评测依据',usedTokens=used)
            automatic.status(value,'needs_input',value['preparation']['message']);return
        if snapshot(root,result['spec']['inputs'])!=result['sourceHashes']:
            raise ValueError('准备期间 Work 文件已变化，请重新准备')
        result['profile']['evolution']['prepared']=key
        result['documents']={**record['documents'],**{name:sha for name,sha in result['sourceHashes'].items() if name.endswith('.md')}}
        from evolution import atomic_json
        folder=folder_for(runner.directory,root,key);folder.mkdir(parents=True,exist_ok=True)
        atomic_json(folder/'compiled.json',result)
        value.update(profile=result['profile'],profileOrigin='agent',profileDocuments=result['documents'],observedFingerprint=None,lastFingerprint=None,idleSince=automatic.clock())
        value['preparation'].update(state='ready',message='评测已通过基线与正反对照试跑',usedTokens=used,evidence=result['evidence'],baseline=result['baseline'],controls=result['controls'])
        automatic.status(value,'stabilizing','评测已准备好，Work 空闲且稳定后自动开始比较。')
    except asyncio.CancelledError:
        value=automatic.policy(root)
        if value.get('preparation',{}).get('id')==key:
            value['preparation'].update(state='paused',message='评测准备已暂停；已有记录保留')
            runner.store.save_automation(value)
        raise
    except Exception as exc:
        value=automatic.policy(root)
        if value.get('preparation',{}).get('id')==key:
            message='评测准备达到运行时限，已停止；尚未发布配置。可查看已有记录后重试。' if isinstance(exc,asyncio.TimeoutError) else str(exc)[:1500]
            value['preparation'].update(state='failed',message=message,errorType=type(exc).__name__)
            automatic.status(value,'preparation_failed','评测准备未完成：'+message)
    finally:
        value=automatic.policy(root)
        charge=used if complete else max(used,record['tokenBudget'] or 0)
        for attempt in value.get('preparationAttempts',[]):
            if attempt['id']==key: attempt.update(usedTokens=charge,finishedAt=automatic.clock(),estimated=not complete)
        if value.get('preparation',{}).get('id')==key:
            value['preparation'].update(usedTokens=charge,usageEstimated=not complete)
        runner.store.save_automation(value)
