# -*- coding: utf-8 -*-
"""Integration check for a server that hosts EverOtome.

Point it at the address you open in the browser. It does what the shell does on load, then sends ONE chat
message and waits for the reply, and prints a PASS / WARN / FAIL / INFO line per area with a fix under every
FAIL. Exit code 0 when nothing failed, 1 otherwise. Standard library only, Python 3.7 or newer.

    python tools/check_integration.py http://127.0.0.1:8400
    python tools/check_integration.py https://companion.example.com --message "hi" --timeout 120

What it sends: one WebSocket text message (the --message text; the companion may remember it), one short
POST to the text-to-speech endpoint unless --skip-tts, one empty POST to the photo endpoint (no file is
uploaded), and GETs to the history, call-log, album and chat-clear paths. It never starts a call and never
sends /new.
"""
import argparse
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import sys
import time
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

FEEDBACK = "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
# Same three defaults the shell applies underneath config.json (engine/js/app.js HARD_DEFAULTS).
HARD_DEFAULTS = {"wsEndpoint": "/ws", "ttsEndpoint": "/api/v4/tts", "photoEndpoint": "/api/photo"}
SPEAKERS = ("User", "Assistant", "System")
DEFAULT_MESSAGE = "Hello from EverOtome's integration check."
ONE_ORIGIN = ("the shell builds ws(s)://<the host that served the page><wsEndpoint>, so the same server that "
              "answers / must accept the WebSocket; if the companion listens elsewhere, run "
              "examples/http-bridge or put both behind one reverse proxy (docs/backend-contract.md, Deployment)")


# ── pure verdicts (unit tested) ──────────────────────────────────────────────

def check_assistant_frame(frame):
    """Judge a frame the checker took as the reply. Returns (ok, notes); notes are (level, text, fix) tuples
    and ok is False when the shell would not render the frame as a reply."""
    if not isinstance(frame, dict):
        return False, [("FAIL", "the frame is not a JSON object", "send {\"role\": \"assistant\", \"text\": \"...\"}")]
    notes = []
    if frame.get("room"):
        notes.append(("FAIL", "the frame carries a \"room\" field, which the shell drops entirely",
                      "remove \"room\" (it is reserved); use another name for your own ids"))
    if not isinstance(frame.get("text"), str):
        notes.append(("FAIL", "\"text\" is missing or not a string (keys seen: %s)" % ", ".join(sorted(frame)),
                      "the reply must be {\"role\": \"assistant\", \"text\": \"...\"}"))
    if frame.get("thoughts_pending") and frame.get("timestamp") is None:
        notes.append(("WARN", "\"thoughts_pending\" without \"timestamp\": the later thoughts frame can never match",
                      "send \"timestamp\" with the reply and the same value as \"for_ts\" on the thoughts frame"))
    if "audio" in frame and not isinstance(frame["audio"], list):
        notes.append(("WARN", "\"audio\" is not an array", "assistant.audio is an array of URLs"))
    if "thoughts" in frame and frame["thoughts"] is not None and not isinstance(frame["thoughts"], str):
        notes.append(("WARN", "\"thoughts\" is not a string", "thoughts is a string, or leave it out"))
    ok = not any(level == "FAIL" for level, _, _ in notes)
    return ok, notes


def check_history_body(data):
    """(level, text, fix) for the JSON body of historyEndpoint."""
    if isinstance(data, list):
        return ("FAIL", "the body is a bare array", "wrap it: {\"entries\": [...]}")
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        return ("FAIL", "no \"entries\" array in the body",
                "answer {\"entries\": [{\"ts\": \"...\", \"speaker\": \"User\" | \"Assistant\" | \"System\", \"text\": \"...\"}]}")
    entries = data["entries"]
    bad = []
    for i, e in enumerate(entries):
        if not isinstance(e, dict) or e.get("speaker") not in SPEAKERS or not isinstance(e.get("text"), str):
            bad.append(i)
        elif "audio" in e and not isinstance(e["audio"], list):
            bad.append(i)
    if bad:
        return ("WARN", "%d of %d entries would be skipped (speaker must be exactly User, Assistant or System; "
                        "text a string; audio an array); first bad index %d" % (len(bad), len(entries), bad[0]),
                None)
    return ("PASS", "%d entries, shape OK" % len(entries), None)


