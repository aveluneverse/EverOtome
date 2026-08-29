# -*- coding: utf-8 -*-
"""Everthine adapter for EverOtome's http-bridge.

Wraps Everthine's produce_reply() as one HTTP route, POST /reply, so the bridge can relay chat to the
companion that already lives in Everthine. Nothing inside Everthine is modified: this script only imports
it from the folder you run it in (the one with run.py), reads the same .env, and uses the same data folder.

    cd "<your Everthine folder>"
    python "<path to EverOtome>/examples/everthine-adapter/companion_server.py"
    python "<path to EverOtome>/examples/everthine-adapter/companion_server.py" --with-telegram

Without --with-telegram this serves HTTP only: stop run.py first, because two processes would fight over
the session file and the Claude CLI. With --with-telegram the Telegram bot runs inside this same process,
so Telegram and EverOtome share one conversation and one engine lock.

Wire protocol (the bridge's): POST /reply {"text": "..."} -> {"text": "...", "system": "..."}. A reaction
the companion attached to your message comes back as EverOtome's [react:<emoji>] marker at the head of the
text; Everthine's system notices (a full notebook, for instance) come back in "system".
Standard library only; runs on whatever Python runs Everthine.
"""
import argparse
import json
import logging
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FEEDBACK = "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup"


def _short(text, limit=70):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit] + "..."


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise SystemExit("[abort] %s. Run with --help for usage. %s" % (message, FEEDBACK))


def build_parser():
    p = _Parser(prog="companion_server.py",
                description="Expose an Everthine companion as POST /reply for EverOtome's http-bridge. "
                            "Run it from your Everthine folder.")
    p.add_argument("--host", default="127.0.0.1", help="address to listen on (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8401, help="port to listen on (default 8401)")
    p.add_argument("--with-telegram", action="store_true",
                   help="also run Everthine's Telegram bot in this process (one conversation, two channels)")
    return p


def load_everthine():
    """Import Everthine from the current folder. Returns (engine, bot, load_config, ConfigError, SessionStore)."""
    sys.path.insert(0, os.getcwd())
    try:
        from everthine import bot, engine
        from everthine.config import ConfigError, load_config
        from everthine.session_store import SessionStore
    except ImportError as e:
        raise SystemExit("[abort] run this from your Everthine folder (the one with run.py); Everthine could not "
                         "be imported here (%s). %s" % (e, FEEDBACK))
    return engine, bot, load_config, ConfigError, SessionStore


def make_handler(cfg, store, produce_reply):
    lock = threading.Lock()  # one reply at a time on this route; across channels the Claude CLI is serialized by Everthine's own engine._reply_lock

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def _json(self, status, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            body = b"everthine adapter is running; POST /reply with {\"text\": \"...\"}\n"
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
            if data.get("command") == "new":
                self._json(200, {"text": "", "system": "Everthine keeps one continuous conversation; "
                                                        "there is nothing to reset."})
                return
            react = {}
            extras = []
            try:
                with lock:
                    chunks = produce_reply(cfg, store, text,
                                           on_react=lambda emoji: react.update(emoji=emoji),
                                           on_extra=extras.append)
            except Exception as e:  # Everthine's own failure lines come back as text; this is the unexpected rest
                traceback.print_exc()
                self._json(500, {"detail": "produce_reply raised %s: %s" % (type(e).__name__, e)})
                return
            reply = "\n\n".join(c for c in chunks if c)
            if react.get("emoji"):
                reply = "[react:%s]%s" % (react["emoji"], reply)
            out = {"text": reply}
            if extras:
                out["system"] = "\n".join(extras)
            print("[adapter] %s -> %s" % (_short(text), _short(reply)))
            self._json(200, out)

    return Handler


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace", line_buffering=True)
    args = build_parser().parse_args(argv)
    engine, bot, load_config, ConfigError, SessionStore = load_everthine()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    getattr(bot, "_install_token_mask_filter", lambda: None)()
    try:
        cfg = load_config()
    except ConfigError as e:
        raise SystemExit("[abort] %s %s" % (e, FEEDBACK))
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    cfg.engine_home.mkdir(parents=True, exist_ok=True)
    if not engine.check_claude_available(cfg):
        raise SystemExit("[abort] the Claude Code CLI did not answer (CLAUDE_CMD is %s). %s"
                         % (" ".join(cfg.claude_cmd), FEEDBACK))
    store = SessionStore(cfg.session_path)
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), make_handler(cfg, store, bot.produce_reply))
    except OSError as e:
        raise SystemExit("[abort] could not listen on %s:%d (%s); pass --port <another port>. %s"
                         % (args.host, args.port, e, FEEDBACK))
    httpd.daemon_threads = True
    print("[adapter] POST http://%s:%d/reply -> Everthine (data in %s)" % (args.host, args.port, cfg.data_dir))
    if args.with_telegram:
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        print("[adapter] Telegram bot starting in this process; Ctrl+C stops both")
        app = bot.make_app(cfg)
        allowed = getattr(bot, "_allowed_updates", None)  # private helper; fall back to PTB's default list if it goes away
        if allowed is not None:
            app.run_polling(allowed_updates=allowed(cfg))
        else:
            app.run_polling()
        return
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("[adapter] stopped")


if __name__ == "__main__":
    main()
