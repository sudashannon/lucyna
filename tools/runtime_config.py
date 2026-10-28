"""Read non-secret workspace settings shared with the Windows client."""
import json
import os
from pathlib import Path


def load_runtime():
    file = Path(os.environ.get('LUCYNA_CONFIG', Path(__file__).resolve().parents[1] / 'runtime.local.json'))
    config = json.loads(file.read_text(encoding='utf-8')) if file.is_file() else {}
    home = Path(config.get('home', str(Path.home())))
    return {
        'workRoot': Path(config.get('workRoot', home / 'work')),
        'wslAgentDir': Path(config.get('wslAgentDir', home / '.omp/agent')),
        'skillDirectory': Path(config.get('skillDirectory', home / '.agents/skills')),
    }
