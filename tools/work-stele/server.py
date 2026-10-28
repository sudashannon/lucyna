#!/usr/bin/env python3
"""MCP stdio bridge for the existing WSL worktree-session skill and Stele.

The process is launched by Windows OMP through ``wsl.exe``. It reads the
existing Stele write token only inside WSL and never logs request bodies,
headers, token contents, or helper output to stderr/stdout.
"""

import hmac
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_config import load_runtime


STELE_URL = "http://127.0.0.1:18989/mcp"
RUNTIME = load_runtime()
WORK_ROOT = RUNTIME['workRoot']
SKILL_ROOT = RUNTIME['skillDirectory'] / 'worktree-session'
WORK_HELPER = SKILL_ROOT / "scripts" / "worktree-work.py"
MAX_LINE_BYTES = 1 << 20
MAX_FILE_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 4 << 20

READ_TOOLS = {
    "wiki_search",
    "wiki_component",
    "wiki_neighbors",
    "wiki_overview",
    "wiki_read",
    "wiki_lint",
    "wiki_context",
    "wiki_sessions",
    "todo_list",
    "wiki_claim_search",
    "wiki_claim_get",
    "wiki_claims",
    "wiki_review_list",
    "wiki_candidate_list",
}
WRITE_TOOLS = {
    "todo_create",
    "todo_update",
    "todo_sync_omp",
    "wiki_claim_upsert",
    "wiki_review_action",
    "wiki_candidate_create",
    "wiki_candidate_action",
}

SKILL_REFERENCES = {"start", "continue", "review", "end"}
WORK_TOOLS = [
    {
        "name": "work_skill",
        "description": (
            "读取 WSL 中已安装的 worktree-session 技能及指定工作流参考。"
            "处理 work 根、SESSION、Git worktree、Todo 或 L3 知识前先读取并遵守。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "section": {
                    "type": "string",
                    "enum": ["overview", "start", "continue", "review", "end"],
                    "description": "overview 返回主技能；其他值附加对应工作流参考。",
                }
            },
        },
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "work_list",
        "description": "通过现有只读 worktree-work.py 列出 WSL work 根；不会创建、修改或清理工作区。",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "work_verify",
        "description": "对已列出的有效 WSL work 根运行现有只读 verify 检查。",
        "inputSchema": {
            "type": "object",
            "properties": {"root": {"type": "string", "description": "work_list 返回的 root 完整路径。"}},
            "required": ["root"],
        },
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "work_read_session",
        "description": "只读指定有效 work 根的 SESSION.md；不会访问其他私有 SESSION 日志。",
        "inputSchema": {
            "type": "object",
            "properties": {"root": {"type": "string", "description": "work_list 返回的 root 完整路径。"}},
            "required": ["root"],
        },
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "work_read_note",
        "description": "只读有效 work 根 notes/ 下的 Markdown 共享笔记。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "description": "work_list 返回的 root 完整路径。"},
                "name": {"type": "string", "description": "work_list 中 notes 字段列出的 Markdown 文件名。"},
            },
            "required": ["root", "name"],
        },
        "annotations": {"readOnlyHint": True},
    },
]


class BridgeError(Exception):
    """An error safe to return to the MCP caller."""


def _json_result(value):
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]}


def _error_result(message):
    return {"content": [{"type": "text", "text": message}], "isError": True}


def _read_token():
    candidates = [
        Path.home() / ".stele" / "mcp-write-token",
        Path.home() / ".comet-panel" / "mcp-write-token",
    ]
    for token_path in candidates:
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(token_path, flags)
        except FileNotFoundError:
            continue
        except OSError:
            raise BridgeError("Stele write token cannot be opened securely") from None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise BridgeError("Stele write token permissions are not private")
            if info.st_size > 4096:
                raise BridgeError("Stele write token file is invalid")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                token = stream.read(4097).decode("utf-8").strip()
            if not token or len(token) > 4096:
                raise BridgeError("Stele write token is empty or invalid")
            return token
        finally:
            os.close(fd)
    raise BridgeError("Stele write token is not installed in WSL")


