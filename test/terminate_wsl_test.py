import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

spec = importlib.util.spec_from_file_location('terminate_wsl', Path(__file__).resolve().parents[1] / 'tools/terminate_wsl.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@unittest.skipUnless(sys.platform == 'linux', 'Linux process ownership test')
class TerminateSessionTest(unittest.TestCase):
    def test_stops_owned_tree_including_clean_environment_child_and_preserves_peer(self):
        token = str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / 'ready.json'
            source = ('import subprocess,sys,time,json,signal;'
                      'signal.signal(signal.SIGTERM,signal.SIG_IGN);'
                      'p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"],env={});'
                      'open(sys.argv[1],"w").write(json.dumps(p.pid));time.sleep(60)')
            launcher = Path(__file__).resolve().parents[1] / 'tools/launch_wsl.py'
            root = subprocess.Popen([sys.executable, str(launcher), '--agent-dir', directory,
                                     '--session-token', token, sys.executable, '-c', source, str(ready)])
            peer = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
            child_pid = None
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                child_pid = json.loads(ready.read_text())
                module.terminate(token)
                root.wait(timeout=5)
                self.assertIsNotNone(root.returncode)
                self.assertIsNone(module.identity(child_pid)[1])
                self.assertIsNone(peer.poll())
                module.terminate(token)  # already stopped, no broad process-name fallback
            finally:
                for process in (root, peer):
                    if process.poll() is None:
                        process.kill()
                    process.wait()
                if child_pid and module.identity(child_pid)[1] is not None:
                    os.kill(child_pid, 9)

    def test_rejects_missing_or_malformed_ownership_token(self):
        for value in ['', '../other', '*']:
            with self.assertRaises(ValueError):
                module.terminate(value)


if __name__ == '__main__':
    unittest.main()
