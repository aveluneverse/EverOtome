"""生成範例角色 9 張差分（幾何臉，開源乾淨素材）＋manifest.json。

眼三態 open/half/closed×嘴三態 0/1/2＝9 張，字母配置沿用既有的九幀規格：
open→A/B/C、half→D/E/F、closed→G/H/I。六張制舊版的「D/E/F=closed」在九張制
被重新定位成「half」中間態，closed 讓給新增的 G/H/I——不是同名重用，是全新中間態。
"""
import json
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "engine" / "assets" / "sample"
W, H = 512, 768

def draw(eye: str, mouth: int) -> Image.Image:  # eye: open/half/closed, mouth: 0閉/1半/2開
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((156, 320, 356, 700), 60, fill=(70, 80, 105, 255))   # 身
    d.ellipse((176, 120, 336, 300), fill=(235, 215, 200, 255))               # 臉
    d.polygon([(170, 200), (180, 90), (332, 90), (342, 200), (256, 60)], fill=(60, 55, 70, 255))  # 髮
    for cx in (216, 296):                                                     # 眼：open 全開橢圓／
        if eye == "open":                                                     # half 瞇成扁橢圓（眨眼
            d.ellipse((cx - 14, 190, cx + 14, 214), fill=(40, 40, 50, 255))    # 中間幀）／closed 一條線
        elif eye == "half":
            d.ellipse((cx - 14, 198, cx + 14, 206), fill=(40, 40, 50, 255))
        else:
            d.line((cx - 14, 202, cx + 14, 202), fill=(40, 40, 50, 255), width=4)
    mh = {0: 3, 1: 12, 2: 24}[mouth]                                          # 嘴
    d.ellipse((240, 250 - mh // 2, 272, 250 + mh // 2), fill=(120, 60, 60, 255))
    return img

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    spec = {"A": ("open", 0), "B": ("open", 1), "C": ("open", 2),
            "D": ("half", 0), "E": ("half", 1), "F": ("half", 2),
            "G": ("closed", 0), "H": ("closed", 1), "I": ("closed", 2)}
    for name, (eye, mouth) in spec.items():
        draw(eye, mouth).save(OUT / f"{name}.webp", quality=90)
    (OUT / "manifest.json").write_text(json.dumps({
        "size": [W, H],
        "eyeStates": 3,
        "moods": {"neutral": {n: f"{n}.webp" for n in spec}}
    }, indent=2), encoding="utf-8")
    print(f"OK: 9 張＋manifest → {OUT}")

if __name__ == "__main__":
    main()
