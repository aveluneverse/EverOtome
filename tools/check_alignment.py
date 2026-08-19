"""差分對齊校驗：A-F（六張，眼 2 態）或 A-I（九張，眼 3 態 open/half/closed）
尺寸一致＋眼嘴區外 pixel 級一致，幀集合依資料夾內容自動偵測，不必手動指定。

用法：python tools/check_alignment.py <dir> [--eye-box L,T,R,B] [--mouth-box L,T,R,B]
偵測規則（detect_names）：資料夾裡看到 G/H/I 任一張（.png 或 .webp）＝九張制
（A-I）；否則預設六張制（A-F）。九張制下 D/G 是純眼差分（嘴維持 A 的閉合）、
B/C 是純嘴差分（眼維持 A 的睜開）、E/F/H/I 是眼嘴聯集——跟六張制「B/C 純嘴、
D 純眼、E/F 眼嘴聯集」同一套形狀，只是眼軸從 2 態多切出「半閉」中間態
（六張的 D/E/F ↔ 九張的 G/H/I 是同一個「眼變」角色，九張多出的 D/E/F 半閉
列是全新中間態，不是六張那組的重新命名）。
不給 box 時自動推定，採 leave-one-out：檢查某張 n 時，「合法變動區」＝
「排除 n 自己」的其餘各張 diff 聯集——n 自己的 diff 絕不算進自己那組合法
區，否則 n 的污染會把自己洗白、永遠測不出來。每張因此各有各的合法區
（逐張重算，不是共用同一組全域聯集）。該區外仍有殘餘差異（>0.5% 像素）
＝FAIL 並指名。
盒模式（給了 box）：合法變動區＝兩盒聯集，全部張數共用同一組固定幾何區，
不受上述 leave-one-out 影響，區外零容忍（>0.1%）。
輸出：每張 vs A 的區外差異率＋PASS/FAIL；exit 0/1。
"""
import argparse, sys
from pathlib import Path
from PIL import Image, ImageChops, ImageFilter

NAMES_6 = list("ABCDEF")
NAMES_9 = list("ABCDEFGHI")

def _exists(d: Path, n: str) -> bool:
    return any((d / f"{n}.{ext}").exists() for ext in ("png", "webp"))

def detect_names(d: Path) -> list:
    """G/H/I 任一存在＝九張制，否則六張制。缺件不在這裡判——load_set 逐張
    找不到檔案時會直接指名報 FAIL，比在偵測階段猜測不完整集合更清楚。"""
    if any(_exists(d, n) for n in ("G", "H", "I")):
        return NAMES_9
    return NAMES_6

def load_set(d: Path, names: list):
    imgs = {}
    for n in names:
        matches = [p for ext in ("png", "webp") for p in [d / f"{n}.{ext}"] if p.exists()]
        if not matches:
            print(f"FAIL: 缺 {n}.png/.webp"); sys.exit(1)
        imgs[n] = Image.open(matches[0]).convert("RGBA")
    sizes = {im.size for im in imgs.values()}
    if len(sizes) != 1:
        print(f"FAIL: 尺寸不一致 {sizes}"); sys.exit(1)
    return imgs

def diff_mask(a: Image.Image, b: Image.Image):
    d = ImageChops.difference(a, b).convert("L")
    return d.point(lambda v: 255 if v > 8 else 0)  # 容忍壓縮微噪

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir"); ap.add_argument("--eye-box"); ap.add_argument("--mouth-box")
    args = ap.parse_args()
    d = Path(args.dir)
    names = detect_names(d)
    imgs = load_set(d, names)
    w, h = imgs["A"].size
    total = w * h
    failed = []

    if args.eye_box and args.mouth_box:
        legal = Image.new("L", (w, h), 0)
        for box in (args.eye_box, args.mouth_box):
            l, t, r, b = map(int, box.split(","))
            legal.paste(255, (l, t, r, b))
        threshold = 0.001
        for n in names[1:]:
            m = diff_mask(imgs["A"], imgs[n])
            outside = ImageChops.subtract(m, legal)
            rate = sum(1 for v in outside.getdata() if v) / total
            print(f"{n} vs A 區外差異率: {rate:.4%}")
            if rate > threshold:
                failed.append(n)
    else:
        # 自動推定：合法變動區＝「其他張」的 diff 聯集，逐張排除自己再檢查。
        # 若把自己也算進聯集，污染張的髒區會把自己洗白、永遠測不出來
        # （這組張數唯一該動的是眼嘴；某張若「頭髮也動了」，用其他張的共識
        # 反推出的合法區就照不到那塊，殘餘才會露出來——test_tampered 這個場景）。
        threshold = 0.005
        diffs = {n: diff_mask(imgs["A"], imgs[n]) for n in names[1:]}
        for n in names[1:]:
            legal = Image.new("L", (w, h), 0)
            for other in names[1:]:
                if other != n:
                    legal = ImageChops.lighter(legal, diffs[other])
            legal = legal.filter(ImageFilter.MaxFilter(5))  # 膨脹 2px 吃掉邊緣抗鋸齒
            outside = ImageChops.subtract(diffs[n], legal)
            rate = sum(1 for v in outside.getdata() if v) / total
            print(f"{n} vs A 區外差異率: {rate:.4%}")
            if rate > threshold:
                failed.append(n)

    if failed:
        print(f"FAIL: {'、'.join(failed)} 眼嘴區外有變動，這幾張要重生")
        sys.exit(1)
    count_word = {6: "六", 9: "九"}.get(len(names), str(len(names)))
    print(f"PASS: {count_word}張對齊乾淨")
    sys.exit(0)

if __name__ == "__main__":
    main()
