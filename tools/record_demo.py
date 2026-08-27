# -*- coding: utf-8 -*-
"""record_demo.py — EverOtome demo 導覽影片錄製。

流程：自起 engine/serve.py（no-store）→ 每段開 demo/tour.html?seg=<段名> →
等 document.title === "TOUR-DONE" → 存 webm。產物預設落 repo 根 recordings/
（不進 git；`--out <dir>` 可改落點，相對路徑以 repo 根為準，例如 `--out recordings/0819`）。各段中途截一張 check PNG 供功能驗證（非黑屏／版式正確）；
視覺品質驗收請看影片本身。

段落與裝置（每段只錄歸屬裝置）：
  chat / appearance / cg / phone / settings  → 桌機 1536×768（2:1）
  cg-manage                                  → 桌機 1536×768（CG 相冊管理態展示：扳手→下拉→分組→返回）
  expressions / room / thinking              → 桌機 1536×768（8/18 加碼：表情臉紅／房間
                                                 自主權／Thinking 鈕）
  lab                                        → 桌機 1536×768，不走 tour.html：直接開
                                                 demo/expression-lab.html 逐鈕點（先開口
                                                 講話→邊講邊笑→邊講邊臉紅兩級→收），
                                                 時間軸在本檔
  mobile-chat / mobile-cg                    → 手機 390×844（video 與 viewport 1:1
                                                 滿幅；device_scale_factor=2 只加持
                                                 check png，780×1688 高清）

用法：python tools/record_demo.py            # 錄全部段
     python tools/record_demo.py cg          # 只錄某段
     python tools/record_demo.py --shots     # 不錄影：桌機＋手機各拍一張 2x 截圖
                                             #（shot-desktop-*.png 3072×1536／
                                             #  shot-mobile-*.png 780×1688）
     python tools/record_demo.py --lang en          # 指定語系：tour 附 &lang=en、
     python tools/record_demo.py --lang en lab       # lab 附 ?lang=en、shots 同；
     python tools/record_demo.py cg --lang en        # 與段名／--shots 併用、
                                             # 前後皆可；不給 --lang 時 URL／檔名
                                             # 與改動前逐字相同；允許值見
                                             # LANG_ALLOWLIST（不在表中即中止，
                                             # 訊息附可用值）
需求：pip install playwright && playwright install chromium
"""
import os
import shutil
import subprocess
import sys
import time

# playwright 的 import 刻意不放這裡（模組載入層級）——`--help`／段名打錯這類
# 完全不需要開瀏覽器的路徑，不該連 pip install playwright 都沒做就先炸掉。
# 真正的 import 挪到 main() 裡、緊貼著第一次呼叫 sync_playwright() 之前
# （見 test_record_demo_help.py：用 `python -S` 關掉 site-packages 驗證這件事）。

# Windows 主控台常用非 UTF-8 codepage（如 cp950）；報告裡的符號字元（如 ⚠）
# 遇不可編碼字元會讓 print() 丟 UnicodeEncodeError、把整支腳本中止在最後的
# 結果彙總——恰好發生在「有東西要回報」的當下。改用 errors="replace" 讓彙總
# 一定印得完，不因終端機編碼把已經錄好的結果判定為失敗。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ENGINE = os.path.join(REPO, "engine")
OUT_DIR = os.path.join(REPO, "recordings")
PORT = 8643
BASE_URL = f"http://127.0.0.1:{PORT}/demo/tour.html"
LAB_URL = f"http://127.0.0.1:{PORT}/demo/expression-lab.html"
TOUR_TIMEOUT_MS = 180_000  # 最長段（cg）實測 ~57s，寬放

# --lang 允許值：對齊 engine/js/i18n.js 的 SUPPORTED_LOCALES（殼那邊加語系，
# 這裡要跟著補，否則新語系會被下面的檢查擋掉）。選白名單而非照單全收——
# 打錯字（如 --lang eng）會直接產出「看起來正常、其實根本沒套語系」的
# 錄影／截圖，人不會馬上發現；擋在錄之前比事後肉眼抓漏更可靠。
LANG_ALLOWLIST = ("zh-Hant", "en")

DESKTOP = {"tag": "desktop", "viewport": {"width": 1536, "height": 768},
           "video": {"width": 1536, "height": 768}}
