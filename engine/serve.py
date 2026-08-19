# -*- coding: utf-8 -*-
"""本機預覽用 no-cache 靜態 server。

為什麼不用 `python -m http.server`：它不送任何 Cache-Control 頭，瀏覽器會對
ES module（js/*.js 的 import 鏈）套 heuristic 快取——改了檔案重新整理仍跑舊碼，
必須 Ctrl+F5 才醒（實測踩中）。這裡每個回應都帶
no-store，改完檔案按 F5 就是最新版。

用法：python serve.py [port]（預設 8300；工作目錄自動切到本檔所在的 engine/）
"""
import http.server
import os
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8300


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    print("serving (no-cache) on http://127.0.0.1:%d/" % PORT)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler).serve_forever()
