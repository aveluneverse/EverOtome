"""examples/http-bridge: --help touches nothing, [abort] paths carry the feedback line, and the bridge
relays a message through the real engine/ folder to the echo companion and back."""
import json
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from _servers import BRIDGE, ECHO, ENGINE, WsProbe, bridge_stack, free_port, garbage_http_server

FEEDBACK = "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup"
CJK = re.compile(r"[\u4e00-\u9fff]")


def run(*args):
    return subprocess.run([sys.executable, *args], capture_output=True, text=True)


def get(port, path):
    try:
        with urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=5) as r:
            return r.status, r.read()
    except HTTPError as e:
        return e.code, e.read()


def post(port, path, body=b""):
    req = Request("http://127.0.0.1:%d%s" % (port, path), data=body, method="POST")
    try:
        with urlopen(req, timeout=5) as r:
            return r.status, r.read()
    except HTTPError as e:
        return e.code, e.read()


@pytest.mark.parametrize("script", [BRIDGE, ECHO])
def test_help_needs_nothing_and_writes_nothing(script, tmp_path):
    r = subprocess.run([sys.executable, "-S", str(script), "--help"], capture_output=True, text=True, cwd=tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "usage" in r.stdout.lower()
    assert not CJK.search(r.stdout), r.stdout
    assert list(tmp_path.iterdir()) == []


def test_bridge_without_reply_url_aborts():
    r = run(str(BRIDGE))
    out = r.stdout + r.stderr
    assert r.returncode == 1, out
    assert "[abort]" in out and "--reply" in out and FEEDBACK in out


def test_bridge_with_wrong_engine_folder_aborts(tmp_path):
    r = run(str(BRIDGE), "--reply", "http://127.0.0.1:1/reply", "--engine", str(tmp_path))
    out = r.stdout + r.stderr
    assert r.returncode == 1, out
    assert "[abort]" in out and "index.html" in out and FEEDBACK in out


def test_bridge_with_a_non_http_reply_url_aborts():
    r = run(str(BRIDGE), "--reply", "127.0.0.1:5000/reply", "--engine", str(ENGINE))
    out = r.stdout + r.stderr
    assert r.returncode == 1, out
    assert "[abort]" in out and "http" in out and FEEDBACK in out


@pytest.fixture(scope="module")
def stack():
    with bridge_stack() as port:
        yield port


def test_static_engine_is_served(stack):
    status, body = get(stack, "/")
    assert status == 200 and b"js/app.js" in body
    assert get(stack, "/js/app.js")[0] == 200
    status, body = get(stack, "/api/v4/cg/album")
    assert status == 200 and isinstance(json.loads(body)["items"], list)
    assert get(stack, "/nope.txt")[0] == 404


def test_round_trip_and_ledger(stack):
    ws = WsProbe(stack)
    assert " 101 " in ws.status_line, ws.status_line
    assert ws.accept_ok
    ws.send("hello")
    assert ws.recv_json() == {"role": "assistant", "text": "You said: hello"}
    ws.send(json.dumps({"text": "with a photo", "photos": ["p1"]}))
    note = ws.recv_json()
    assert note["role"] == "system" and "photo" in note["text"]
    assert ws.recv_json() == {"role": "assistant", "text": "You said: with a photo"}
    ws.send("/status")
    status = ws.recv_json()
    assert status["role"] == "system" and "bridge online" in status["text"]
    ws.send("/new")
    assert ws.recv_json() == {"role": "assistant", "text": "(new conversation)"}
    ws.send("/cg 1.png")
    assert ws.recv_json()["role"] == "system"
    ws.close()
    status, body = get(stack, "/api/history")
    assert status == 200
    entries = json.loads(body)["entries"]
    assert [(e["speaker"], e["text"]) for e in entries] == [
        ("User", "hello"), ("Assistant", "You said: hello"),
        ("User", "with a photo"), ("Assistant", "You said: with a photo"),
        ("Assistant", "(new conversation)"),
    ]
    assert all(isinstance(e["ts"], str) and e["ts"] for e in entries)


def test_unknown_posts_answer_404_json(stack):
    for path in ("/api/photo", "/api/call/start", "/api/v4/tts", "/api/v4/cg/manage"):
        status, body = post(stack, path, b"x" * 1000)
        assert status == 404, path
        assert "detail" in json.loads(body), path


def test_companion_down_is_reported_as_a_system_line():
    with bridge_stack("http://127.0.0.1:%d/reply" % free_port()) as port:
        ws = WsProbe(port)
        ws.send("anyone there?")
        frame = ws.recv_json()
        ws.close()
    assert frame["role"] == "system"
    assert frame["text"].startswith("bridge:") and "the companion at" in frame["text"] and FEEDBACK in frame["text"]


class _WrongJson(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        body = b'{"reply": "wrong key"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def test_companion_answering_without_text_is_reported():
    companion_port = free_port()
    httpd = HTTPServer(("127.0.0.1", companion_port), _WrongJson)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with bridge_stack("http://127.0.0.1:%d/reply" % companion_port) as port:
            ws = WsProbe(port)
            ws.send("hi")
            frame = ws.recv_json()
            ws.close()
    finally:
        httpd.shutdown()
    assert frame["role"] == "system" and frame["text"].startswith("bridge:") and '"text"' in frame["text"]


def test_companion_answering_garbage_http_is_reported():
    with garbage_http_server() as companion_port:
        with bridge_stack("http://127.0.0.1:%d/reply" % companion_port) as port:
            ws = WsProbe(port)
            ws.send("hi")
            frame = ws.recv_json()
            ws.close()
    assert frame["role"] == "system"
    assert frame["text"].startswith("bridge:") and "could not be read" in frame["text"] and FEEDBACK in frame["text"]


class _MessageReplyCompanion(BaseHTTPRequestHandler):
    """A companion whose route uses other field names: {"message"} in, {"reply"} out."""

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8"))
        reply = "(reset)" if data.get("command") == "new" else "echo: " + data.get("message", "?")
        body = json.dumps({"reply": reply}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def test_field_name_options_need_no_shim():
    companion_port = free_port()
    httpd = HTTPServer(("127.0.0.1", companion_port), _MessageReplyCompanion)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with bridge_stack("http://127.0.0.1:%d/chat" % companion_port,
                          extra_args=("--text-key", "message", "--reply-key", "reply")) as port:
            ws = WsProbe(port)
            ws.send("hi")
            assert ws.recv_json() == {"role": "assistant", "text": "echo: hi"}
            ws.send("/new")
            assert ws.recv_json() == {"role": "assistant", "text": "(reset)"}
            ws.close()
    finally:
        httpd.shutdown()


def test_wrong_reply_key_is_named_in_the_error():
    companion_port = free_port()
    httpd = HTTPServer(("127.0.0.1", companion_port), _MessageReplyCompanion)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with bridge_stack("http://127.0.0.1:%d/chat" % companion_port, extra_args=("--text-key", "message")) as port:
            ws = WsProbe(port)
            ws.send("hi")
            frame = ws.recv_json()
            ws.close()
    finally:
        httpd.shutdown()
    assert frame["role"] == "system" and 'no "text" string' in frame["text"]