# 手機錄影尺寸的實測結論：Playwright 的 video 以 CSS viewport 尺寸擷取、只縮小
# 不放大——video 大於 viewport 就是灰邊 letterbox（device_scale_factor 影響不了
# video，實測 dsf=2 灰邊依舊）。故 video 一律與 viewport 1:1（390×844 滿幅）。
# dsf=2 仍保留：它讓 page.screenshot 的 check png 以 2x 實際像素輸出（780×1688
# 高清），供功能驗證看細節。手機專屬鍵，桌機不設＝桌機 context 行為零變化。
MOBILE = {"tag": "mobile", "viewport": {"width": 390, "height": 844},
          "device_scale_factor": 2,
          "video": {"width": 390, "height": 844}}

# 每段只錄歸屬裝置（桌機敘事段 vs 手機專屬段）
SEGMENTS = {
    "chat": DESKTOP,
    "appearance": DESKTOP,
    "cg": DESKTOP,
    "cg-manage": DESKTOP,
    "phone": DESKTOP,
    "settings": DESKTOP,
    "expressions": DESKTOP,
    "room": DESKTOP,
    "thinking": DESKTOP,
    "lab": DESKTOP,
    "mobile-chat": MOBILE,
    "mobile-cg": MOBILE,
}

# 中段截圖時點（功能驗證：畫面非黑＋版式對）——各段動作已展開的時刻
# （lab 段不在此：它的 check png 時點由 LAB_STEPS 裡的 ("shot",) 標記決定）
SHOT_AT_MS = {
    "chat": 9_000, "phone": 12_000, "appearance": 6_000, "settings": 5_500,
    "cg": 12_000, "cg-manage": 7_000, "mobile-chat": 8_000, "mobile-cg": 10_000,
    "expressions": 9_500, "room": 9_000, "thinking": 9_000,
}

# 試妝間段：不走 tour.html，這裡就是它的時間軸（毫秒＝停留給觀眾看的時間）。
# 鈕靠 data-* 選，跟頁面文字語系無關（英文版錄影同一支腳本）。
# 編排（8/18 看過首版後定的方向）：表情與臉紅都要「邊講話邊發生」才有活人感——
# 先開口，之後每一顆表情／臉紅鈕都在嘴還在動的時候按；講完才逐層收回。
# ("shot",) ＝ 在那一刻拍 check png（三排狀態疊在一起的畫面，功能驗證用）。
LAB_STEPS = [
    ("wait", 2600),                                        # 開場：房間背景、立繪 idle、面板全景
    ("click", '#row-talk button[data-talk="1"]', 2600),    # 先開口：平靜臉講話（嘴動、眨眼照常）
    ("click", '#row-expr button[data-expr="smile"]', 3200), # 講到一半笑了：眼換 smile、嘴照講
    ("click", '#row-blush button[data-blush="1"]', 2800),   # 邊講邊臉紅（mid）
    ("click", '#row-blush button[data-blush="2"]', 2800),   # 紅得更深（deep）：三排全亮
    ("shot",),                                             # check png：講話＋smile＋deep 三合一
    ("click", '#row-talk button[data-talk="0"]', 1800),    # 講完：嘴歸閉，笑與紅暈還掛著（三層各自獨立）
    ("click", '#row-blush button[data-blush="0"]', 1600),  # 紅暈退
    ("click", '#row-expr button[data-expr=""]', 2200),     # 平靜：貼片淡回、回到 idle
    ("wait", 800),
]

# 2x 截圖用的畫面時點（README「桌機與手機」段的定妝照）
SHOTS = {
    "desktop": {"seg": "thinking", "at_ms": 9_000, "viewport": {"width": 1536, "height": 768}},
    "mobile": {"seg": "mobile-chat", "at_ms": 8_000, "viewport": {"width": 390, "height": 844}},
}


def with_lang(url, lang):
    """lang 為 None／空字串時原樣回傳（與改動前逐字相同）；有值時接語系參數——
    tour URL 已帶 ?seg= 用 &，lab URL 沒 query 用 ?（本檔只有這兩種 URL 形狀，
    用「有沒有 ?」判斷已足夠、不必真的解析 query string）。"""
    if not lang:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}lang={lang}"


