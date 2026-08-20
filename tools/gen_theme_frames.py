# -*- coding: utf-8 -*-
"""per-theme Chat Log 框件生成器。

設計定調：crystal-swan＝預設樣式外觀（框件形狀唯一），其他主題＝純換色系。
本工具把 crystal-swan 框件的 5 個色值換成各主題色，輸出 per-theme 換色版：

    engine/assets/themes/<id>/chatlog-frame.svg

改了框件原稿（engine/assets/themes/crystal-swan/chatlog-frame.svg）→
重跑本腳本即可各主題同步。色值來源與 config.example.json themes[].vars
同源（改 config 主色時記得同步這裡的框件色再重跑）。

用法：  python tools/gen_theme_frames.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "engine" / "assets" / "themes" / "crystal-swan" / "chatlog-frame.svg"
OUT_DIRS = [
    ROOT / "engine" / "assets" / "themes",
]

# 原框件（crystal-swan）5 色 → 各主題對應色。
# 角色：main＝主框線/裝飾線（.ob/.dv/.dv2/.tk）、bright＝亮線/圓點/菱形描邊
# （.ib/.dot/.dm 系）、glow_in＝發光內層 flood、glow_out＝發光外層 flood、
# diamond_fill＝菱形半透填色。
SRC_COLORS = {
    "main": "#bedaff",
    "bright": "#e5f0ff",
    "glow_in": "#cfe2ff",
    "glow_out": "#6fa5ff",
    "diamond_fill": "rgba(125, 155, 212, 0.16)",
}

THEMES = {
    "snow-palace": {
        "main": "#c4faff",
        "bright": "#effeff",
        "glow_in": "#d8fbff",
        "glow_out": "#6beaff",
        "diamond_fill": "rgba(111, 189, 211, 0.16)",
    },
    "crimson-nocturne": {
        "main": "#ff6ca1",
        "bright": "#ffb2cf",
        "glow_in": "#ff8fb8",
        "glow_out": "#ff3482",
        "diamond_fill": "rgba(199, 90, 130, 0.16)",
    },
    "rose-vow": {
        "main": "#ffa4cf",
        "bright": "#ffdaeb",
        "glow_in": "#ffc0dd",
        "glow_out": "#ff6fb7",
        "diamond_fill": "rgba(201, 127, 174, 0.16)",
    },
    "verdant-dawnsong": {
        "main": "#dde8c8",
        "bright": "#f4f8e7",
        "glow_in": "#e9f2cf",
        "glow_out": "#8fa475",
        "diamond_fill": "rgba(133, 148, 113, 0.16)",
    },
}


def main() -> int:
    svg = SRC.read_text(encoding="utf-8")
    for role, color in SRC_COLORS.items():
        if color not in svg:
            print(f"[FAIL] source frame does not contain the {role} color {color}; was the frame edited? "
                  f"Update SRC_COLORS first, then rerun.")
            return 1
    for theme_id, colors in THEMES.items():
        out_svg = svg
        for role, src_color in SRC_COLORS.items():
            out_svg = out_svg.replace(src_color, colors[role])
        for base in OUT_DIRS:
            dest = base / theme_id / "chatlog-frame.svg"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(out_svg, encoding="utf-8", newline="\n")
            print(f"[OK] {dest.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
