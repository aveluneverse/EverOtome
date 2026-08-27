# -*- coding: utf-8 -*-
"""make_cg_safe_zone.py: draw the CG safe-zone templates in docs/ (English and Traditional Chinese).

The templates are transparent RGBA overlays: drop one over your CG in an image editor and keep the
face inside the green box. The geometry was measured from the bundled layout (engine/css/layout.css).
If you change the layout, re-measure the boxes in DESKTOP / MOBILE below and re-run this script.

Usage:
  python tools/make_cg_safe_zone.py                   # all four files into docs/
  python tools/make_cg_safe_zone.py --out some/dir    # somewhere else
  python tools/make_cg_safe_zone.py --lang en         # only the English pair ("zh-Hant" for the Chinese pair)
  python tools/make_cg_safe_zone.py --font-cjk C:/Windows/Fonts/msjh.ttc --font-latin C:/Windows/Fonts/segoeui.ttf

The committed PNGs in docs/ were rendered with segoeui.ttf (Latin) and msjh.ttc (CJK) on Windows; other fonts reproduce the layout but not the exact pixels.

Output (into --out):
  cg-safe-zone-desktop.png, cg-safe-zone-mobile.png        English (the files docs/cg-guide.md embeds)
  cg-safe-zone-desktop-zh.png, cg-safe-zone-mobile-zh.png  Traditional Chinese

Adding a language: add a key to LABELS (same label keys as "en") and to FILE_SUFFIX, then run again.
"""
import argparse
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[1]
DOCS = REPO / "docs"

PINK = (255, 92, 120)
ORANGE = (255, 176, 82)
YELLOW = (255, 226, 96)
GREEN = (110, 235, 160)

INK_PINK = (214, 52, 88, 235)
INK_ORANGE = (196, 112, 26, 235)
INK_YELLOW = (150, 115, 0, 235)
INK_GREEN = (38, 150, 96, 255)
INK_FOOT = (0, 0, 0, 200)

# Shapes: ("fill", box, rgb, alpha) | ("stroke", box, rgb, alpha, width) | ("dot", (cx, cy), rgb, alpha, radius)
# box = (x0, y0, x1, y1) inclusive pixel coordinates. Drawn in list order (later shapes composite over earlier ones).
DESKTOP = {
    "size": (2560, 1440),
    "shapes": [
        ("fill", (3, 3, 2557, 169), YELLOW, 26),            # top 21:9 crop band
        ("fill", (3, 1270, 2557, 1437), YELLOW, 26),        # bottom 21:9 crop band
        ("fill", (3, 173, 114, 1266), YELLOW, 34),          # left margin
        ("fill", (2243, 173, 2557, 1266), YELLOW, 34),      # right margin
        ("fill", (185, 173, 317, 805), YELLOW, 34),         # strip beside the side buttons
        ("stroke", (0, 0, 2559, 1439), YELLOW, 235, 3),     # canvas border
        ("stroke", (185, 170, 1478, 805), YELLOW, 235, 2),  # the CG window that stays uncovered
        ("fill", (119, 810, 1437, 1412), ORANGE, 42),       # dialogue box (ADV)
        ("stroke", (115, 806, 1441, 1416), ORANGE, 235, 4),
        ("fill", (1483, 76, 2440, 1214), PINK, 52),         # Chat Log
        ("stroke", (1479, 72, 2444, 1218), PINK, 235, 4),
        ("fill", (1483, 1232, 2440, 1412), PINK, 52),       # input row
        ("stroke", (1479, 1228, 2444, 1416), PINK, 235, 4),
        ("fill", (42, 47, 180, 831), PINK, 40),             # side buttons column
        ("stroke", (38, 43, 184, 835), PINK, 235, 4),
        ("stroke", (384, 172, 1280, 720), GREEN, 255, 8),   # face sweet zone: 15-50% wide, 12-50% high
        ("dot", (768, 432), GREEN, 255, 14),                # suggested face center (30%, 30%)
    ],
    # Labels: (key, anchor, x, y, ink, font size). anchor "la" = left/top, "ma" = centered/top (PIL text anchors).
    # NOTE on "band"/"dot"/"footer" x/y: nudged from the plan's original values (band x 1050->700,
    # dot x/y 796/412->410/468, footer x/y 1280/1392->778/1360) after the Step 5 eyeball found the
    # English text at the original coordinates crossing the green/pink/orange box strokes (visible
    # strikethrough through the glyphs). Only x/y moved; shapes and label text are untouched.
    "labels": [
        ("side", "la", 200, 70, INK_PINK, 40),
        ("band", "la", 700, 70, INK_YELLOW, 38),
        ("sweet", "ma", 832, 112, INK_GREEN, 44),
        ("dot", "la", 410, 468, INK_GREEN, 38),
        ("chatlog", "ma", 1962, 108, INK_PINK, 44),
        ("adv", "la", 350, 840, INK_ORANGE, 44),
        ("input", "ma", 1962, 1302, INK_PINK, 40),
        ("footer", "ma", 778, 1360, INK_FOOT, 30),
    ],
}

