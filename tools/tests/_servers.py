"""Helpers for the end-to-end tests under tools/tests: free ports, scripts started as background
servers, and a minimal RFC 6455 client (handshake, masked text frames out, server frames in).
Standard library only, like the scripts it tests."""
import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "engine"
BRIDGE = ROOT / "examples" / "http-bridge" / "bridge.py"
ECHO = ROOT / "examples" / "http-bridge" / "echo_companion.py"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url, timeout=20):
    """Poll until the URL answers any HTTP status; raise RuntimeError when it never does."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=2) as r:
                return r.status
        except HTTPError as e:
            return e.code
        except (URLError, OSError):
            time.sleep(0.15)
    raise RuntimeError("server did not come up: " + url)


@contextmanager
def server(cmd_args, ready_url, cwd=None):
    """Run `python <cmd_args...>` in the background until the block ends. Output goes to a temp file
    (a pipe would fill up and block a chatty server); it is shown when startup fails."""
    log = tempfile.TemporaryFile()
    proc = subprocess.Popen([sys.executable, *cmd_args], cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
    try:
        try:
            wait_http(ready_url)
        except RuntimeError:
            proc.kill()
            proc.wait()
            log.seek(0)
            raise RuntimeError("server did not start: %s\n%s" % (cmd_args, log.read().decode("utf-8", "replace")))
        yield proc
    finally:
        proc.kill()
        proc.wait()
        log.close()


@contextmanager
def bridge_stack(reply_url=None):
    """The bridge on a free port, fronting the echo companion (reply_url None) or the given URL.
    Yields the bridge port."""
    bridge_port = free_port()
    if reply_url is None:
        echo_port = free_port()
        with server([str(ECHO), "--port", str(echo_port)], "http://127.0.0.1:%d/" % echo_port):
            with server([str(BRIDGE), "--reply", "http://127.0.0.1:%d/reply" % echo_port,
                         "--engine", str(ENGINE), "--port", str(bridge_port)],
                        "http://127.0.0.1:%d/" % bridge_port):
                yield bridge_port
    else:
        with server([str(BRIDGE), "--reply", reply_url, "--engine", str(ENGINE), "--port", str(bridge_port)],
                    "http://127.0.0.1:%d/" % bridge_port):
            yield bridge_port


class WsProbe:
    """One WebSocket connection to 127.0.0.1:<port><path>."""

    def __init__(self, port, path="/ws", timeout=20):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        self.sock.sendall(("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\n"
                           "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
                           % (path, port, key)).encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            assert chunk, "the server closed the socket during the handshake"
            head += chunk
        self.status_line = head.split(b"\r\n", 1)[0].decode("ascii", "replace")
        expect = base64.b64encode(hashlib.sha1((key + GUID).encode("ascii")).digest())
        self.accept_ok = expect in head
        self.buf = head.split(b"\r\n\r\n", 1)[1]

    def send(self, text):
        payload = text.encode("utf-8")
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            head = bytes([0x81, 0x80 | n])
        else:
            head = bytes([0x81, 0x80 | 126]) + struct.pack(">H", n)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            assert chunk, "the server closed the socket"
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv_json(self):
        """The next text frame, parsed as JSON. Control frames are skipped; a close frame is an error."""
        while True:
            head = self._read(2)
            opcode = head[0] & 0x0F
            n = head[1] & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            data = self._read(n)
            if opcode == 0x1:
                return json.loads(data.decode("utf-8"))
            if opcode == 0x8:
                raise AssertionError("the server sent a close frame")

    def close(self):
        self.sock.close()