def check_album_body(data):
    """(level, text, fix) for the JSON body of {cgEndpoint}/album."""
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return ("FAIL", "no \"items\" array in the album body",
                "answer {\"items\": [...]} (docs/cg-guide.md), or remove cgEndpoint from config.json")
    n = len(data["items"])
    return ("PASS", "%d item%s" % (n, "" if n == 1 else "s"), None)


# ── plumbing ─────────────────────────────────────────────────────────────────

class Report:
    LEVELS = ("PASS", "WARN", "FAIL", "INFO")

    def __init__(self):
        self.counts = dict.fromkeys(self.LEVELS, 0)

    def add(self, level, area, text, fix=None):
        self.counts[level] += 1
        line = "[%s] %s: %s" % (level, area, text)
        if fix:
            line += "\n       fix: " + fix
        print(line)

    def failed(self):
        return self.counts["FAIL"] > 0


def http(method, url, body=None, headers=None, timeout=15):
    """(status, headers, bytes), or (None, {}, reason) when no HTTP answer came back at all."""
    req = urlrequest.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urlrequest.urlopen(req, timeout=timeout) as res:
            return res.status, dict(res.headers), res.read()
    except HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except URLError as e:
        return None, {}, str(e.reason)
    except OSError as e:
        return None, {}, str(e)


def parse_json(raw):
    try:
        return json.loads(raw.decode("utf-8")), None
    except (ValueError, UnicodeDecodeError) as e:
        return None, str(e)


class WsError(Exception):
    pass


class WsClosed(Exception):
    pass


