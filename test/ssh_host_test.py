"""Linux-only isolated installer/protocol tests; no user service or model calls."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tools/lucyna-host'))
import artifacts

SOURCE = Path(__file__).resolve().parents[1]/'tools/lucyna-host'
spec = importlib.util.spec_from_file_location('host_install', SOURCE/'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def bundle():
    files = {}
    for name in ('host.py', 'install.py', 'host_runtime.py', 'artifacts.py', 'sessions.py', 'protocol.py'):
        data = ((SOURCE.parent/'work-runner' if name == 'protocol.py' else SOURCE)/name).read_bytes().replace(b'\r\n', b'\n')
        files[name] = dict(data=base64.b64encode(data).decode(), sha256=hashlib.sha256(data).hexdigest())
    release = hashlib.sha256(''.join(name+'\0'+files[name]['sha256']+'\n' for name in sorted(files)).encode()).hexdigest()
    return dict(version=1, release=release, files=files)


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lucyna-h-')
        self.options = dict(prefix=self.temp.name, mode='connection')
        self.bundle = bundle()

    def tearDown(self):
        self.temp.cleanup()

    def test_unicode_replay_page_stays_within_the_wire_frame_limit(self):
        import host
        page = dict(frames=[dict(sequence=i, frame=dict(type='event', text='中'*200000)) for i in range(2)])
        class Manager:
            def dispatch(self, operation, args):
                return page
        hello = dict(version=1, id='hello', op='hello', args=dict(protocolVersions=[1]))
        events = dict(version=1, id='events', op='session.events', args={})
        reader = io.BytesIO((json.dumps(hello)+'\n'+json.dumps(events)+'\n').encode())
        writer = io.BytesIO()
        host.serve_stream(reader, writer, {}, Manager())
        line = writer.getvalue().splitlines()[1]
        self.assertLess(len(line), host.LIMIT)
        self.assertEqual(json.loads(line[len(host.PREFIX):])['data'], page)

    def test_install_reuse_and_real_stdio(self):
        first = installer.install(self.bundle, self.options)
        again = installer.install(self.bundle, self.options)
        self.assertFalse(first['reused'])
        self.assertTrue(again['reused'])
        self.assertEqual(first['installationId'], again['installationId'])
        request = dict(version=1, id='test', op='hello', args=dict(protocolVersions=[1]))
        run = subprocess.run([sys.executable, '-I', first['entry'], 'stdio', '--state', first['state']],
                             input=json.dumps(request)+'\n', text=True, capture_output=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        hello = json.loads(run.stdout.removeprefix('LUCYNA_HOST_V1 '))
        self.assertEqual(hello['data']['installationId'], first['installationId'])
        self.assertFalse(hello['data']['ompSessionsSupported'])

    def test_bad_package_leaves_destination_empty(self):
        self.bundle['files']['host.py']['data'] = base64.b64encode(b'bad code').decode()
        with self.assertRaisesRegex(ValueError, 'digest'):
            installer.install(self.bundle, self.options)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_frozen_manifest_accepts_internal_links_but_rejects_escape_and_drift(self):
        root = Path(self.temp.name)/'package'
        root.mkdir()
        (root/'lucyna-host').write_bytes(b'fixture')
        (root/'lucyna-host').chmod(0o700)
        (root/'library').write_bytes(b'library')
        (root/'alias').symlink_to('library')
        manifest = artifacts.create_manifest(root, dict(os='Linux', arch='x86_64'))
        (root/'manifest.json').write_bytes(artifacts.canonical(manifest))
        artifacts.validate_directory(root, manifest['release'])
        (root/'library').write_bytes(b'modified')
        with self.assertRaisesRegex(ValueError, 'release_modified'):
            artifacts.validate_directory(root, manifest['release'])
        (root/'alias').unlink()
        (root/'alias').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError, 'unsafe_package_link'):
            artifacts.inventory(root)

    def test_symlink_and_unmanaged_directories_rejected(self):
        (Path(self.temp.name)/'data').symlink_to('/tmp')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            installer.install(self.bundle, self.options)
        (Path(self.temp.name)/'data').unlink()
        data = Path(self.temp.name)/'data'
        data.mkdir(mode=0o700)
        (data/'personal.txt').write_text('preserve')
        with self.assertRaisesRegex(ValueError, 'unmanaged'):
            installer.install(self.bundle, self.options)
        self.assertEqual((data/'personal.txt').read_text(), 'preserve')

    def test_modified_release_rejected_without_overwrite(self):
        installed = installer.install(self.bundle, self.options)
        Path(installed['entry']).write_text('changed')
        with self.assertRaisesRegex(ValueError, 'release_modified'):
            installer.install(self.bundle, self.options)
        self.assertEqual(Path(installed['entry']).read_text(), 'changed')

    def test_concurrent_install_same_identity(self):
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: installer.install(self.bundle, self.options), range(3)))
        self.assertEqual(len({r['installationId'] for r in results}), 1)
        self.assertEqual(sum(not r['reused'] for r in results), 1)

    def test_update_stages_candidate_without_replacing_active(self):
        installed = installer.install(self.bundle, self.options)
        candidate = bundle()
        data = base64.b64decode(candidate['files']['host.py']['data'])+b'\n# next release\n'
        candidate['files']['host.py'] = dict(data=base64.b64encode(data).decode(), sha256=hashlib.sha256(data).hexdigest())
        candidate['release'] = hashlib.sha256(''.join(name+'\0'+candidate['files'][name]['sha256']+'\n' for name in sorted(candidate['files'])).encode()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'update_pending'):
            installer.install(candidate, self.options)
        active = json.loads((Path(installed['state'])/'active.json').read_text())
        self.assertEqual(active['release'], installed['release'])
        self.assertTrue(Path(installed['entry']).exists())

    def test_daemon_survives_bridge_eof_and_enforces_handshake(self):
        installed = installer.install(self.bundle, self.options)
        state = Path(installed['state'])
        process = subprocess.Popen([sys.executable, '-I', installed['entry'], 'serve', '--state', str(state)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for _ in range(100):
                if (state/'control.sock').exists():
                    break
                time.sleep(.02)
            first = installer.hello(state)
            data = {'version': 1, 'id': 'bad', 'op': 'ping'}
            result = subprocess.run([sys.executable, '-I', installed['entry'], 'bridge', '--state', str(state)],
                                    input=json.dumps(data)+'\n', text=True, capture_output=True, timeout=10)
            self.assertFalse(json.loads(result.stdout.removeprefix('LUCYNA_HOST_V1 '))['ok'])
            self.assertEqual(installer.hello(state)['pid'], first['pid'])
            self.assertIsNone(process.poll())
        finally:
            process.terminate()
            process.communicate(timeout=10)


if __name__ == '__main__':
    os.umask(0o077)
    unittest.main()