def build_name(*parts, lang, stamp, ext):
    """檔名組法：prefix 各段以 - 相接，lang 有值才插在 stamp 前面一段，
    lang=None 時與改動前逐字相同（stamp 前完全不插東西）。"""
    segs = list(parts)
    if lang:
        segs.append(lang)
    segs.append(stamp)
    return "-".join(segs) + "." + ext


# --help 文字（英文）。tools/tests/test_tools_messages_english.py 的 tokenizer 掃不到這裡：它只看
# print(...)／raise／argparse 參數括號裡的字面字串，而 print(USAGE) 傳的是變數；英文由
# test_record_demo_help.py 的「stdout 無 CJK」斷言釘住。段名清單直接從 SEGMENTS 這顆單一真相
# 拼出來，不另外抄一份會跟著漂移的清單。
USAGE = """usage: record_demo.py [segment | --shots] [--lang <code>] [--out <folder>]

  segment          one of: {segments} (omit to record every segment)
  --shots          skip recording; take one desktop + one mobile screenshot instead
  --lang <code>    locale to append to the demo URL, e.g. --lang en
  --out <folder>   output folder for recordings (default: recordings/, relative
                   to the repo root)
  -h, --help       show this message and exit

Requires: pip install playwright && playwright install chromium
""".format(segments="/".join(SEGMENTS))


def parse_args(argv):
    """回傳 (only, shots_only, lang, out)。--lang <code>／--out <dir> 可插在 positional
    前後皆可，解析掉後剩下的字串沿用改動前的邏輯（sys.argv[1] 是段名或 --shots 或缺）——
    不給這兩個旗標時這條路徑與改動前逐字相同。out 為 None＝預設 recordings/；相對路徑
    以 repo 根為準（例：--out recordings/0819＝按日期分夾）。"""
    if "-h" in argv or "--help" in argv:
        print(USAGE)
        raise SystemExit(0)
    lang = None
    out = None
    rest = []
    i = 0
    while i < len(argv):
        if argv[i] == "--lang":
            if i + 1 >= len(argv):
                raise SystemExit("[abort] --lang needs a locale code, e.g. --lang en")
            lang = argv[i + 1]
            i += 2
            continue
        if argv[i] == "--out":
            if i + 1 >= len(argv):
                raise SystemExit("[abort] --out needs a folder path, e.g. --out recordings/0819")
            out = argv[i + 1]
            i += 2
            continue
        rest.append(argv[i])
        i += 1
    if lang is not None and lang not in LANG_ALLOWLIST:
        raise SystemExit(f"[abort] unsupported locale code {lang!r} (available: {'/'.join(LANG_ALLOWLIST)})")
    only = rest[0] if rest else None
    return only, only == "--shots", lang, out


def run_lab(page, shot_path):
    """試妝間段的點按時間軸（頁面自己不演，錄影腳本當觀眾的手）。
    ("shot",) 標記走到時拍 check png 到 shot_path。"""
    for step in LAB_STEPS:
        kind = step[0]
        if kind == "wait":
            page.wait_for_timeout(step[1])
        elif kind == "shot":
            page.screenshot(path=shot_path)
        else:
            _, selector, hold = step
            page.click(selector)
            page.wait_for_timeout(hold)


def take_shots(browser, stamp, lang):
    """--shots：桌機／手機各一張 2x 截圖，不錄影。"""
    out = []
    for tag, spec in SHOTS.items():
        ctx = browser.new_context(viewport=spec["viewport"], device_scale_factor=2)
        page = ctx.new_page()
        page.goto(with_lang(f"{BASE_URL}?seg={spec['seg']}", lang))
        page.wait_for_timeout(spec["at_ms"])
        path = os.path.join(OUT_DIR, build_name("shot", tag, lang=lang, stamp=stamp, ext="png"))
        page.screenshot(path=path)
        ctx.close()
        out.append((tag, path, os.path.getsize(path)))
        print(f"[shot/{tag}] {os.path.basename(path)}")
    return out


