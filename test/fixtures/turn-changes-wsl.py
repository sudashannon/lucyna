"""Run with Linux Git: python3 test/fixtures/turn-changes-wsl.py."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def verify():
    source = Path(__file__).resolve().parents[2] / 'src' / 'turn-changes.py'
    with tempfile.TemporaryDirectory(prefix='lucyna-turn-test-') as scratch:
        root = Path(scratch) / 'work'
        repo = root / 'repos' / 'app'
        repo.mkdir(parents=True)
        (root / 'SESSION.md').write_text('# fixture', encoding='utf-8')
        member = {'name': 'app', 'path': 'repos/app', 'repo': str(repo / '.git')}
        (root / 'work.json').write_text(json.dumps({'version': 1, 'members': [member]}), encoding='utf-8')

        def git(*args):
            return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()

        git('init', '-q')
        git('config', 'user.name', 'fixture')
        git('config', 'user.email', 'fixture@example.invalid')
        existing = repo / 'existing.txt'
        existing.write_text('committed\n', encoding='utf-8')
        gone = repo / 'gone.txt'
        gone.write_text('deleted by this round\n', encoding='utf-8')
        git('add', '.')
        git('commit', '-qm', 'baseline')
        existing.write_text('staged before\n', encoding='utf-8')
        git('add', 'existing.txt')
        existing.write_text('unstaged before\n', encoding='utf-8')
        (repo / 'old-untracked.txt').write_text('created earlier\n', encoding='utf-8')
        index = (repo / '.git/index').read_bytes()
        count = git('count-objects')
        with subprocess.Popen([sys.executable, str(source), str(root)], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as capture:
            assert capture.stdout.readline().strip() == 'ready', capture.stderr.read()
            existing.write_text('changed in round\n', encoding='utf-8')
            (repo / 'new name.txt').write_text('added in round\n', encoding='utf-8')
            gone.unlink()
            output, error = capture.communicate('finish\n', timeout=12)
            assert capture.returncode == 0, error
        result = json.loads(output)
        patches = {item['path']: item['patch'] for item in result['files']}
        assert set(patches) == {'existing.txt', 'new name.txt', 'gone.txt'}, result
        assert '-unstaged before' in patches['existing.txt'] and '+changed in round' in patches['existing.txt'], result
        assert '+added in round' in patches['new name.txt'] and '-deleted by this round' in patches['gone.txt'], result
        assert not result['warnings'], result
        assert index == (repo / '.git/index').read_bytes() and count == git('count-objects')
        print('PASS: staged and unstaged baseline, add/edit/delete, unchanged source index and objects')


if __name__ == '__main__':
    verify()
