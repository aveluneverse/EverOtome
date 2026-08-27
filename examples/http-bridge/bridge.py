# -*- coding: utf-8 -*-
"""EverOtome HTTP bridge: one file, no dependencies.

It serves the engine/ folder, accepts the shell's WebSocket at /ws, and turns every chat message into
one HTTP POST to your companion:

    POST <reply url>   {"text": "<what the user typed>"}     ->     {"text": "<the companion's reply>"}

Optional keys in the answer: "thoughts" (a string shown behind the Thinking button) and "system" (one
notice line in the Chat Log). Empty "text" puts nothing on the screen. The two MENU commands travel the
same way: /new is posted as {"text": "/new", "command": "new"} (reset your session if you like, or
answer with empty text); /status is answered by the bridge itself and never reaches the companion.

The bridge keeps a small in-memory ledger so the Chat Log has scrollback within one run (served at
/api/history); it is gone when the bridge stops. Photos, voice, phone calls and CG management are not
relayed: those endpoints answer 404, which the shell reports as "feature not enabled". Set
"ttsEndpoint": "" in engine/config.json so no silent play buttons appear.

Usage (from the repository root):
    python examples/http-bridge/bridge.py --reply http://127.0.0.1:8401/reply
Then open http://127.0.0.1:8400/ in the browser.

Python 3.7 or newer, standard library only.
"""
import argparse
import base64
import hashlib
import json
import struct
import sys
import threading
import time
from datetime import datetime, timezone
from http.client import HTTPException
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

FEEDBACK = "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HERE = Path(__file__).resolve().parent
DEFAULT_ENGINE = HERE.parent.parent / "engine"
LEDGER_LIMIT = 200


class BridgeError(Exception):
    """A companion-side problem, reported to the screen as one system line."""


def _short(text, limit=70):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit] + "..."


class Ledger:
    """In-memory chat history served at the history path, oldest first, capped."""

    def __init__(self, limit=LEDGER_LIMIT):
        self._entries = []
        self._limit = limit
        self._lock = threading.Lock()

    def add(self, speaker, text):
        entry = {"ts": datetime.now(timezone.utc).isoformat(), "speaker": speaker, "text": text}
        with self._lock:
            self._entries.append(entry)
            del self._entries[:-self._limit]

    def snapshot(self):
        with self._lock:
            return list(self._entries)