MOBILE = {
    "size": (1440, 3120),
    "shapes": [
        ("fill", (3, 250, 285, 2635), YELLOW, 34),          # left margin (outside the centre 60%)
        ("fill", (1155, 250, 1437, 2635), YELLOW, 34),      # right margin
        ("fill", (0, 250, 2, 2635), YELLOW, 235),           # outer edge lines
        ("fill", (1438, 250, 1439, 2635), YELLOW, 235),
        ("fill", (286, 250, 288, 1309), YELLOW, 235),       # centre-60% guide lines down to the Chat Log
        ("fill", (1152, 250, 1154, 1309), YELLOW, 235),
        ("fill", (61, 1314, 1378, 2632), ORANGE, 42),       # Chat Log
        ("stroke", (57, 1310, 1382, 2635), ORANGE, 235, 4),
        ("fill", (4, 4, 1436, 245), PINK, 52),              # top badge + status bar
        ("stroke", (0, 0, 1439, 249), PINK, 235, 4),
        ("fill", (4, 2640, 1436, 3116), PINK, 52),          # input row + dock
        ("stroke", (0, 2636, 1439, 3119), PINK, 235, 4),
        ("stroke", (360, 312, 1080, 1185), GREEN, 255, 8),  # face sweet zone: 25-75% wide, 10-38% high
        ("dot", (720, 748), GREEN, 255, 16),                # suggested face center (50%, 24%)
    ],
    # NOTE on "sweet"/"dot" y/x: nudged from the plan's original values (sweet y 256->248, dot x/y
    # 746/728->385/790) after the Step 5 eyeball found text crossing the green box's stroke on this
    # narrower canvas (both languages, mobile is tighter than desktop). Only x/y moved.
    "labels": [
        ("top", "ma", 720, 100, INK_PINK, 44),
        ("sweet", "ma", 720, 248, INK_GREEN, 44),
        ("dot", "la", 385, 790, INK_GREEN, 40),
        ("chatlog", "ma", 720, 1350, INK_ORANGE, 44),
        ("bottom", "ma", 720, 2852, INK_PINK, 44),
        ("footer", "ma", 720, 3062, INK_FOOT, 30),
    ],
}

LABELS = {
    "en": {
        "desktop": {
            "side": "Side buttons",
            "band": "21:9 ultrawide crop band (keep the face out)",
            "sweet": "Face sweet zone (face and collarbone go here)",
            "dot": "Suggested face center (30%, 30%)",
            "chatlog": "Chat Log, always on (frosted glass)",
            "adv": "Dialogue box (the eye button can hide it, frosted glass)",
            "input": "Input row",
            "footer": "EverOtome CG safe-zone template, desktop 2560x1440 (measured from the bundled layout.css)",
        },
        "mobile": {
            "top": "Top badge and status bar",
            "sweet": "Face sweet zone",
            "dot": "Suggested face center (50%, 24%)",
            "chatlog": "Chat Log (the eye button can hide it, dark translucent)",
            "bottom": "Input row and dock (always on)",
            "footer": "EverOtome CG safe-zone template, mobile 1440x3120 (9:19.5)",
        },
    },
    "zh-Hant": {
        "desktop": {
            "side": "側欄鈕",
            "band": "21:9 超寬裁切帶（臉別放這）",
            "sweet": "臉部甜蜜區（臉＋鎖骨收在這格）",
            "dot": "建議臉心 (30%, 30%)",
            "chatlog": "Chat Log 常駐框（半透玻璃）",
            "adv": "對話框 ADV（眼睛鍵可整組隱藏＝半透玻璃）",
            "input": "輸入列",
            "footer": "EverOtome CG 安全區模板・桌機 2560x1440（量自 layout.css）",
        },
        "mobile": {
            "top": "頂部徽章＋狀態列",
            "sweet": "臉部甜蜜區",
            "dot": "建議臉心 (50%, 24%)",
            "chatlog": "Chat Log（眼睛鍵可隱藏＝黑半透）",
            "bottom": "輸入列＋dock（常駐）",
            "footer": "EverOtome CG 安全區模板・手機 1440x3120（9:19.5）",
        },
    },
}
FILE_SUFFIX = {"en": "", "zh-Hant": "-zh"}

