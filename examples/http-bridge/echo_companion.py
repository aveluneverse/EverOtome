# -*- coding: utf-8 -*-
"""A stand-in companion that proves the bridge pipeline end to end.

    POST /reply   {"text": "hello"}   ->   {"text": "You said: hello"}

It has no brain, no persona and no memory; replace it with your own server once the bridge works.
Usage: python examples/http-bridge/echo_companion.py [--port 8401]
Python 3.7 or newer, standard library only.
"""
import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FEEDBACK = "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup"


class EchoHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        body = b"echo companion is running; POST /reply with {\"text\": \"...\"}\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/reply":
            self._json(404, {"detail": "POST /reply only"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            self._json(400, {"detail": "the body must be JSON"})
            return
        text = data.get("text") if isinstance(data, dict) else None
        if not isinstance(text, str):
            self._json(400, {"detail": "expected {\"text\": \"...\"}"})
            return
        reply = "(new conversation)" if data.get("command") == "new" else "You said: " + text
        print("[echo] %r -> %r" % (text[:60], reply[:60]))
        self._json(200, {"text": reply})


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise SystemExit("[abort] %s. Run with --help for usage. %s" % (message, FEEDBACK))


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace", line_buffering=True)
    p = _Parser(prog="echo_companion.py", description="Echo companion for the EverOtome http-bridge: POST /reply echoes the text back.")
    p.add_argument("--host", default="127.0.0.1", help="address to listen on (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8401, help="port to listen on (default 8401)")
    args = p.parse_args(argv)
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), EchoHandler)
    except OSError as e:
        raise SystemExit("[abort] could not listen on %s:%d (%s); pass --port <another port>. %s"
                         % (args.host, args.port, e, FEEDBACK))
    httpd.daemon_threads = True
    print("[echo] POST http://%s:%d/reply" % (args.host, args.port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("[echo] stopped")


if __name__ == "__main__":
    main()