def main():
    global OUT_DIR
    only, shots_only, lang, out = parse_args(sys.argv[1:])
    if out:
        OUT_DIR = out if os.path.isabs(out) else os.path.join(REPO, out)
    if shots_only:
        only = None
    if only is not None and only not in SEGMENTS:
        raise SystemExit(f"[abort] unknown segment {only!r} (available: {'/'.join(SEGMENTS)} or --shots)")
    targets = {} if shots_only else {k: v for k, v in SEGMENTS.items() if only is None or k == only}

    os.makedirs(OUT_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M")

    serve = subprocess.Popen(
        [sys.executable, os.path.join(ENGINE, "serve.py"), str(PORT)],
        cwd=ENGINE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(1.5)
        if serve.poll() is not None:
            raise SystemExit(f"[abort] serve.py did not start (is port {PORT} in use?)")

        # 真的要開瀏覽器這一刻才 import——上面所有 SystemExit 路徑
        # （--help／段名打錯／serve.py 沒起來）都不需要裝 playwright。
        from playwright.sync_api import sync_playwright

        results = []
        with sync_playwright() as p:
            # autoplay 放行：phone 段的重播 demo（play() 無使用者手勢）需要它
            browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
            if shots_only:
                for tag, path, size in take_shots(browser, stamp, lang):
                    results.append((f"shot-{tag}", "png", path, size, []))
            for seg, run in targets.items():
                tag, vp, vsize = run["tag"], run["viewport"], run["video"]
                video_tmp = os.path.join(OUT_DIR, f"_tmp-{seg}-{tag}")
                ctx_kwargs = {
                    "viewport": vp,
                    "record_video_dir": video_tmp,
                    "record_video_size": vsize,
                }
                dsf = run.get("device_scale_factor")
                if dsf:  # DESKTOP 無此鍵＝ None＝不傳，桌機 context 參數與改動前逐字相同
                    ctx_kwargs["device_scale_factor"] = dsf
                # 段級容錯：任一段中途出錯（逾時／page crash）不讓整支腳本中止
                # ——已錄完的段落彙總仍要印得出來、後續段照錄。
                ctx = None
                try:
                    ctx = browser.new_context(**ctx_kwargs)
                    page = ctx.new_page()
                    console_errors = []
                    page.on(
                        "console",
                        lambda m: console_errors.append(m.text) if m.type == "error" else None,
                    )
                    if seg == "lab":
                        # 試妝間：頁面不演戲，時間軸在本檔（LAB_STEPS）；check png 在
                        # 時間軸的 ("shot",) 標記那一刻拍
                        page.goto(with_lang(LAB_URL, lang))
                        shot = os.path.join(OUT_DIR, build_name("check", seg, tag, lang=lang, stamp=stamp, ext="png"))
                        run_lab(page, shot)
                        page.wait_for_timeout(600)
                    else:
                        page.goto(with_lang(f"{BASE_URL}?seg={seg}", lang))
                        page.wait_for_timeout(SHOT_AT_MS.get(seg, 6_000))
                        shot = os.path.join(OUT_DIR, build_name("check", seg, tag, lang=lang, stamp=stamp, ext="png"))
                        page.screenshot(path=shot)
                        page.wait_for_function(
                            "document.title === 'TOUR-DONE'", timeout=TOUR_TIMEOUT_MS
                        )
                        page.wait_for_timeout(600)
                    video = page.video
                    ctx.close()
                    src = video.path()
                    dst = os.path.join(OUT_DIR, build_name("demo", seg, tag, lang=lang, stamp=stamp, ext="webm"))
                    shutil.move(src, dst)
                    shutil.rmtree(video_tmp, ignore_errors=True)
                    noise = [e for e in console_errors if "favicon" not in e]
                    results.append((seg, tag, dst, os.path.getsize(dst), noise))
                    print(f"[{seg}/{tag}] done → {os.path.basename(dst)}")
                except Exception as e:
                    if ctx is not None:
                        try:
                            ctx.close()
                        except Exception:
                            pass
                    shutil.rmtree(video_tmp, ignore_errors=True)
                    results.append((seg, tag, None, 0, [f"[record-fail] {e}"]))
                    print(f"[{seg}/{tag}] FAILED: {e}")
                    continue

        print("\n=== recording done ===")
        for seg, tag, path, size, noise in results:
            if path is None:
                print(f"[{seg}/{tag}] FAILED  {noise}")
                continue
            print(f"[{seg}/{tag}] {path}  {size/1024/1024:.1f} MB")
            if noise:
                print(f"  ⚠ console errors ({len(noise)}): {noise[:3]}")
            else:
                print("  console clean")
    finally:
        serve.terminate()
        try:
            serve.wait(timeout=5)
        except Exception:
            serve.kill()


if __name__ == "__main__":
    main()
