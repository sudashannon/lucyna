"""Isolated test-only MCP service and token for the WSL stdio bridge.

No production Stele process, workspace, claim, or todo is contacted. The mock
server binds an ephemeral WSL loopback port and keeps all fixture data in RAM.
Run only through a dedicated stdio client; diagnostics go to stderr.
"""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading


TEST_TOKEN = "work-stele-isolated-fixture-token"
CLAIM_ID = "claim.work-stele-stdio-smoke"


class Fixture:
    def __init__(self, expected_token):
        self.expected_token = expected_token
        self.lock = threading.Lock()
        self.calls = []
        self.claims = {}
        self.loopback_only = True
        self.denied = 0

    def handle(self, request, remote_host):
        method = request.get("method")
        request_id = request.get("id")
        params = request.get("params") or {}
        if remote_host not in {"127.0.0.1", "::1"}:
            self.loopback_only = False
        if method == "tools/list":
            result = {
                "tools": [
                    {"name": "wiki_context", "description": "Fixture read", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}}},
                    {"name": "wiki_claim_get", "description": "Fixture claim read", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}}},
                    {"name": "wiki_claim_upsert", "description": "Fixture claim write", "inputSchema": {"type": "object", "properties": {"workspace": {"type": "string"}, "claims": {"type": "array"}}}},
                    {"name": "todo_delete", "description": "Must remain blocked by the bridge allowlist", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}}},
                ]
            }
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        if method != "tools/call":
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "method not found"}}
        name = params.get("name")
        args = params.get("arguments") or {}
        with self.lock:
            self.calls.append(name)
        if name in {"wiki_claim_upsert", "todo_delete"}:
            authorization = request.get("_authorization", "")
            if authorization != "Bearer " + self.expected_token:
                self.denied += 1
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {"content": [{"type": "text", "text": "write access denied: loopback + Bearer token required"}], "isError": True},
                }
        if name == "wiki_context":
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"content": [{"type": "text", "text": "isolated fixture context"}]},
            }
        if name == "wiki_claim_get":
            claim = self.claims.get(args.get("id"))
            if claim is None:
                return {"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": "claim not found"}], "isError": True}}
            return {"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": json.dumps(claim)}]}}
        if name == "wiki_claim_upsert":
            workspace = args.get("workspace")
            claims = args.get("claims")
            if workspace != "fixture" or not isinstance(claims, list) or not claims:
                message = "workspace is required" if not workspace else "fixture requires a non-empty claims array"
                return {"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": message}], "isError": True}}
            for claim in claims:
                if isinstance(claim, dict) and isinstance(claim.get("id"), str):
                    self.claims[claim["id"]] = {**claim, "workspace": workspace}
            return {"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": json.dumps({"applied": len(claims), "workspace": workspace})}]}}
        return {"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": "unknown tool"}], "isError": True}}


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--wrong-token", action="store_true")
    args, _rest = parser.parse_known_args()
    token = TEST_TOKEN if not args.wrong_token else "deliberately-wrong-fixture-token"
    temp_home = tempfile.TemporaryDirectory(prefix="work-stele-fixture-")
    os.environ["HOME"] = temp_home.name
    token_directory = Path(temp_home.name) / ".stele"
    token_directory.mkdir(mode=0o700)
    token_file = token_directory / "mcp-write-token"
    token_file.write_text(token + "\n", encoding="utf-8")
    token_file.chmod(0o600)

    fixture = Fixture(TEST_TOKEN)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
                request = json.loads(self.rfile.read(length))
                request["_authorization"] = self.headers.get("Authorization", "")
                response = fixture.handle(request, self.client_address[0])
                body = json.dumps(response).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                self.send_error(500)

        def log_message(self, _format, *_values):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()

    script_path = Path(__file__).with_name("server.py")
    spec = importlib.util.spec_from_file_location("work_stele_bridge_fixture", script_path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    bridge.STELE_URL = "http://127.0.0.1:%d/mcp" % server.server_address[1]
    try:
        bridge.main()
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
        print(
            "WORK_STELE_TEST_RESULT="
            + json.dumps(
                {
                    "wrongTokenMode": args.wrong_token,
                    "loopbackOnly": fixture.loopback_only,
                    "forwardedCalls": fixture.calls,
                    "deniedWrites": fixture.denied,
                    "fixtureClaimStored": CLAIM_ID in fixture.claims,
                },
                separators=(",", ":"),
            ),
            file=__import__("sys").stderr,
            flush=True,
        )
        temp_home.cleanup()


if __name__ == "__main__":
    main()
