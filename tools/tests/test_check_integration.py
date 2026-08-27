"""tools/check_integration.py: --help touches nothing, usage errors abort with the feedback line, the pure
validators judge frames and bodies the way engine/js does, and the end-to-end verdict is PASS behind the
bridge + echo companion, FAIL against a plain static server, FAIL when no assistant frame ever comes."""
import importlib.util
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from _servers import ROOT, bridge_stack, free_port, server

TOOL = ROOT / "tools" / "check_integration.py"
FEEDBACK = "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup"
CJK = re.compile(r"[\u4e00-\u9fff]")


def load_module():
    spec = importlib.util.spec_from_file_location("check_integration", TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(*args, timeout=180):
    return subprocess.run([sys.executable, str(TOOL), *args], capture_output=True, text=True, timeout=timeout)


def test_help_needs_nothing_and_writes_nothing(tmp_path):
    r = subprocess.run([sys.executable, "-S", str(TOOL), "--help"], capture_output=True, text=True, cwd=tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "usage" in r.stdout.lower()
    for flag in ("--message", "--timeout", "--skip-tts"):
        assert flag in r.stdout
    assert not CJK.search(r.stdout), r.stdout
    assert list(tmp_path.iterdir()) == []


def test_missing_url_aborts():
    r = run()
    out = r.stdout + r.stderr
    assert r.returncode == 1, out
    assert "[abort]" in out and FEEDBACK in out


def test_non_http_url_aborts():
    r = run("ftp://127.0.0.1/")
    out = r.stdout + r.stderr
    assert r.returncode == 1, out
    assert "[abort]" in out and "http" in out and FEEDBACK in out


def test_assistant_frame_verdicts():
    m = load_module()
    ok, notes = m.check_assistant_frame({"role": "assistant", "text": "hi"})
    assert ok and notes == []
    ok, notes = m.check_assistant_frame({"role": "assistant"})
    assert not ok and any(n[0] == "FAIL" and '"text"' in n[1] for n in notes)
    ok, notes = m.check_assistant_frame({"role": "assistant", "text": "hi", "room": "r1"})
    assert not ok and any(n[0] == "FAIL" and "room" in n[1] for n in notes)
    ok, notes = m.check_assistant_frame({"role": "assistant", "text": "hi", "thoughts_pending": True})
    assert ok and notes[0][0] == "WARN" and "timestamp" in notes[0][1]
    ok, notes = m.check_assistant_frame({"role": "assistant", "text": "hi", "thoughts_pending": True, "timestamp": "t1"})
    assert ok and notes == []
    ok, notes = m.check_assistant_frame({"role": "assistant", "text": "hi", "audio": "/a.mp3"})
    assert ok and notes[0][0] == "WARN" and "audio" in notes[0][1]
    ok, notes = m.check_assistant_frame({"role": "assistant", "text": "hi", "thoughts": 7})
    assert ok and notes[0][0] == "WARN" and "thoughts" in notes[0][1]
    ok, notes = m.check_assistant_frame("not an object")
    assert not ok and notes[0][0] == "FAIL"


def test_history_body_verdicts():
    m = load_module()
    level, text, fix = m.check_history_body([{"ts": "1", "speaker": "User", "text": "x"}])
    assert level == "FAIL" and "bare array" in text and '{"entries"' in fix
    assert m.check_history_body({"entries": []})[0] == "PASS"
    assert m.check_history_body({"entries": [{"ts": "1", "speaker": "Assistant", "text": "y", "audio": ["/a.mp3"]}]})[0] == "PASS"
    level, text, _ = m.check_history_body({"entries": [{"ts": "1", "speaker": "Bot", "text": "x"},
                                                       {"ts": "2", "speaker": "User", "text": "y"}]})
    assert level == "WARN" and "1 of 2" in text
    level, text, _ = m.check_history_body({"entries": [{"ts": "1", "speaker": "User", "text": "x", "audio": "/a.mp3"}]})
    assert level == "WARN"
    assert m.check_history_body({"nope": 1})[0] == "FAIL"
    assert m.check_history_body("text")[0] == "FAIL"


def test_album_body_verdicts():
    m = load_module()
    level, text, _ = m.check_album_body({"items": [{"id": "1.png"}]})
    assert level == "PASS" and "1 item" in text
    assert m.check_album_body({"items": "x"})[0] == "FAIL"
    assert m.check_album_body([])[0] == "FAIL"


@pytest.fixture(scope="module")
def stack():
    with bridge_stack() as port:
        yield port


def test_end_to_end_pass_behind_the_bridge(stack):
    r = run("http://127.0.0.1:%d" % stack, "--timeout", "30")
    out = r.stdout
    assert r.returncode == 0, out + r.stderr
    for needle in ("[PASS] shell", "[PASS] websocket", "[PASS] chat", "[PASS] history",
                   "[WARN] voice", "[INFO] photos", "[INFO] phone", "[PASS] album", "[INFO] chat-clear",
                   "RESULT: PASS"):
        assert needle in out, needle + "\n" + out
    # This dev machine has a gitignored engine/config.json identical to config.example.json, so the
    # checker reports [PASS] config here while a clean clone (no config.json) reports [WARN] config.
    assert re.search(r"\[(PASS|WARN)\] config", out), out
    assert "You said:" in out
    assert not CJK.search(out), out


def test_end_to_end_fail_against_a_plain_static_server(tmp_path):
    port = free_port()
    with server(["-m", "http.server", str(port), "--bind", "127.0.0.1"], "http://127.0.0.1:%d/" % port, cwd=tmp_path):
        r = run("http://127.0.0.1:%d" % port, "--timeout", "5")
    assert r.returncode == 1, r.stdout + r.stderr
    for needle in ("[FAIL] shell", "[FAIL] websocket", "fix:", "RESULT: FAIL", FEEDBACK):
        assert needle in r.stdout, needle + "\n" + r.stdout


class _SilentCompanion(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        body = b'{"text": ""}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def test_no_assistant_frame_is_a_fail():
    companion_port = free_port()
    httpd = HTTPServer(("127.0.0.1", companion_port), _SilentCompanion)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with bridge_stack("http://127.0.0.1:%d/reply" % companion_port) as port:
            r = run("http://127.0.0.1:%d" % port, "--timeout", "3", "--skip-tts")
    finally:
        httpd.shutdown()
    assert r.returncode == 1, r.stdout + r.stderr
    assert "[FAIL] chat" in r.stdout and "no assistant frame" in r.stdout and "system" in r.stdout
    assert "[INFO] voice" in r.stdout