class WsClient:
    """A minimal RFC 6455 client: handshake with Origin, masked text out, frames in."""

    def __init__(self, base, path, timeout):
        u = urlsplit(base)
        secure = u.scheme == "https"
        self.sock = socket.create_connection((u.hostname, u.port or (443 if secure else 80)), timeout=timeout)
        if secure:
            self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=u.hostname)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        self.sock.sendall(("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nOrigin: %s\r\n\r\n"
                           % (path, u.netloc, key, base)).encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WsError("the server closed the connection during the handshake")
            head += chunk
            if len(head) > 65536:
                raise WsError("the handshake answer is too large")
        status_line = head.split(b"\r\n", 1)[0].decode("ascii", "replace")
        parts = status_line.split(" ", 2)
        code = parts[1] if len(parts) > 1 else "?"
        if code != "101":
            raise WsError("HTTP %s instead of 101 Switching Protocols" % status_line)
        expect = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest())
        if expect not in head:
            raise WsError("the Sec-WebSocket-Accept header is wrong")
        self._buf = head.split(b"\r\n\r\n", 1)[1]

    def _read(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WsClosed()
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            head = bytes([0x80 | opcode, 0x80 | n])
        elif n < 65536:
            head = bytes([0x80 | opcode, 0x80 | 126]) + struct.pack(">H", n)
        else:
            head = bytes([0x80 | opcode, 0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def send_text(self, text):
        self._send(0x1, text.encode("utf-8"))

    def recv_text(self, deadline):
        """The next complete text message as str; None when the deadline passes; WsClosed on a close."""
        parts = []
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self.sock.settimeout(remaining)
            try:
                head = self._read(2)
                fin = bool(head[0] & 0x80)
                opcode = head[0] & 0x0F
                masked = bool(head[1] & 0x80)
                n = head[1] & 0x7F
                if n == 126:
                    n = struct.unpack(">H", self._read(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", self._read(8))[0]
                mask = self._read(4) if masked else None
                payload = self._read(n)
            except socket.timeout:
                return None
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise WsClosed()
            if opcode == 0x9:
                self._send(0xA, payload)
                continue
            if opcode in (0xA, 0x2):
                continue
            parts.append(payload)
            if fin:
                return b"".join(parts).decode("utf-8", "replace")

    def close(self):
        try:
            self._send(0x8, b"\x03\xe8")
        except OSError:
            pass
        self.sock.close()


# ── the checks ───────────────────────────────────────────────────────────────

def load_effective_config(base, rep):
    status, _, raw = http("GET", base + "/config.json")
    loaded = None
    if status == 200:
        loaded, err = parse_json(raw)
        if isinstance(loaded, dict):
            rep.add("PASS", "config", "config.json loaded (keys: %s)" % ", ".join(sorted(loaded)))
        else:
            loaded = None
            rep.add("WARN", "config", "config.json is not a JSON object (%s); the shell falls back to config.example.json"
                    % (err or "not an object"))
    elif status == 404:
        rep.add("WARN", "config", "config.json not found; the shell falls back to config.example.json (the sample "
                                   "character and the sample endpoints)",
                None)
    else:
        rep.add("WARN", "config", "GET /config.json answered %s; the shell falls back to config.example.json" % status)
    if loaded is None:
        status, _, raw = http("GET", base + "/config.example.json")
        example, _ = parse_json(raw) if status == 200 else (None, None)
        if isinstance(example, dict):
            loaded = example
            rep.add("INFO", "config", "using config.example.json (copy it to config.json and edit it to make it yours)")
        else:
            loaded = {}
            rep.add("INFO", "config", "no config.example.json either; using the shell's built-in defaults")
    effective = dict(HARD_DEFAULTS)
    effective.update(loaded)
    return effective, loaded


def check_shell(base, rep):
    status, _, body = http("GET", base + "/")
    if status is None:
        rep.add("FAIL", "shell", "no HTTP answer from %s (%s)" % (base, body.decode() if isinstance(body, bytes) else body),
                "start the server that serves engine/ and pass its address, e.g. http://127.0.0.1:8400")
        return False
    if status == 200 and b"js/app.js" in body:
        rep.add("PASS", "shell", "index.html is served at /")
    else:
        rep.add("FAIL", "shell", "GET / answered %s without EverOtome's index.html" % status,
                "serve the engine/ folder at the root of this origin (index.html at /)")
    status, _, _ = http("GET", base + "/js/app.js")
    if status != 200:
        rep.add("FAIL", "shell", "GET /js/app.js answered %s" % status,
                "files under engine/ must be reachable by their relative paths")
    return True


def check_chat(base, cfg, loaded, args, rep):
    ws_path = cfg.get("wsEndpoint")
    if not isinstance(ws_path, str) or not ws_path.startswith("/"):
        rep.add("FAIL", "websocket", "wsEndpoint is %r" % (ws_path,),
                "set \"wsEndpoint\" to a same-origin path such as \"/ws\"; " + ONE_ORIGIN)
        return
    try:
        ws = WsClient(base, ws_path, timeout=15)
    except (WsError, OSError) as e:
        rep.add("FAIL", "websocket", "no WebSocket at %s (%s)" % (ws_path, e), ONE_ORIGIN)
        return
    rep.add("PASS", "websocket", "connected at %s" % ws_path)
    started = time.monotonic()
    deadline = started + args.timeout
    seen = []
    try:
        ws.send_text(args.message)
        while True:
            text = ws.recv_text(deadline)
            if text is None:
                rep.add("FAIL", "chat", "no assistant frame within %g s (frames seen: %s)"
                        % (args.timeout, ", ".join(seen) or "none"),
                        "answer every message with {\"role\": \"assistant\", \"text\": \"...\"}; partial and status frames "
                        "do not close the turn; raise --timeout if the companion is slow")
                return
            frame, err = parse_json(text.encode("utf-8"))
            if err is not None or not isinstance(frame, dict):
                rep.add("WARN", "chat", "a non-JSON frame arrived and would be ignored by the shell: %r" % text[:80])
                continue
            role = frame.get("role")
            if role == "assistant":
                ok, notes = check_assistant_frame(frame)
                for level, note, fix in notes:
                    rep.add(level, "chat", note, fix)
                if ok:
                    rep.add("PASS", "chat", "reply in %.1f s: %s" % (time.monotonic() - started, _short(frame["text"])))
                return
            seen.append(str(role))
            if frame.get("room"):
                rep.add("WARN", "chat", "a %r frame carries \"room\" and would be dropped by the shell" % role)
    except WsClosed:
        rep.add("FAIL", "chat", "the server closed the socket before an assistant frame arrived (frames seen: %s)"
                % (", ".join(seen) or "none"),
                "keep the socket open and answer on it; look for an exception in the server's message handler")
    except OSError as e:
        rep.add("FAIL", "chat", "the socket failed: %s" % e, "check the server log")
    finally:
        ws.close()


def _short(text, limit=70):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit] + "..."


def check_history(base, cfg, rep):
    path = cfg.get("historyEndpoint")
    if not isinstance(path, str) or not path:
        rep.add("INFO", "history", "no historyEndpoint: the Chat Log opens blank on each load (fine)")
        return
    status, _, raw = http("GET", base + path)
    if status == 200:
        data, err = parse_json(raw)
        if err is not None:
            rep.add("FAIL", "history", "%s answered 200 but not JSON (%s)" % (path, err),
                    "answer {\"entries\": [...]} as JSON")
            return
        level, text, fix = check_history_body(data)
        rep.add(level, "history", text, fix)
    elif status == 404:
        rep.add("WARN", "history", "%s answered 404: the Chat Log opens blank and the console logs an error" % path,
                None)
    else:
        rep.add("WARN", "history", "%s answered %s" % (path, status))


def check_voice(base, cfg, loaded, args, rep):
    path = cfg.get("ttsEndpoint")
    if path == "":
        rep.add("INFO", "voice", "ttsEndpoint is empty: voice off, no play buttons")
        return
    absent = "ttsEndpoint" not in loaded
    where = "%s%s" % (path, " (ttsEndpoint is absent from config, so the shell uses this default path)" if absent else "")
    if args.skip_tts:
        rep.add("INFO", "voice", "not probed (--skip-tts); the shell would POST to %s" % where)
        return
    if not isinstance(path, str) or not path.startswith("/"):
        rep.add("WARN", "voice", "ttsEndpoint is %r" % (path,))
        return
    status, headers, body = http("POST", base + path, body=json.dumps({"text": "Hi."}).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, timeout=30)
    if status is not None and 200 <= status < 300 and body:
        rep.add("PASS", "voice", "%s answered audio (%s, %d bytes)" % (path, headers.get("Content-Type", "?"), len(body)))
    elif status == 429:
        rep.add("WARN", "voice", "%s answered 429: the shell shows the daily-cap notice" % path)
    else:
        rep.add("WARN", "voice", "%s answered %s: every reply shows a play button that cannot produce sound"
                % (where, status if status is not None else "nothing (%s)" % body),
                None)
        print("       hint: set \"ttsEndpoint\": \"\" in config.json to hide the buttons, or implement "
              "POST {\"text\": ...} -> audio there")


def check_photos(base, cfg, rep):
    path = cfg.get("photoEndpoint")
    if not isinstance(path, str) or not path.startswith("/"):
        rep.add("WARN", "photos", "photoEndpoint is %r" % (path,))
        return
    status, _, body = http("POST", base + path, body=b"", timeout=15)
    if status == 404:
        rep.add("INFO", "photos", "%s answered 404: the paperclip reports \"feature not enabled\" when used (fine)" % path)
    elif status in (400, 415, 422):
        rep.add("PASS", "photos", "%s answers (%s to an empty upload; no file was uploaded)" % (path, status))
    elif status == 405:
        rep.add("WARN", "photos", "%s answered 405, which the shell shows as \"upload failed\"" % path)
        print("       hint: answer 404 when photos are not supported")
    elif status is not None and 200 <= status < 300:
        rep.add("WARN", "photos", "%s answered %s to an empty upload" % (path, status))
        print("       hint: real uploads must answer {\"photo_id\": \"...\"}; reject empty ones with 400")
    else:
        rep.add("WARN", "photos", "%s answered %s" % (path, status if status is not None else "nothing (%s)" % body))


def check_phone(base, rep):
    status, _, raw = http("GET", base + "/api/call/log", timeout=15)
    if status == 200:
        data, err = parse_json(raw)
        if err is None and isinstance(data, dict):
            silence = (data.get("config") or {}).get("silence_sec") if isinstance(data.get("config"), dict) else None
            rep.add("PASS", "phone", "phone backend present (/api/call/log, silence_sec=%s)" % silence)
        else:
            rep.add("WARN", "phone", "/api/call/log answered 200 but not a JSON object")
    elif status == 404:
        rep.add("INFO", "phone", "no phone backend (/api/call/log is 404): the phone button shows an error when pressed, "
                                 "which is expected without one")
    else:
        rep.add("WARN", "phone", "/api/call/log answered %s" % (status if status is not None else "nothing (%s)" % raw))


def check_album(base, cfg, rep):
    path = cfg.get("cgEndpoint")
    if not isinstance(path, str) or not path:
        rep.add("INFO", "album", "no cgEndpoint: no album button (fine)")
        return
    status, _, raw = http("GET", base + path + "/album", timeout=15)
    if status == 200:
        data, err = parse_json(raw)
        if err is not None:
            rep.add("FAIL", "album", "%s/album answered 200 but not JSON (%s)" % (path, err),
                    "answer {\"items\": [...]} as JSON, or remove cgEndpoint from config.json")
            return
        level, text, fix = check_album_body(data)
        rep.add(level, "album", text, fix)
    else:
        rep.add("FAIL", "album", "%s/album answered %s: the album button opens a broken album"
                % (path, status if status is not None else "nothing (%s)" % raw),
                "serve %s/album (docs/cg-guide.md) or remove cgEndpoint from config.json (the button disappears)" % path)


def check_chat_clear(base, rep):
    status, _, raw = http("GET", base + "/api/v4/chat-clear", timeout=15)
    if status == 200:
        data, err = parse_json(raw)
        if err is None and isinstance(data, dict) and isinstance(data.get("cleared_at"), str):
            rep.add("PASS", "chat-clear", "cross-device clear line is served")
        else:
            rep.add("WARN", "chat-clear", "/api/v4/chat-clear answered 200 without {\"cleared_at\": \"...\"}")
    elif status == 404:
        rep.add("INFO", "chat-clear", "not implemented (404): the shell keeps a per-device clear line (fine)")
    else:
        rep.add("INFO", "chat-clear", "/api/v4/chat-clear answered %s" % (status if status is not None else "nothing"))


def run_checks(args):
    base = args.url.rstrip("/")
    rep = Report()
    print("check_integration: %s" % base)
    if check_shell(base, rep):
        cfg, loaded = load_effective_config(base, rep)
        check_chat(base, cfg, loaded, args, rep)
        check_history(base, cfg, rep)
        check_voice(base, cfg, loaded, args, rep)
        check_photos(base, cfg, rep)
        check_phone(base, rep)
        check_album(base, cfg, rep)
        check_chat_clear(base, rep)
    c = rep.counts
    print("")
    if rep.failed():
        print("RESULT: FAIL (%d failed, %d warnings, %d passed). %s" % (c["FAIL"], c["WARN"], c["PASS"], FEEDBACK))
        return 1
    print("RESULT: PASS (%d passed, %d warnings)" % (c["PASS"], c["WARN"]))
    return 0


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise SystemExit("[abort] %s. Run with --help for usage. %s" % (message, FEEDBACK))


def build_parser():
    p = _Parser(prog="check_integration.py",
                description="Check a server that hosts EverOtome: is the shell served, does the WebSocket answer "
                            "a message with a well-formed reply, do the optional endpoints have the right shape.")
    p.add_argument("url", help="the address you open in the browser, e.g. http://127.0.0.1:8400")
    p.add_argument("--message", default=DEFAULT_MESSAGE,
                   help="the one chat message to send (the companion may remember it)")
    p.add_argument("--timeout", type=float, default=60,
                   help="seconds to wait for the reply (default 60)")
    p.add_argument("--skip-tts", action="store_true",
                   help="do not POST a short line to the text-to-speech endpoint")
    return p


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    args = build_parser().parse_args(argv)
    u = urlsplit(args.url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise SystemExit("[abort] the address must start with http:// or https://, got %r. %s" % (args.url, FEEDBACK))
    if args.timeout <= 0:
        raise SystemExit("[abort] --timeout must be a positive number of seconds. %s" % FEEDBACK)
    return run_checks(args)


if __name__ == "__main__":
    sys.exit(main())
