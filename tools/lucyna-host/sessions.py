"""Daemon-owned native OMP processes. Disconnect never means terminate or retry."""
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid

import host_runtime
from protocol import FrameDecoder

MAX_FRAME = 1024*1024
REPLAY_BYTES = 32*1024*1024
REQUESTS = {'get_state', 'get_messages', 'get_messages_page', 'get_available_models',
            'get_available_commands', 'set_ask_dialog', 'abort_and_restore_queue', 'remove_queued_message',
            'get_session_stats', 'get_commands', 'get_last_assistant_text', 'get_session_name',
            'prompt', 'steer', 'follow_up', 'abort', 'set_model', 'set_thinking_level',
            'set_session_name', 'set_steering_mode', 'set_follow_up_mode',
            'extension_ui_response', 'compact'}


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value):
        raise ValueError('invalid_identifier')
    return value


def canonical_path(value, directory=False):
    if not isinstance(value, str) or not value.startswith('/') or any(c in value for c in '\0\r\n'):
        raise ValueError('invalid_path')
    path = Path(value).resolve(strict=True)
    if directory and not path.is_dir():
        raise ValueError('invalid_directory')
    return str(path)


class NativeSession:
    def __init__(self, manager, record, config):
        self.manager, self.record = manager, record
        self.lock = threading.RLock()
        self.terminate_lock = threading.Lock()
        self.internal = {}
        self.ready = threading.Event()
        self.ready_frame = None
        self.questions = {}
        self.frames, self.bytes, self.sequence = deque(), 0, 0
        self.complete_sequence = 0
        self.closed = False
        env = host_runtime.login_env()
        # Explicit isolated agentDir is useful for tests and remote profiles; no desktop credentials.
        if config.get('agentDir'):
            env.update(PI_CODING_AGENT_DIR=config['agentDir'], OMP_PROFILE='')
        env.pop('SSH_AUTH_SOCK', None)
        env.pop('SSH_AGENT_PID', None)
        command = [config['omp'], '--mode', 'rpc-ui', '--cwd', config['root'], '--session-dir', config['sessionDir']]
        if config.get('resume'):
            command.extend(['--resume', config['resume']])
        # The wrapper installs PDEATHSIG outside Python's multi-threaded preexec_fn.
        wrapper = [*host_runtime.launcher(host_runtime.root()), 'exec-omp', '--parent-pid', str(os.getpid()), '--', *command]
        self.process = subprocess.Popen(wrapper, cwd=config['root'], env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        os.set_blocking(self.process.stdin.fileno(), False)
        self.record.update(pid=self.process.pid, processStart=Path('/proc/'+str(self.process.pid)+'/stat').read_text().rsplit(')', 1)[1].split()[19])
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def send(self, frame):
        payload = encode(frame)+b'\n'
        if len(payload) > MAX_FRAME:
            raise ValueError('request_too_large')
        with self.lock:
            if self.closed or self.process.poll() is not None:
                raise ValueError('session_not_live')
            view = memoryview(payload)
            deadline = time.monotonic()+5
            while view:
                remaining = deadline-time.monotonic()
                if remaining <= 0 or not select.select([], [self.process.stdin], [], remaining)[1]:
                    raise ValueError('omp_write_uncertain')
                try:
                    view = view[os.write(self.process.stdin.fileno(), view):]
                except BlockingIOError:
                    continue

    def internal_request(self, kind, **data):
        key = 'host-'+uuid.uuid4().hex
        event, answer = threading.Event(), {}
        with self.lock:
            self.internal[key] = (event, answer)
        try:
            self.send(dict(data, type=kind, id=key))
            deadline, hard_deadline = time.monotonic()+35, time.monotonic()+600
            while not event.wait(.1):
                if self.questions:
                    deadline = min(hard_deadline, time.monotonic()+35)
                if time.monotonic() > deadline:
                    raise ValueError('omp_initialization_timeout')
            if not answer.get('success'):
                raise ValueError('omp_initialization_failed')
            return answer.get('data')
        finally:
            with self.lock:
                self.internal.pop(key, None)

    def initialize(self, config):
        if not self.ready.wait(35) or not self.ready_frame:
            raise ValueError('omp_ready_timeout')
        if 2 in self.ready_frame.get('supportedProtocolVersions', []):
            self.internal_request('negotiate_protocol', protocolVersion=2)
            self.internal_request('set_event_filter', events=None, messageUpdates='delta')
        state = self.internal_request('get_state')
        if not isinstance(state, dict) or not isinstance(state.get('sessionId'), str):
            raise ValueError('omp_identity_missing')
        if config.get('expectedNativeId') and state['sessionId'] != config['expectedNativeId']:
            raise ValueError('omp_resume_identity_mismatch')
        journal = state.get('sessionFile')
        if config.get('resume') and (not journal or str(Path(journal).resolve()) != config['resume']):
            raise ValueError('omp_resume_path_mismatch')
        if self.closed or self.process.poll() is not None:
            raise ValueError('session_not_live')
        self.record.update(nativeSessionId=state['sessionId'], journal=journal, status='live')
        self.manager.persist(self.record)
        self.publish(self.ready_frame)

    def publish(self, frame):
        size = len(encode(frame))
        with self.lock:
            self.sequence += 1
            self.frames.append((self.sequence, frame, size))
            if frame.get('type') != 'rpc_chunk' or frame.get('index') == frame.get('count', 0)-1:
                self.complete_sequence = self.sequence
            self.bytes += size
            while self.bytes > REPLAY_BYTES or len(self.frames) > 16384:
                self.bytes -= self.frames.popleft()[2]

    def events(self, cursor):
        with self.lock:
            floor = self.frames[0][0]-1 if self.frames else self.sequence
            if type(cursor) is not int or cursor < floor or cursor > self.sequence:
                raise ValueError('resync_required')
            frames, size = [], 0
            for seq, frame, count in self.frames:
                if seq <= cursor:
                    continue
                if frames and (size+count > 1536*1024 or len(frames) >= 128):
                    break
                frames.append(dict(sequence=seq, frame=frame))
                size += count
            return dict(frames=frames, cursor=frames[-1]['sequence'] if frames else cursor,
                        latest=self.sequence, status=self.record['status'])

    def read(self):
        decoder = FrameDecoder()
        try:
            while line := self.process.stdout.readline(MAX_FRAME+1):
                if len(line) > MAX_FRAME or not line.endswith(b'\n'):
                    raise ValueError('invalid_omp_frame')
                frame = json.loads(line)
                # Preserve native physical frames, including chunk groups, for client decoding.
                logical = decoder.push(frame)
                with self.lock:
                    internal = self.internal.get(logical.get('id')) if logical else None
                if internal:
                    internal[1].update(logical)
                    internal[0].set()
                    if frame.get('type') != 'rpc_chunk':
                        continue
                if logical is not None and logical.get('type') == 'ready':
                    self.ready_frame = logical
                    self.ready.set()
                    continue
                if logical is not None and logical.get('type') == 'response':
                    key = logical.get('id', '')
                    if isinstance(key, str) and key.startswith('operation-'):
                        self.manager.acknowledge(key[10:], bool(logical.get('success')))
                if logical is not None and logical.get('type') == 'extension_ui_request':
                    with self.lock:
                        if logical.get('method') in ('confirm', 'select', 'input', 'editor', 'ask'):
                            if len(self.questions) >= 64:
                                raise ValueError('question_limit')
                            self.questions[logical['id']] = logical
                            if len(encode(list(self.questions.values()))) > MAX_FRAME:
                                raise ValueError('question_limit')
                        elif logical.get('method') == 'cancel':
                            self.questions.pop(logical.get('targetId'), None)
                self.publish(frame)
        except (OSError, ValueError, TypeError):
            self.record['failure'] = 'omp_transport_failed'
        finally:
            self.ready.set()
            # A malformed/closed stdout cannot leave an unmanaged process alive.
            self.terminate()
            self.record['status'] = 'exited'
            self.questions.clear()
            self.manager.persist(self.record)
            self.manager.uncertain(self.record['id'])
            self.publish(dict(type='host_process_exit', code=self.process.returncode))
            with self.lock:
                for event, answer in self.internal.values():
                    event.set()
            self.process.stdin.close()
            self.process.stdout.close()

    def terminate(self):
        # Never hold the session lock while waiting for a process/reader.
        with self.terminate_lock:
            if self.process.poll() is None:
                try:
                    os.killpg(self.process.pid, signal.SIGTERM)
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=5)
                except ProcessLookupError:
                    pass
            self.closed = True