def _stele_request(method, params=None, write=False):
    request_id = "work-stele-" + uuid.uuid4().hex
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if write:
        token = _read_token()
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(STELE_URL, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise BridgeError("Stele MCP returned HTTP " + str(response.status))
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise BridgeError("Stele MCP returned HTTP " + str(error.code)) from None
    except urllib.error.URLError:
        raise BridgeError("Stele MCP is unavailable from WSL loopback") from None
    except TimeoutError:
        raise BridgeError("Stele MCP request timed out") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise BridgeError("Stele MCP response exceeded the size limit")
    try:
        result = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BridgeError("Stele MCP returned invalid JSON") from None
    if not isinstance(result, dict) or result.get("jsonrpc") != "2.0" or result.get("id") != request_id:
        raise BridgeError("Stele MCP returned an unexpected JSON-RPC response")
    if "error" in result:
        error = result["error"]
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            raise BridgeError("Stele MCP error: " + error["message"][:1000])
        raise BridgeError("Stele MCP returned a JSON-RPC error")
    return result.get("result")


def _work_entries():
    if not WORK_HELPER.is_file():
        raise BridgeError("WSL worktree-session helper is unavailable")
    try:
        completed = subprocess.run(
            [sys.executable, str(WORK_HELPER), "list", "--root", str(WORK_ROOT), "--fast"],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        entries = json.loads(completed.stdout)
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError):
        raise BridgeError("WSL work inventory failed; helper output was withheld") from None
    if not isinstance(entries, list):
        raise BridgeError("WSL work inventory returned an invalid shape")
    return entries


def _entry_for_root(root):
    if not isinstance(root, str) or not root.startswith(str(WORK_ROOT) + "/"):
        raise BridgeError("Choose a work root returned by work_list")
    if "\\" in root or "\x00" in root or ".." in Path(root).parts:
        raise BridgeError("Choose a work root returned by work_list")
    entry = next((item for item in _work_entries() if isinstance(item, dict) and item.get("root") == root), None)
    if entry is None or entry.get("kind") == "invalid":
        raise BridgeError("The selected work root is missing or invalid")
    root_path = Path(root)
    if root_path.is_symlink() or not root_path.is_dir():
        raise BridgeError("The selected work root is not a regular directory")
    return entry, root_path


def _read_work_file(root_path, relative_path):
    candidate = root_path / relative_path
    if candidate.is_symlink() or not candidate.is_file():
        raise BridgeError("The selected work file is missing or is a symlink")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root_path.resolve(strict=True))
        if candidate.stat().st_size > MAX_FILE_BYTES:
            raise BridgeError("The selected work file exceeds 512 KiB")
        return candidate.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError, ValueError):
        raise BridgeError("The selected work file cannot be read safely") from None


def _load_skill(section):
    if section not in {None, "overview", *SKILL_REFERENCES}:
        raise BridgeError("Choose overview, start, continue, review, or end")
    try:
        main = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
        if section in (None, "overview"):
            return main
        reference = (SKILL_ROOT / "references" / (section + ".md")).read_text(encoding="utf-8")
        return main + "\n\n--- " + section + ".md ---\n\n" + reference
    except (OSError, UnicodeDecodeError):
        raise BridgeError("The installed WSL worktree-session skill is unavailable") from None


def _listed_stele_tools():
    result = _stele_request("tools/list")
    tools = result.get("tools") if isinstance(result, dict) else None
    if not isinstance(tools, list):
        raise BridgeError("Stele MCP tool catalogue is invalid")
    allowed = READ_TOOLS | WRITE_TOOLS
    out = []
    for tool in tools:
        if not isinstance(tool, dict) or tool.get("name") not in allowed:
            continue
        item = dict(tool)
        name = item["name"]
        description = item.get("description", "")
        if name in WRITE_TOOLS:
            item["description"] = (
                str(description).rstrip()
                + " This operation writes Stele; follow the worktree-session skill's evidence and approval rules."
            )
            item["annotations"] = {**(item.get("annotations") or {}), "readOnlyHint": False}
        else:
            item["annotations"] = {**(item.get("annotations") or {}), "readOnlyHint": True}
        out.append(item)
    return out


def _tool_definitions():
    return WORK_TOOLS + _listed_stele_tools()


