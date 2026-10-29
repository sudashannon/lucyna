"""Run a disposable Stele + local model protocol fixture for Lucyna UI acceptance.

No existing configuration, knowledge, transcript, or credentials are loaded.
Stop this foreground process after acceptance; its temporary directory is retained.
"""
import datetime
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading

root = Path(tempfile.mkdtemp(prefix="lucyna-knowledge-"))
data = root / "data"
docs = root / "docs"
data.mkdir()
docs.mkdir()
(root / "empty").mkdir()
body = "---\ntitle: Lucyna 验收知识\ntags: [验收, 图谱]\n---\n\n# Lucyna 验收知识\n\nUI_FIXTURE_TOKEN 是隔离验收的检索标记。\n\n验证原文版本后，才能保存可复用的知识。\n\n[相关记录](record.md)\n\n[待修复链接](missing.md)\n"
(docs / "evidence.md").write_text(body)
(docs / "record.md").write_text("---\ntitle: 关联验收记录\n---\n\n# 关联验收记录\n\n记录隔离界面的检查过程与结果。\n")
(data / "workspaces.yaml").write_text(f"workspaces:\n  - alias: fixture\n    path: {docs}\n    type: docs\n")
(data / "config.json").write_text(json.dumps({"schema_version": 1, "active_provider": "minimax", "providers": {"minimax": {"api_key": "local-fixture-only", "api_base": "http://127.0.0.1:19017", "model": "fixture", "thinking": "disabled"}}}))

from knowledge_protocol_fixture import Model

server = http.server.ThreadingHTTPServer(("127.0.0.1", 19017), Model)
threading.Thread(target=server.serve_forever, daemon=True).start()
environment = {**os.environ, "HOME": str(root), "STELE_DATA_DIR": str(data)}
print(json.dumps({"root": str(root), "base": "http://127.0.0.1:19015"}), flush=True)
binary = Path(os.environ.get("LUCYNA_STELE_BINARY", str(Path.home() / "workspace/stele/stele"))).resolve()
process = subprocess.Popen([str(binary), "--port", "19015", "--bind", "127.0.0.1", "--share-port", "0", "--dir", str(root / "empty"), "--sessions-dir", "", "--worktree-status-script", ""], cwd=binary.parent, env=environment)
try:
    process.wait()
except KeyboardInterrupt:
    process.terminate()
    process.wait(timeout=10)
finally:
    server.shutdown()
