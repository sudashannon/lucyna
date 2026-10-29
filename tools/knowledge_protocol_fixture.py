"""Local deterministic Anthropic-compatible protocol fixture; no remote calls."""
import http.server
import json
import sys

class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        answer = "这是隔离模型协议夹具的回答。请先核对原文版本，再保存知识。[D1]"
        for message in reversed(request.get("messages", [])):
            if message.get("role") != "user":
                continue
            for block in message.get("content", []):
                if block.get("type") != "text":
                    continue
                try:
                    payload = json.loads(block.get("text", ""))
                except (ValueError, TypeError):
                    continue
                if isinstance(payload, dict) and payload.get("documents"):
                    primary = [doc["evidenceId"] for doc in payload["documents"] if not doc.get("contextOnly")]
                    answer = json.dumps({"label": "隔离验收", "summary": {"text": "整理了隔离知识与对应验收记录。", "evidenceIds": primary[:1]}, "claims": []}, ensure_ascii=False)
                    break
            break
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event in [
            {"type": "message_start", "message": {"id": "fixture", "type": "message", "role": "assistant", "content": [], "model": "fixture", "usage": {"input_tokens": 1, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": answer}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 16}},
            {"type": "message_stop"},
        ]:
            self.wfile.write(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 19018
    if port not in (19017, 19018):
        raise SystemExit("Only reserved disposable ports are allowed")
    print(f"local model protocol fixture: {port}", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Model).serve_forever()