def _call_work_tool(name, arguments):
    if name == "work_skill":
        return {"content": [{"type": "text", "text": _load_skill(arguments.get("section"))}]}
    if name == "work_list":
        return _json_result(_work_entries())
    if name == "work_verify":
        root = arguments.get("root")
        _entry, root_path = _entry_for_root(root)
        try:
            completed = subprocess.run(
                [sys.executable, str(WORK_HELPER), "verify", str(root_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            value = json.loads(completed.stdout)
        except subprocess.CalledProcessError as error:
            # The helper's detailed output may include unrelated paths; keep it out of app logs.
            raise BridgeError("worktree-work.py verify failed (exit " + str(error.returncode) + ")") from None
        except (subprocess.SubprocessError, OSError, json.JSONDecodeError):
            raise BridgeError("worktree-work.py verify failed; helper output was withheld") from None
        return _json_result(value)
    if name == "work_read_session":
        _entry, root_path = _entry_for_root(arguments.get("root"))
        return {"content": [{"type": "text", "text": _read_work_file(root_path, "SESSION.md")}]}
    if name == "work_read_note":
        entry, root_path = _entry_for_root(arguments.get("root"))
        note = arguments.get("name")
        if (
            not isinstance(note, str)
            or not note.endswith(".md")
            or Path(note).name != note
            or note in {".", ".."}
            or note not in (entry.get("notes") if isinstance(entry.get("notes"), list) else [])
        ):
            raise BridgeError("Choose a Markdown note listed for this work root")
        return {"content": [{"type": "text", "text": _read_work_file(root_path, Path("notes") / note)}]}
    raise BridgeError("Unknown work tool")


def _call_tool(params):
    if not isinstance(params, dict) or not isinstance(params.get("name"), str):
        return _error_result("Invalid tools/call parameters")
    name = params["name"]
    arguments = params.get("arguments", {})
    if not isinstance(arguments, dict):
        return _error_result("Tool arguments must be an object")
    try:
        if name in {tool["name"] for tool in WORK_TOOLS}:
            return _call_work_tool(name, arguments)
        if name not in READ_TOOLS and name not in WRITE_TOOLS:
            return _error_result("This tool is not available through the work-stele bridge")
        result = _stele_request(
            "tools/call",
            {"name": name, "arguments": arguments},
            write=name in WRITE_TOOLS,
        )
        if not isinstance(result, dict) or not isinstance(result.get("content"), list):
            raise BridgeError("Stele returned an invalid tool result")
        return result
    except BridgeError as error:
        return _error_result(str(error))


def _response(request, result=None, error=None):
    response = {"jsonrpc": "2.0", "id": request.get("id")}
    if error is not None:
        response["error"] = error
    else:
        response["result"] = result
    return response


def _handle(request):
    if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
        return _response(request if isinstance(request, dict) else {}, error={"code": -32600, "message": "Invalid Request"})
    method = request["method"]
    request_id = request.get("id")
    if method == "notifications/initialized" or (method.startswith("notifications/") and "id" not in request):
        return None
    if method == "initialize":
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        requested_version = params.get("protocolVersion")
        version = requested_version if requested_version in {"2024-11-05", "2025-03-26"} else "2025-03-26"
        return _response(
            request,
            {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "work-stele", "version": "0.1.0"},
                "instructions": (
                    "Use work_skill before worktree-session operations. Work tools are read-only. "
                    "Stele writes use the existing WSL-local token and must follow work skill evidence/approval rules."
                ),
            },
        )
    if method == "ping":
        return _response(request, {})
    if method == "tools/list":
        try:
            return _response(request, {"tools": _tool_definitions()})
        except BridgeError as error:
            return _response(request, {"tools": WORK_TOOLS}) if request_id is not None else None
    if method == "tools/call":
        return _response(request, _call_tool(request.get("params")))
    if request_id is None:
        return None
    return _response(request, error={"code": -32601, "message": "Method not found"})


def main():
    source = sys.stdin.buffer
    sink = sys.stdout
    while True:
        line = source.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES:
            while line and not line.endswith(b"\n"):
                line = source.readline(MAX_LINE_BYTES + 1)
            sink.write(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Request too large"}}) + "\n")
            sink.flush()
            continue
        try:
            request = json.loads(line)
            response = _handle(request)
        except (UnicodeDecodeError, json.JSONDecodeError):
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        except Exception:
            # Avoid traceback output: OMP treats stdout as protocol and stderr may be logged.
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": "Bridge internal error"}}
        if response is not None:
            sink.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            sink.flush()


if __name__ == "__main__":
    main()
