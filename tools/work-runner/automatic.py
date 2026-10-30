"""Persistent, bounded Work experiments. Only the user may promote a candidate."""
import asyncio
import hashlib
import json
from pathlib import Path
import time

from capabilities import snapshot
from evolution import specification
from storage import TERMINAL

PROFILE_FIELDS = ('objective', 'acceptance', 'model', 'tokenBudget', 'wallSeconds', 'evolution')
LABELS = {
    'waiting_agent': '等待本地 agent 就绪',
    'needs_profile': '等待评测配置', 'disabled': '自动进化已关闭', 'waiting_idle': '等待 Work 空闲',
    'unknown_client': '等待客户端确认状态', 'stabilizing': '等待文件稳定', 'unchanged': '等待新的 Work 变化',
    'cooldown': '冷却中', 'daily_limit': '今日自动实验次数已达上限', 'running': '自动实验进行中',
    'review': '候选待你采纳', 'paused': '任务已暂停', 'blocked': '自动实验需要处理',
    'retrying': '等待自动恢复', 'installing': '正在准备进化环境', 'waiting_task': '等待当前后台任务结束',
}


class Automatic:
    def __init__(self, runner, clock=time.time, idle_seconds=60, cooldown=1800, daily_limit=2):
        self.runner, self.store, self.clock = runner, runner.store, clock
        self.idle_seconds, self.cooldown, self.daily_limit = idle_seconds, cooldown, daily_limit

    def policy(self, root):
        rows = self.store.automation(root)
        if rows:
            return rows[0]
        value = {'root': root, 'enabled': True, 'profile': None, 'status': 'needs_profile',
                 'message': '需要一次性指定优化文件、训练与留出检查；已有实验配置会自动复用。',
                 'createdAt': self.clock(), 'lastFingerprint': None, 'idleSince': self.clock()}
        for run in self.store.list(root):
            if run.get('mode') == 'evolution' and run.get('request', {}).get('evolution'):
                value['profile'] = {k: run['request'].get(k) for k in PROFILE_FIELDS}
                value['sourceRunId'] = run['id']
                break
        self.store.save_automation(value)
        return value

    def status(self, value, state, message='', **extra):
        value.update(status=state, message=message, **extra)
        self.store.save_automation(value)
        return value

    def view(self, root):
        value = dict(self.policy(root))
        value.update(label=LABELS.get(value['status'], value['status']), idleSeconds=self.idle_seconds,
                     cooldownSeconds=self.cooldown, dailyLimit=self.daily_limit, adoption='manual')
        value['runsToday'] = sum(bool(r.get('automatic')) and r['createdAt'] > self.clock()-86400 for r in self.store.list(root))
        return value

    def check_root(self, root):
        base = Path(self.runner.config['workRoot']).resolve()
        if not isinstance(root, str) or len(root) > 4096:
            raise ValueError('无效 Work 根')
        path = Path(root)
        if path.parent != base or str(path.resolve()) != root or path.is_symlink() or not (path/'SESSION.md').is_file():
            raise ValueError('自动进化只能使用登记的 Work')

    async def sync(self, request):
        if 'auxiliary' in request:
            self.runner.configure_auxiliary(request['auxiliary'])
        client = request.get('clientId')
        roots = request.get('works')
        if not isinstance(client, str) or not 1 <= len(client) <= 100 or not isinstance(roots, list) or len(roots) > 500:
            raise ValueError('无效客户端状态')
        states = []
        for item in roots:
            if not isinstance(item, dict) or set(item) != {'root', 'busy', 'connected'} or type(item['busy']) is not bool or type(item['connected']) is not bool:
                raise ValueError('无效 Work 活动状态')
            self.check_root(item['root'])
            states.append(item)
            self.policy(item['root'])
        if len({item['root'] for item in states}) != len(states):
            raise ValueError('重复 Work')
        self.store.save_client({'id': client, 'seen': self.clock(), 'works': states})
        return {'registered': len(states)}

    def configure(self, request):
        root = request['root']; self.check_root(root)
        value = self.policy(root)
        if 'enabled' in request:
            if type(request['enabled']) is not bool:
                raise ValueError('无效自动进化开关')
            value['enabled'] = request['enabled']
        if 'profile' in request:
            profile = request['profile']
            if not isinstance(profile, dict) or set(profile) != set(PROFILE_FIELDS):
                raise ValueError('无效自动实验配置')
            from runner import text
            text(profile.get('objective'), '目标'); text(profile.get('acceptance'), '验收标准', 8000)
            budget, wall, model = profile.get('tokenBudget'), profile.get('wallSeconds'), profile.get('model')
            if type(budget) is not int or not 1000 <= budget <= 200000 or type(wall) is not int or not 60 <= wall <= 43200:
                raise ValueError('无效自动实验预算')
            if not isinstance(model, str) or len(model) > 200 or any(c in model for c in '\0\r\n'):
                raise ValueError('无效模型')
            specification(profile.get('evolution'), root)
            value.update(profile=profile, observedFingerprint=None, idleSince=self.clock(), lastFingerprint=None)
        state = 'stabilizing' if value['enabled'] and value['profile'] else 'needs_profile' if value['enabled'] else 'disabled'
        active = next((run for run in self.store.list(root) if run['state'] not in TERMINAL), None)
        if value['enabled'] and active:
            state = 'review' if active['state'] == 'waiting_review' else 'paused' if active['state'] == 'paused' else 'running' if active.get('automatic') else 'waiting_task'
            value['lastRunId'] = active['id']
        self.status(value, state, '结果由你确认采纳；不会自动覆盖 Work。' if state == 'review' else '空闲并检测到新变化后自动运行；结果由你确认采纳。')
        return self.view(root)

    def remember(self, run):
        value = self.policy(run['root'])
        value.update(profile={k: run['request'].get(k) for k in PROFILE_FIELDS}, sourceRunId=run['id'])
        try:
            value['lastFingerprint'] = self.fingerprint(value)
        except (OSError, ValueError):
            pass  # Run execution reports unsupported snapshots with its own evidence.
        self.store.save_automation(value)

    def fingerprint(self, value):
        return hashlib.sha256(json.dumps({'files': snapshot(value['root']), 'profile': value['profile']}, sort_keys=True).encode()).hexdigest()

    def activity(self, root):
        for client in self.store.clients():
            item = next((r for r in client['works'] if r['root'] == root), None)
            if not item or not item['connected']:
                continue
            if self.clock()-client['seen'] > 45:
                return 'unknown_client'
            if item['busy']:
                return 'waiting_idle'
        return None

    async def tick(self):
        for value in self.store.automation():
            try:
                async with self.runner.admission:
                    await self.advance(self.policy(value['root']))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.status(self.policy(value['root']), 'blocked', str(exc)[:1000], retryAt=self.clock()+60)

    async def advance(self, value):
        now, root = self.clock(), value['root']
        if not value['enabled']:
            self.status(value, 'disabled'); return
        if not value['profile']:
            self.status(value, 'needs_profile', '先配置一次优化对象与独立检查；之后自动复用，不用逐次启动。'); return
        if value.get('retryAt', 0) > now:
            return
        runs = self.store.list(root)
        active = next((r for r in runs if r['state'] not in TERMINAL), None)
        if active:
            value['lastRunId'] = active['id']
            if active.get('automatic') and active['state'] == 'interrupted' and active.get('reason') in ('service_restarted', 'service_stopping', 'execution_error'):
                if not self.runner.auxiliary:
                    self.status(value, 'waiting_agent', '请打开 Lucyna 同步辅助模型配置；不会创建额外的 OMP 会话。'); return
                activity = self.activity(root)
                if activity:
                    self.status(value, activity, '等待普通会话空闲后恢复隔离实验。', idleSince=now); return
                retries = active.get('automaticRetries', 0)
                if retries >= 2 or (active.get('usedTokens') or 0) >= active['tokenBudget'] or active['elapsedSeconds'] >= active['wallSeconds']:
                    self.status(value, 'blocked', '自动恢复次数或原预算已到上限，请查看结果。'); return
                retry_at = active.get('automaticRetryAt')
                if retry_at is None:
                    active['automaticRetryAt'] = now+60*(retries+1); self.store.save(active)
                    retry_at = active['automaticRetryAt']
                self.status(value, 'retrying', '在原预算内恢复隔离实验，不重放普通 Work 工具。', nextAt=retry_at)
                if retry_at > now or active['id'] in self.runner.tasks:
                    return
                from runner import still_alive
                if still_alive(active.get('process')):
                    raise ValueError('旧实验进程仍存活，等待释放')
                await self.runner.validate(active)
                request_file = self.runner.directory/'runs'/active['id']/'evolution/request.json'
                if request_file.exists() and snapshot(root) != json.loads(request_file.read_text())['hashes']:
                    raise ValueError('Work 已变化，不能自动恢复旧快照；请查看或取消该实验')
                active.update(state='queued', automaticRetries=retries+1, reason='')
                active.pop('automaticRetryAt', None)
                self.runner.save(active, 'auto_resumed', '自动恢复隔离实验，沿用原预算与候选记录')
                self.runner.launch(active['id'], resume=True)
                return
            state = 'review' if active['state'] == 'waiting_review' else 'paused' if active['state'] == 'paused' else 'blocked' if active['state'] == 'interrupted' else 'running' if active.get('automatic') else 'waiting_task'
            self.status(value, state, '结果由你确认采纳；不会自动覆盖 Work。'); return
        if any(self.store.get(key)['root'] == root for key in self.runner.tasks):
            return
        activity = self.activity(root)
        if activity:
            self.status(value, activity, '普通会话结束本轮执行后再开始；不会中断你的会话。', idleSince=now); return
        self.check_root(root)
        fingerprint = await asyncio.to_thread(self.fingerprint, value)
        if fingerprint == value.get('lastFingerprint'):
            self.status(value, 'unchanged', '当前文件版本已评估，不会重复消耗预算。'); return
        if fingerprint != value.get('observedFingerprint'):
            self.status(value, 'stabilizing', f'发现新的 Work 变化，持续空闲 {self.idle_seconds} 秒后自动比较。', observedFingerprint=fingerprint, idleSince=now); return
        due = max(value.get('idleSince', now)+self.idle_seconds, value.get('lastStartedAt', 0)+self.cooldown)
        recent = [r for r in runs if r.get('automatic') and r['createdAt'] > now-86400]
        if len(recent) >= self.daily_limit:
            self.status(value, 'daily_limit', f'每个 Work 在滚动 24 小时内最多自动运行 {self.daily_limit} 次。', nextAt=min(r['createdAt'] for r in recent)+86400); return
        if due > now:
            self.status(value, 'stabilizing' if now < value.get('idleSince', now)+self.idle_seconds else 'cooldown', '已保存触发意图，满足空闲与冷却条件后开始。', nextAt=due); return
        if any(self.store.get(key).get('automatic') for key in self.runner.tasks):
            self.status(value, 'waiting_task', '另一个 Work 的自动实验正在运行，随后继续。'); return
        if not self.runner.auxiliary:
            self.status(value, 'waiting_agent', '请在 Lucyna 设置中配置辅助模型；自动运行和比较，采纳由你确认。'); return
        specification(value['profile']['evolution'], root)
        from evo_runtime import python, install
        try:
            python()
        except ValueError:
            # Installation is handled outside admission so foreground RPCs stay responsive.
            self.status(value, 'installing', '正在安装独立 AntOmniEvo 环境，完成后自动运行。')
            if not getattr(self, 'install_task', None):
                self.install_task = asyncio.create_task(asyncio.to_thread(install))
            if not self.install_task.done():
                return
            task, self.install_task = self.install_task, None
            task.result(); return
        key = 'auto:'+hashlib.sha256((root+'\n'+fingerprint).encode()).hexdigest()
        request = dict(value['profile'], root=root, requestKey=key, mode='evolution', verification=None)
        run = await self.runner.create(request, automatic={'fingerprint': fingerprint, 'trigger': 'work_changed_idle'})
        self.status(value, 'running', 'Work 有新变化且已空闲，自动实验已启动。', lastFingerprint=fingerprint,
                    lastStartedAt=now, lastRunId=run['id'], nextAt=None)

    async def loop(self):
        while True:
            await self.tick()
            await asyncio.sleep(10)
