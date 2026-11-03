"""Exercise the compiled native RPC without a model request or user workspace."""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'work-runner'))
from protocol import FrameDecoder

with tempfile.TemporaryDirectory(prefix='lucyna-omp-tasks-') as directory:
    env = dict(os.environ, PI_CODING_AGENT_DIR=directory+'/agent', OMP_PROFILE='')
    process = subprocess.Popen([sys.argv[1], '--mode', 'rpc-ui', '--cwd', directory], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, bufsize=0)
    decoder = FrameDecoder()
    pending = b''
    def receive(predicate):
        global pending
        end = time.monotonic()+30
        while time.monotonic() < end:
            if b'\n' not in pending:
                if not select.select([process.stdout], [], [], .2)[0]:
                    continue
                data = os.read(process.stdout.fileno(), 65536)
                if not data:
                    raise AssertionError('Native exited before response')
                pending += data
                continue
            line, pending = pending.split(b'\n', 1)
            frame = decoder.push(json.loads(line))
            if frame and predicate(frame):
                return frame
        raise AssertionError('Native RPC deadline exceeded')
    def request(command, **data):
        process.stdin.write((json.dumps(dict(id=command, type=command, **data))+'\n').encode())
        process.stdin.flush()
        return receive(lambda f: f.get('type') == 'response' and f.get('id') == command)
    try:
        receive(lambda f: f.get('type') == 'ready')
        assert request('negotiate_protocol', protocolVersion=2)['success']
        assert request('set_subagent_subscription', level='progress')['success']
        result = request('get_background_tasks')
        assert result['success'] and result['data']['tasks'] == [], result
        assert request('get_subagents')['data']['subagents'] == []
        invalid = request('cancel_background_task', taskId='not-owned', kind='job', startedAt=1)
        assert invalid['success'] is False
        assert request('get_state')['success'], 'Cancellation error blocked subsequent RPC'
        print('PASS compiled RPC capability, empty snapshot, ownership rejection and continued responsiveness')
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