CJK_FONTS = [
    "C:/Windows/Fonts/msjh.ttc",
    "C:/Windows/Fonts/NotoSansTC-VF.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-TC-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
]
LATIN_FONTS = [
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]


def find_font(explicit, candidates):
    if explicit:
        if not os.path.exists(explicit):
            raise SystemExit(f"[abort] font not found: {explicit}. "
                              f"Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup")
        return explicit
    for p in candidates:
        if p and os.path.exists(p):
            return p
    return None


def load_font(path, size):
    if path:
        return ImageFont.truetype(path, size)
    try:
        return ImageFont.load_default(size)      # Pillow 10.1+
    except TypeError:
        return ImageFont.load_default()


def draw_template(spec, labels, font_path):
    size = spec["size"]
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    for shape in spec["shapes"]:
        layer = Image.new("RGBA", size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        kind, geo, rgb, alpha = shape[0], shape[1], shape[2], shape[3]
        color = rgb + (alpha,)
        if kind == "fill":
            d.rectangle(geo, fill=color)
        elif kind == "stroke":
            d.rectangle(geo, outline=color, width=shape[4])
        elif kind == "dot":
            cx, cy = geo
            r = shape[4]
            d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
        canvas.alpha_composite(layer)
    text_layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(text_layer)
    for key, anchor, x, y, ink, fsize in spec["labels"]:
        d.text((x, y), labels[key], font=load_font(font_path, fsize), fill=ink, anchor=anchor)
    canvas.alpha_composite(text_layer)
    return canvas


def main(argv=None):
    ap = argparse.ArgumentParser(description="Draw the CG safe-zone templates (transparent PNG overlays) for docs/.")
    ap.add_argument("--out", default=str(DOCS), help="output folder (default: the repo's docs/)")
    ap.add_argument("--lang", choices=("all", "en", "zh-Hant"), default="all",
                    help="which language pair to write (default: all)")
    ap.add_argument("--font-cjk", default=None, help="TTF/TTC with Chinese glyphs for the zh-Hant pair (auto-detected if omitted)")
    ap.add_argument("--font-latin", default=None, help="TTF for the English pair (auto-detected; falls back to the CJK font)")
    args = ap.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    cjk = find_font(args.font_cjk, CJK_FONTS)
    latin = find_font(args.font_latin, LATIN_FONTS) or cjk

    langs = ["en", "zh-Hant"] if args.lang == "all" else [args.lang]
    if "zh-Hant" in langs and cjk is None:
        raise SystemExit("[abort] no CJK font found; pass --font-cjk PATH (the zh-Hant labels would render blank). "
                          "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup")
    if latin is None:
        raise SystemExit("[abort] no usable font found; pass --font-latin PATH. "
                          "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup")
    for lang in langs:
        font = cjk if lang == "zh-Hant" else latin
        for device, spec in (("desktop", DESKTOP), ("mobile", MOBILE)):
            img = draw_template(spec, LABELS[lang][device], font)
            path = out / f"cg-safe-zone-{device}{FILE_SUFFIX[lang]}.png"
            img.save(path, optimize=True)
            print(f"wrote {path} ({img.size[0]}x{img.size[1]}, {lang})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