class Companion:
    """One HTTP POST per message."""

    def __init__(self, url, timeout):
        self.url = url
        self.timeout = timeout
        self.relayed = 0

    def ask(self, text, command=None):
        body = {"text": text}
        if command:
            body["command"] = command
        req = urlrequest.Request(self.url, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urlrequest.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
        except HTTPError as e:
            raise BridgeError("the companion answered HTTP %d" % e.code)
        except URLError as e:
            raise BridgeError("could not reach the companion at %s (%s)" % (self.url, e.reason))
        except HTTPException as e:
            raise BridgeError("the companion's HTTP answer could not be read (%s)" % e)
        except OSError as e:
            raise BridgeError("no answer from the companion at %s (%s)" % (self.url, e))
        try:
            data = json.loads(raw.decode("utf-8"))
        except ValueError:
            raise BridgeError("the companion did not answer with JSON")
        if not isinstance(data, dict) or not isinstance(data.get("text"), str):
            raise BridgeError("the companion's JSON has no \"text\" string")
        self.relayed += 1
        return data


def ws_accept_key(client_key):
    digest = hashlib.sha1((client_key.strip() + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def ws_read_frame(rfile):
    """One frame from the client: (fin, opcode, payload), or None once the socket is closed."""
    head = rfile.read(2)
    if len(head) < 2:
        return None
    fin = bool(head[0] & 0x80)
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F
    if length == 126:
        length = struct.unpack(">H", rfile.read(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", rfile.read(8))[0]
    mask = rfile.read(4) if masked else None
    payload = rfile.read(length) if length else b""
    if len(payload) < length:
        return None
    if mask:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return fin, opcode, payload


def ws_frame(opcode, payload):
    """A server frame (never masked)."""
    head = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += bytes([126]) + struct.pack(">H", n)
    else:
        head += bytes([127]) + struct.pack(">Q", n)
    return head + payload


class BridgeHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # filled in by main() before the server starts
    engine_dir = None
    ws_path = "/ws"
    history_path = "/api/history"
    companion = None
    ledger = None

    def __init__(self, *args, **kwargs):
        self._upgraded = False
        super().__init__(*args, directory=str(self.engine_dir), **kwargs)

    def log_message(self, fmt, *args):
        pass  # the bridge prints its own lines; per-request access logs would drown them

    def end_headers(self):
        if not self._upgraded:
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _drain_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        while length > 0:
            chunk = self.rfile.read(min(length, 65536))
            if not chunk:
                break
            length -= len(chunk)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == self.ws_path:
            if "websocket" not in (self.headers.get("Upgrade") or "").lower():
                self._send_json(426, {"detail": "this path expects a WebSocket upgrade"})
                return
            key = self.headers.get("Sec-WebSocket-Key")
            if not key:
                self._send_json(400, {"detail": "missing Sec-WebSocket-Key"})
                return
            self._upgraded = True
            self.close_connection = True
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", ws_accept_key(key))
            self.end_headers()
            self._ws_loop()
            return
        if path == self.history_path:
            self._send_json(200, {"entries": self.ledger.snapshot()})
            return
        super().do_GET()

    def do_POST(self):
        # Nothing is relayed by POST: photos, phone calls, voice and CG management stay unwired.
        # 404 is the answer the shell reads as "feature not enabled". Drain first so keep-alive stays clean.
        self._drain_body()
        self._send_json(404, {"detail": "not relayed by the EverOtome http-bridge: " + self.path})

    def _ws_write(self, opcode, payload):
        try:
            self.wfile.write(ws_frame(opcode, payload))
            self.wfile.flush()
        except OSError:
            pass  # the browser went away; the read loop will notice next

    def _ws_send(self, obj):
        self._ws_write(0x1, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _ws_loop(self):
        parts = []
        while True:
            try:
                frame = ws_read_frame(self.rfile)
            except (OSError, struct.error, ValueError):
                frame = None
            if frame is None:
                return
            fin, opcode, payload = frame
            if opcode == 0x8:
                self._ws_write(0x8, payload[:2])
                return
            if opcode == 0x9:
                self._ws_write(0xA, payload)
                continue
            if opcode in (0xA, 0x2):
                continue
            parts.append(payload)
            if not fin:
                continue
            text = b"".join(parts).decode("utf-8", "replace")
            parts = []
            self._handle_text(text)

    def _handle_text(self, raw):
        text, command, note = raw, None, None
        if raw.startswith("{"):
            try:
                obj = json.loads(raw)
            except ValueError:
                obj = None
            if isinstance(obj, dict) and isinstance(obj.get("text"), str):
                text = obj["text"]
                if obj.get("photos"):
                    note = "(photos are not relayed by this bridge; only the caption was sent)"
        if text == "/status":
            self._ws_send({"role": "system", "text": "bridge online: forwarding to %s, %d replies so far"
                           % (self.companion.url, self.companion.relayed)})
            return
        if text.startswith("/cg "):
            self._ws_send({"role": "system", "text": "(scene changes need a backend that answers /cg with a "
                                                     "cg_state frame; this bridge relays chat only)"})
            return
        if text == "/new":
            command = "new"
        else:
            self.ledger.add("User", text)
        if note:
            self._ws_send({"role": "system", "text": note})
        started = time.monotonic()
        print("[bridge] -> %s" % _short(text))
        try:
            data = self.companion.ask(text, command)
        except BridgeError as e:
            print("[bridge] !! %s" % e)
            self._ws_send({"role": "system", "text": "bridge: %s. %s" % (e, FEEDBACK)})
            return
        reply = data["text"]
        print("[bridge] <- %.1fs %s" % (time.monotonic() - started, _short(reply)))
        if reply.strip():
            frame = {"role": "assistant", "text": reply}
            if isinstance(data.get("thoughts"), str) and data["thoughts"].strip():
                frame["thoughts"] = data["thoughts"]
            self._ws_send(frame)
            self.ledger.add("Assistant", reply)
        elif command is None:
            self._ws_send({"role": "system", "text": "(the companion sent nothing back)"})
        system = data.get("system")
        if isinstance(system, str) and system.strip():
            self._ws_send({"role": "system", "text": system})
            self.ledger.add("System", system)


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise SystemExit("[abort] %s. Run with --help for usage. %s" % (message, FEEDBACK))


def build_parser():
    p = _Parser(prog="bridge.py",
                description="Serve EverOtome's engine/ and relay its chat WebSocket to a companion over HTTP: "
                            "POST {\"text\": ...} in, {\"text\": ...} out.")
    p.add_argument("--reply", required=True, metavar="URL",
                   help="the companion's reply endpoint, e.g. http://127.0.0.1:8401/reply")
    p.add_argument("--engine", default=str(DEFAULT_ENGINE), metavar="PATH",
                   help="EverOtome's engine/ folder (default: the one in this repository)")
    p.add_argument("--host", default="127.0.0.1", help="address to listen on (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8400, help="port to listen on (default 8400)")
    p.add_argument("--ws-path", default="/ws", help="WebSocket path, must match wsEndpoint in config.json (default /ws)")
    p.add_argument("--history-path", default="/api/history",
                   help="path that serves this run's chat history (default /api/history)")
    p.add_argument("--reply-timeout", type=float, default=120,
                   help="seconds to wait for the companion's answer (default 120)")
    return p


def config_notes(engine, args):
    """Print notes about engine/config.json that would otherwise show up as silent misbehaviour."""
    cfg_path = engine / "config.json"
    if not cfg_path.is_file():
        print("[bridge] note: %s not found; the shell uses config.example.json (the sample character). "
              "Copy it to config.json to make it yours." % cfg_path)
        return
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except ValueError:
        print("[bridge] note: config.json is not valid JSON; the shell falls back to config.example.json")
        return
    if cfg.get("wsEndpoint") != args.ws_path:
        print("[bridge] note: config.json has \"wsEndpoint\": %r but the bridge listens at %s; change one of them"
              % (cfg.get("wsEndpoint"), args.ws_path))
    if isinstance(cfg.get("historyEndpoint"), str) and cfg["historyEndpoint"] and cfg["historyEndpoint"] != args.history_path:
        print("[bridge] note: config.json has \"historyEndpoint\": %r but the bridge serves history at %s"
              % (cfg["historyEndpoint"], args.history_path))
    if cfg.get("ttsEndpoint", None) != "":
        print("[bridge] note: set \"ttsEndpoint\": \"\" in config.json; the bridge has no voice, so every reply "
              "would otherwise show a play button that stays silent")


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace", line_buffering=True)
    args = build_parser().parse_args(argv)
    engine = Path(args.engine).resolve()
    if not (engine / "index.html").is_file() or not (engine / "js" / "app.js").is_file():
        raise SystemExit("[abort] %s is not EverOtome's engine/ folder (index.html and js/app.js expected). "
                         "Pass --engine <path to engine>. %s" % (engine, FEEDBACK))
    if not args.reply.startswith(("http://", "https://")):
        raise SystemExit("[abort] --reply must be an http(s) URL, got %r. %s" % (args.reply, FEEDBACK))
    if not args.ws_path.startswith("/") or not args.history_path.startswith("/"):
        raise SystemExit("[abort] --ws-path and --history-path must start with /. %s" % FEEDBACK)
    BridgeHandler.engine_dir = engine
    BridgeHandler.ws_path = args.ws_path
    BridgeHandler.history_path = args.history_path
    BridgeHandler.companion = Companion(args.reply, args.reply_timeout)
    BridgeHandler.ledger = Ledger()
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    except OSError as e:
        raise SystemExit("[abort] could not listen on %s:%d (%s); pass --port <another port>. %s"
                         % (args.host, args.port, e, FEEDBACK))
    httpd.daemon_threads = True
    config_notes(engine, args)
    print("[bridge] serving %s" % engine)
    print("[bridge] open http://%s:%d/ in the browser" % (args.host, args.port))
    print("[bridge] chat goes to %s (WebSocket at %s, history at %s)" % (args.reply, args.ws_path, args.history_path))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("[bridge] stopped")


if __name__ == "__main__":
    main()