class SessionManager:
    def __init__(self, state):
        self.state = Path(state)
        self.lock = threading.RLock()
        self.creating = 0
        self.workspace_lock = threading.RLock()
        self.closing = False
        self.creation_done = threading.Condition(self.lock)
        self.live = {}
        # Linux PDEATHSIG follows the thread that forked. Never fork OMP from a
        # short-lived SSH/socket handler: closing that bridge would kill OMP.
        self.owner = ThreadPoolExecutor(max_workers=1, thread_name_prefix='omp-owner')
        db_path = self.state/'sessions.sqlite3'
        if db_path.is_symlink():
            raise ValueError('unsafe_session_database')
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, create_id TEXT UNIQUE, fingerprint TEXT, record TEXT)')
        self.db.execute('CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, session_id TEXT, fingerprint TEXT, status TEXT)')
        for sid, raw in self.db.execute('SELECT id, record FROM sessions').fetchall():
            record = json.loads(raw)
            if record['status'] in ('starting', 'live'):
                record['status'] = 'interrupted'
                self.db.execute('UPDATE sessions SET record=? WHERE id=?', (json.dumps(record), sid))
        self.db.execute("UPDATE operations SET status='uncertain' WHERE status='dispatched'")
        self.db.commit()

    def persist(self, record):
        with self.lock:
            self.db.execute('UPDATE sessions SET record=? WHERE id=?', (json.dumps(record), record['id']))
            self.db.commit()

    def acknowledge(self, operation, success):
        with self.lock:
            self.db.execute('UPDATE operations SET status=? WHERE id=? AND status=?',
                            ('succeeded' if success else 'failed', operation, 'dispatched'))
            self.db.commit()

    def uncertain(self, sid):
        with self.lock:
            self.db.execute("UPDATE operations SET status='uncertain' WHERE session_id=? AND status='dispatched'", (sid,))
            self.db.commit()

    def create(self, args):
        key, client = identifier(args.get('operationId')), identifier(args.get('clientId'))
        fingerprint = hashlib.sha256(encode(args)).hexdigest()
        with self.lock:
            if self.closing:
                raise ValueError('host_stopping')
            row = self.db.execute('SELECT fingerprint, record FROM sessions WHERE create_id=?', (key,)).fetchone()
            if row:
                if row[0] != fingerprint:
                    raise ValueError('operation_conflict')
                return json.loads(row[1])
            records = [json.loads(row[0]) for row in self.db.execute('SELECT record FROM sessions')]
            if sum(row['status'] in ('starting', 'live') for row in records) >= 16 or len(records) >= 1024:
                raise ValueError('session_limit')
            root = canonical_path(args.get('root'), directory=True)
            executable = canonical_path(args.get('omp'))
            if not os.path.isfile(executable) or not os.access(executable, os.X_OK):
                raise ValueError('omp_not_executable')
            sid = uuid.uuid4().hex
            directory = self.state/'journals'/sid
            config = dict(root=root, omp=executable, sessionDir=str(directory))
            if args.get('agentDir'):
                config['agentDir'] = canonical_path(args['agentDir'], directory=True)
            if args.get('resume'):
                resume = canonical_path(args['resume'])
                with open(resume, 'rb') as stream:
                    header = json.loads(stream.readline(65537))
                expected = args.get('expectedNativeId')
                if header.get('type') != 'session' or header.get('id') != expected or not expected or canonical_path(header.get('cwd'), directory=True) != root:
                    raise ValueError('journal_identity_mismatch')
                records = [json.loads(row[0]) for row in self.db.execute('SELECT record FROM sessions')]
                if any(row.get('journal') == resume and row['status'] in ('starting', 'live') for row in records):
                    raise ValueError('journal_in_use')
                config.update(resume=resume, expectedNativeId=expected)
            directory.mkdir(parents=True, mode=0o700)
            record = dict(id=sid, generation=uuid.uuid4().hex, root=root, controller=client,
                          epoch=1, status='starting', pid=None, nativeSessionId=config.get('expectedNativeId'), journal=config.get('resume'))
            self.db.execute('INSERT INTO sessions VALUES (?,?,?,?)', (sid, key, fingerprint, json.dumps(record)))
            self.db.commit()
            self.creating += 1
        try:
            session = self.owner.submit(NativeSession, self, record, config).result()
            with self.lock:
                self.live[sid] = session
            self.persist(record)
            def initialize():
                try:
                    session.initialize(config)
                except (OSError, ValueError):
                    record['failure'] = 'omp_initialization_failed'
                    session.terminate()
            session.initializer = threading.Thread(target=initialize, daemon=True)
            session.initializer.start()
            return dict(record)
        except Exception:
            if sid in self.live:
                self.live[sid].terminate()
            record['status'] = 'interrupted'
            self.persist(record)
            raise ValueError('omp_start_failed') from None
        finally:
            with self.creation_done:
                self.creating -= 1
                self.creation_done.notify_all()

    def get(self, args):
        sid = identifier(args.get('sessionId'))
        session = self.live.get(sid)
        if not session:
            raise ValueError('session_not_live')
        if session.record['generation'] != args.get('generation'):
            raise ValueError('stale_generation')
        return session

    def control(self, session, args):
        if session.record['controller'] != args.get('clientId') or session.record['epoch'] != args.get('epoch'):
            raise ValueError('stale_controller')

    def dispatch(self, operation, args):
        if not isinstance(args, dict):
            raise ValueError('invalid_arguments')
        if operation == 'session.create':
            with self.workspace_lock:
                return self.create(args)
        if operation == 'workspace.inspect':
            root = Path(canonical_path(args.get('root'), directory=True))
            executable = args.get('omp') or shutil.which('omp', path=host_runtime.login_env().get('PATH', ''))
            executable = canonical_path(executable) if executable else None
            if not executable or not os.access(executable, os.X_OK) or not Path(executable).is_file():
                raise ValueError('omp_not_executable')
            agent = canonical_path(args['agentDir'], directory=True) if args.get('agentDir') else None
            document = root/'SESSION.md'
            content = ''
            if document.exists():
                target = document.resolve(strict=True)
                if not target.is_relative_to(root) or not target.is_file():
                    raise ValueError('unsafe_work_document')
                with target.open('rb') as stream:
                    raw = stream.read(512*1024+1)
                if len(raw) > 512*1024:
                    raise ValueError('work_document_too_large')
                content = raw.decode('utf-8', errors='replace')
            return dict(root=str(root), omp=executable, agentDir=agent, document=content)
        with self.lock:
            if self.closing:
                raise ValueError('host_stopping')
            if operation == 'session.list':
                return [json.loads(row[0]) for row in self.db.execute('SELECT record FROM sessions')]
            if operation == 'operation.get':
                row = self.db.execute('SELECT session_id,status FROM operations WHERE id=?', (identifier(args.get('operationId')),)).fetchone()
                return dict(sessionId=row[0], status=row[1]) if row else dict(status='not_found')
            session = self.get(args)
            if operation == 'session.attach':
                client = identifier(args.get('clientId'))
                if client != session.record['controller']:
                    if args.get('takeover') is not True:
                        raise ValueError('controller_busy')
                    session.record.update(controller=client, epoch=session.record['epoch']+1)
                    self.persist(session.record)
                with session.lock:
                    return dict(session.record, questions=list(session.questions.values()), latestCursor=session.complete_sequence)
            if operation == 'session.events':
                return session.events(args.get('cursor'))
            self.control(session, args)
            if operation == 'session.request':
                key = identifier(args.get('operationId'))
                frame = args.get('frame')
                if not isinstance(frame, dict) or frame.get('type') not in REQUESTS:
                    raise ValueError('unsupported_omp_request')
                fingerprint = hashlib.sha256(encode(dict(sessionId=session.record['id'], generation=session.record['generation'], frame=frame))).hexdigest()
                row = self.db.execute('SELECT fingerprint,status FROM operations WHERE id=?', (key,)).fetchone()
                if row:
                    if row[0] != fingerprint:
                        raise ValueError('operation_conflict')
                    return dict(operationId=key, status=row[1], replayed=True)
                if self.db.execute('SELECT COUNT(*) FROM operations').fetchone()[0] >= 100000:
                    raise ValueError('operation_limit')
                is_answer = frame['type'] == 'extension_ui_response'
                if is_answer and frame.get('id') not in session.questions:
                    raise ValueError('question_expired')
                outgoing = dict(frame) if is_answer else dict(frame, id='operation-'+key)
                if len(encode(outgoing))+1 > MAX_FRAME:
                    raise ValueError('request_too_large')
                if session.closed:
                    raise ValueError('session_not_live')
                self.db.execute('INSERT INTO operations VALUES (?,?,?,?)', (key, session.record['id'], fingerprint, 'dispatched'))
                self.db.commit()  # durable before writing; a lost acknowledgement never triggers retry
                try:
                    session.send(outgoing)
                    if is_answer:
                        with session.lock:
                            session.questions.pop(frame['id'], None)
                        session.publish(dict(type='question_resolved', id=frame['id']))
                except (OSError, ValueError):
                    self.uncertain(session.record['id'])
                    session.terminate()
                    raise ValueError('operation_uncertain') from None
                return dict(operationId=key, status='dispatched', replayed=False)
            if operation != 'session.stop':
                raise ValueError('unsupported_operation')
        session.terminate()
        session.reader.join(timeout=10)
        return dict(session.record)

    def close(self):
        with self.creation_done:
            self.closing = True
            self.creation_done.wait_for(lambda: self.creating == 0)
        for session in list(self.live.values()):
            session.terminate()
        for session in list(self.live.values()):
            session.reader.join(timeout=10)
            if hasattr(session, 'initializer'):
                session.initializer.join(timeout=10)
        self.owner.shutdown(wait=True)
        self.db.close()
