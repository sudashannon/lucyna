"""Native process ownership, replay and operation identity regressions."""
import json
import os
from pathlib import Path
import shutil
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path[:0] = [str(ROOT/'tools/lucyna-host'), str(ROOT/'tools/work-runner')]
from sessions import SessionManager
from protocol import FrameDecoder


def wait_for(predicate):
    deadline = time.monotonic()+12
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.03)
    raise AssertionError('Timed out')


class SessionTests(unittest.TestCase):
    def test_task_polling_does_not_fill_write_recovery_table(self):
        before = self.manager.db.execute('SELECT COUNT(*) FROM operations').fetchone()[0]
        for kind in ('get_subagents', 'get_background_tasks', 'get_background_task_output'):
            key = uuid.uuid4().hex
            args = dict(self.identity, operationId=key, frame=dict(type=kind))
            self.manager.dispatch('session.request', args)
            wait_for(lambda: any(item['frame'].get('id') == 'observation-'+key for item in self.manager.dispatch('session.events', dict(self.identity, cursor=0))['frames']))
        self.assertEqual(self.manager.db.execute('SELECT COUNT(*) FROM operations').fetchone()[0], before)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lh-session-')
        self.root = Path(self.tmp.name)
        self.state = self.root/'state'
        self.state.mkdir(mode=0o700)
        self.work = self.root/'work'
        self.work.mkdir()
        self.omp = self.root/'omp'
        shutil.copyfile(ROOT/'test/fixtures/remote-fake-omp.py', self.omp)
        self.omp.chmod(0o700)
        self.manager = SessionManager(self.state)
        self.creation = dict(operationId=uuid.uuid4().hex, clientId='desktop', root=str(self.work), omp=str(self.omp))
        self.record = self.manager.create(self.creation)
        self.session = self.manager.live[self.record['id']]
        wait_for(lambda: self.session.record['status'] == 'live')
        self.identity = dict(sessionId=self.record['id'], generation=self.record['generation'], clientId='desktop', epoch=1)

    def tearDown(self):
        self.manager.close()
        self.tmp.cleanup()

    def request(self, operation, frame):
        return self.manager.dispatch('session.request', dict(self.identity, operationId=operation, frame=frame))

    def test_repeated_create_and_lost_ack_do_not_duplicate_process_or_prompt(self):
        self.assertEqual(self.manager.create(self.creation)['pid'], self.session.process.pid)
        first = self.request('prompt-once', dict(type='prompt', message='only once'))
        wait_for(lambda: self.manager.dispatch('operation.get', dict(operationId='prompt-once'))['status'] == 'succeeded')
        repeated = self.request('prompt-once', dict(type='prompt', message='only once'))
        self.assertTrue(repeated['replayed'])
        self.assertEqual((self.work/'prompts.txt').read_text(), 'only once\n')
        with self.assertRaisesRegex(ValueError, 'operation_conflict'):
            self.request('prompt-once', dict(type='prompt', message='different'))

    def test_subagent_cancellation_uses_durable_native_operation_identity(self):
        self.request('list-children', dict(type='get_subagents'))
        wait_for(lambda: any(item['frame'].get('id') == 'observation-list-children' for item in self.manager.dispatch('session.events', dict(self.identity, cursor=0))['frames']))
        self.request('cancel-child-once', dict(type='cancel_subagent', subagentId='fixture-child'))
        wait_for(lambda: self.manager.dispatch('operation.get', dict(operationId='cancel-child-once'))['status'] == 'succeeded')
        repeated = self.request('cancel-child-once', dict(type='cancel_subagent', subagentId='fixture-child'))
        self.assertTrue(repeated['replayed'])
        self.assertEqual((self.work/'cancellations.txt').read_text(), 'fixture-child\n')

    def test_workspace_inspection_and_document_cannot_cross_symlink_boundary(self):
        (self.work/'SESSION.md').write_text('# remote work')
        args = dict(root=str(self.work), omp=str(self.omp))
        result = self.manager.dispatch('workspace.inspect', args)
        self.assertEqual(result['document'], '# remote work')
        self.assertEqual(result['omp'], str(self.omp))
        (self.work/'SESSION.md').unlink()
        (self.root/'outside.md').write_text('outside')
        (self.work/'SESSION.md').symlink_to(self.root/'outside.md')
        with self.assertRaisesRegex(ValueError, 'unsafe_work_document'):
            self.manager.dispatch('workspace.inspect', args)

    def test_transient_connection_thread_does_not_own_omp_lifetime(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=1) as connection:
            record = connection.submit(self.manager.create, dict(self.creation, operationId='transient')).result(timeout=15)
        session = self.manager.live[record['id']]
        wait_for(lambda: session.record['status'] == 'live')
        time.sleep(.2)
        self.assertIsNone(session.process.poll())

    def test_replay_keeps_native_chunks_and_offline_questions(self):
        self.request('large', dict(type='get_messages'))
        wait_for(lambda: self.manager.dispatch('operation.get', dict(operationId='large'))['status'] == 'succeeded')
        cursor, decoder, large = 0, FrameDecoder(), None
        while cursor < self.session.sequence:
            page = self.manager.dispatch('session.events', dict(self.identity, cursor=cursor))
            for item in page['frames']:
                frame = decoder.push(item['frame'])
                if frame and frame.get('id') == 'operation-large':
                    large = frame
            cursor = page['cursor']
        self.assertEqual(len(large['data']['messages'][0]), 1200*1024)
        self.request('question', dict(type='prompt', message='question'))
        wait_for(lambda: self.session.questions)
        attached = self.manager.dispatch('session.attach', self.identity)
        self.assertEqual(attached['questions'][0]['id'], 'question-one')
        self.request('answer', dict(type='extension_ui_response', id='question-one', value='yes'))
        wait_for(lambda: (self.work/'answer.txt').exists())
        self.assertEqual((self.work/'answer.txt').read_text(), 'question-one:yes')

    def test_takeover_rejects_old_controller_and_generation(self):
        next_owner = self.manager.dispatch('session.attach', dict(self.identity, clientId='second', takeover=True))
        self.assertEqual(next_owner['epoch'], 2)
        with self.assertRaisesRegex(ValueError, 'stale_controller'):
            self.request('stale', dict(type='prompt', message='no'))
        with self.assertRaisesRegex(ValueError, 'stale_generation'):
            self.manager.dispatch('session.events', dict(self.identity, generation='old', cursor=0))

    def test_expired_cursor_requires_resync(self):
        import sessions
        original = sessions.REPLAY_BYTES
        sessions.REPLAY_BYTES = 40
        try:
            for i in range(10):
                self.session.publish(dict(type='event', text='x'*30))
            with self.assertRaisesRegex(ValueError, 'resync_required'):
                self.session.events(0)
        finally:
            sessions.REPLAY_BYTES = original

    def test_journal_resume_matches_native_id(self):
        before = dict(self.session.record)
        self.manager.dispatch('session.stop', self.identity)
        resumed = self.manager.create(dict(self.creation, operationId='resume', resume=before['journal'], expectedNativeId=before['nativeSessionId']))
        replacement = self.manager.live[resumed['id']]
        wait_for(lambda: replacement.record['status'] == 'live')
        self.assertEqual(replacement.record['nativeSessionId'], before['nativeSessionId'])
        self.assertNotEqual(replacement.record['generation'], before['generation'])

    def test_daemon_restart_records_interruption_without_restarting_omp(self):
        with self.manager.lock:
            record = dict(self.session.record, status='live')
            self.manager.persist(record)
            self.manager.db.execute('INSERT INTO operations VALUES (?,?,?,?)', ('lost', record['id'], 'hash', 'dispatched'))
            self.manager.db.commit()
        # A separate database copy models persisted state at abrupt daemon death.
        snapshot = self.root/'snapshot'
        snapshot.mkdir()
        import sqlite3
        with sqlite3.connect(snapshot/'sessions.sqlite3') as target:
            self.manager.db.backup(target)
        recovered = SessionManager(snapshot)
        try:
            self.assertEqual(recovered.dispatch('session.list', {})[0]['status'], 'interrupted')
            self.assertEqual(recovered.dispatch('operation.get', dict(operationId='lost'))['status'], 'uncertain')
            self.assertEqual(recovered.live, {})
        finally:
            recovered.close()

    def test_sigkill_owner_terminates_omp_and_restart_does_not_replay(self):
        state = self.root/'killed-state'
        state.mkdir(mode=0o700)
        script = '''
import json, signal, sys, time
sys.dont_write_bytecode = True
sys.path[:0] = sys.argv[1:3]
from sessions import SessionManager
manager = SessionManager(sys.argv[3])
record = manager.create(json.loads(sys.argv[4]))
session = manager.live[record['id']]
deadline = time.monotonic()+10
while session.record['status'] != 'live':
    if time.monotonic() > deadline: raise RuntimeError('not ready')
    time.sleep(.02)
with manager.lock:
    manager.db.execute('INSERT INTO operations VALUES (?,?,?,?)', ('lost-at-crash', record['id'], 'hash', 'dispatched'))
    manager.db.commit()
print(json.dumps(session.record), flush=True)
signal.pause()
'''
        process = subprocess.Popen([sys.executable, '-I', '-c', script,
                                    str(ROOT/'tools/lucyna-host'), str(ROOT/'tools/work-runner'),
                                    str(state), json.dumps(self.creation)], stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        record = None
        try:
            self.assertTrue(select.select([process.stdout], [], [], 12)[0])
            record = json.loads(process.stdout.readline())
            process.kill()
            process.wait(timeout=5)
            def stopped():
                path = Path('/proc')/str(record['pid'])/'stat'
                try:
                    fields = path.read_text().rsplit(')', 1)[1].split()
                except FileNotFoundError:
                    return True
                return fields[0] == 'Z' or fields[19] != record['processStart']
            wait_for(stopped)
            recovered = SessionManager(state)
            try:
                self.assertEqual(recovered.dispatch('session.list', {})[0]['status'], 'interrupted')
                self.assertEqual(recovered.dispatch('operation.get', dict(operationId='lost-at-crash'))['status'], 'uncertain')
                self.assertFalse(recovered.live)
            finally:
                recovered.close()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            if record and not stopped():
                os.killpg(record['pid'], signal.SIGKILL)


if __name__ == '__main__':
    os.umask(0o077)
    unittest.main()
