# -*- coding: utf-8 -*-
"""占位 app icon／favicon 生成器（crystal-swan 主題配色，幾何風格）。

本 repo 隨附的那四顆圖示＝專案標記本體（作者原畫，授權見 ASSETS.md）；
跑這支會就地蓋掉它們，換成下面說的幾何占位版。自架站要換上自己的品牌
圖示、圖還沒畫好時，可以拿占位版先頂著。

輸出四個檔案到 engine/（index.html／manifest.webmanifest 既有引用路徑，
本腳本不改那兩份檔案，只落地圖片本身）：
    favicon.png       192×192
    app-icon-180.png  180×180（iOS home screen icon）
    app-icon-192.png  192×192（manifest icons[0]）
    app-icon-512.png  512×512（manifest icons[1]，purpose: any）

manifest 還有第三顆 app-icon-512-maskable.png（purpose: maskable，不透明底
＋圖縮 80% 置中），那顆這支不生成——跑完會剩它還是專案標記的紫色版，要一起
換掉的話自己補一顆同規格的。

設計：crystal-swan 主題色（深夜藍底 #0c1c28＋冰晶藍幾何「E」標記，主色
#6fbdd3、亮色 #c2e9f2）——與 tools/make_sample_character.py 產出的幾何範例
臉同一個「簡潔幾何、零照片級渲染」美術方向，開源殼零額外美術資產依賴。

maskable 安全區：E 標記的座標刻意收在畫布中心、半徑約 9.2/24 單位處（W3C
maskable icon 80% 安全圓半徑 9.6/24 單位內留有餘裕），OS 把它拿去裁成
圓形／圓角方形時標記不會被切到。

用法：  python tools/make_placeholder_icons.py --force
"""
from __future__ import annotations

import argparse
from pathlib import Path

from _overwrite_guard import add_force_argument, refuse_unless_force

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "engine"

BG = (12, 28, 40, 255)         # crystal-swan 深夜藍 #0c1c28
MAIN = (111, 189, 211, 255)    # 冰晶藍主色 #6fbdd3
BRIGHT = (194, 233, 242, 255)  # 冰晶藍亮色 #c2e9f2

TARGETS = [
    ("favicon.png", 192),
    ("app-icon-180.png", 180),
    ("app-icon-192.png", 192),
    ("app-icon-512.png", 512),
]

# E 標記：24 單位設計網格（同站內既有 Feather 風格 icon 的 viewBox 慣例），
# 三橫桿＋一豎脊——四個矩形的 (x0, y0, x1, y1)。座標刻意壓在安全圓內
# （見檔頭說明），比原始等高全滿版本略矮，四角落在安全半徑內。
E_BARS = [
    (6, 5, 9, 19),     # 豎脊
    (6, 5, 18, 8),     # 上橫桿
    (6, 10.5, 15, 13.5),  # 中橫桿（略短，經典 E 字形比例）
    (6, 16, 18, 19),   # 下橫桿
]


def draw_icon(size: int) -> Image.Image:
    """畫一顆 size×size 的圖示：深夜藍底＋幾何「E」標記，標記外圍加一圈
    柔化亮色光暈（呼應站內 SVG 框件既有的 glow 語彙），標記本體是
    亮色細邊＋主色實心的雙層疊色（同 SVG 框件 outer/inner 雙層邊框語彙）。
    """
    from PIL import Image, ImageDraw, ImageFilter

    unit = size / 24.0

    def pt(x, y):
        return (x * unit, y * unit)

    def rect(x0, y0, x1, y1):
        return [pt(x0, y0), pt(x1, y1)]

    def rect_expand(x0, y0, x1, y1, px):
        (ax, ay), (bx, by) = pt(x0, y0), pt(x1, y1)
        return [(ax - px, ay - px), (bx + px, by + px)]

    img = Image.new("RGBA", (size, size), BG)

    # 光暈層：E 的外框放大後模糊，低透明度疊在底色上
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    pad = unit * 0.9
    for bar in E_BARS:
        gd.rectangle(rect_expand(*bar, pad), fill=BRIGHT)
    blur_radius = max(2, round(size * 0.035))
    glow = glow.filter(ImageFilter.GaussianBlur(blur_radius))
    glow_alpha = glow.split()[3].point(lambda a: int(a * 0.55))
    glow.putalpha(glow_alpha)
    img = Image.alpha_composite(img, glow)

    # 標記本體：亮色細邊（略放大的矩形先畫）＋主色實心（原尺寸疊上）
    d = ImageDraw.Draw(img)
    border = max(1, unit * 0.45)
    for bar in E_BARS:
        d.rectangle(rect_expand(*bar, border), fill=BRIGHT)
    for bar in E_BARS:
        d.rectangle(rect(*bar), fill=MAIN)

    return img.convert("RGB")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Regenerate the geometric placeholder favicon and app icons in engine/. "
                    "This REPLACES the shipped brand icons.")
    add_force_argument(ap)
    args = ap.parse_args()
    targets = [OUT_DIR / name for name, _ in TARGETS]
    if refuse_unless_force(targets, args.force, "engine/") != 0:
        return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, size in TARGETS:
        icon = draw_icon(size)
        dest = OUT_DIR / name
        icon.save(dest, format="PNG")
        print(f"[OK] {dest.relative_to(ROOT)} ({size}x{size})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
