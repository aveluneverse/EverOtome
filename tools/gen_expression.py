# -*- coding: utf-8 -*-
"""表情貼片生成器。

輸入：某套外觀的現役差分底圖夾（A-I PNG）＋ 使用者交的表情全身圖（1 張或多張，
      臉外與 A 張零差異、只動眉眼區／嘴區）。
輸出：眉眼區／嘴區「不透明切塊」貼片（全畫布透明底 PNG，疊在立繪上 inset:0 即對位）
      ＋ <name>.json（狀態→檔名對照，給試妝間 engine/demo/expression-lab.html 與引擎讀）
      ＋ 校驗報告。manifest 鍵的完整契約見 docs/sprite-guide.md。

核心規則（跟 tools/check_alignment.py 同一家）：
  1. 全部先「壓平 alpha」再 diff（灰底 128 合成）——透明像素的 RGB 垃圾值會讓
     A vs B 整張報差（實測 mean 33），壓平後只剩真差異。門檻 24。
  2. 基準區：眼區＝(A vs D)∪(A vs G)、嘴區＝(A vs B)∪(A vs C)——現役眨眼／說話
     真正會動的範圍。貼片一定要把基準區蓋滿，底下翻到哪一格都不會露出來。
  3. 表情圖 vs A 的差異，依連通元件歸類：碰到眼基準區→眼區；碰到嘴基準區→嘴區；
     兩者都不碰→臉外變動→FAIL 指名（跑版／頭髮被工具順手改了）。
  4. 最終區＝(基準區 ∪ 該區全部表情差異) → 閉運算補洞 → 外擴 MARGIN → 外緣羽化
     FEATHER（外擴量 ≥ 羽化量，羽化落在「底圖與表情圖同像素」的帶上＝看不見接縫）。
  5. 貼片像素＝表情圖本身（含皮膚眉眼髮絲），alpha＝min(原 alpha, 區 mask)。

檔名角色（兩套命名，字母優先，建議一律用字母 A–I）：
  字母（推薦命名法）：`<表情>_A.png`…`_I.png` 依 sprite.js 的 FRAME_TABLE_3 對照——
  A(眼開,嘴0) B(眼開,嘴1) C(眼開,嘴2) D(眼半,0) E(眼半,1) F(眼半,2) G(眼閉,0) H(眼閉,1) I(眼閉,2)。
  中文 token：眼開／眼半／眼閉 → eye state open/half/closed；嘴閉／嘴半／嘴開 → mouth 0/1/2；
  多張套組要挑得到基準張，至少要有一張沾到「眼開」或「嘴閉」其中一軸（最好單張兩軸俱全，
  即 `_眼開_嘴閉`；退而求其次也接受只鎖眼開、或只鎖嘴閉的那一張）——整套完全沒有任何一張
  帶到眼開或嘴閉（例如只給眼半／眼閉配嘴半／嘴開）才會被判定沒有基準張、main() 直接 FAIL
  指名，不會靜默退化成後面才報的誤導性「基準區未蓋滿」。
  眼區各態只從「嘴 0」那一欄切（A/D/G），嘴區各態只從「眼開」那一列切（A/B/C）；其餘
  張（E/F/H/I）只參與區域聯集與逐張還原驗證。
  只給一張＝該表情只有一態（不管檔名帶什麼角色）：眼區有差→ eye "any"、嘴區有差→
  mouth "any"（引擎退化鏈的最後一站，底圖翻到哪一態都貼得上）。

底色區 static：整張臉的淡紅暈這種「4-24 級、>24 門檻完全抓不到」的變動，
  改用低門檻 STATIC_THRESH 在「臉框」（眼嘴基準區 bbox 外擴 FACE_PAD）內另切一張常駐
  貼片 `<name>_static.webp`——表情亮著期間恆亮、畫在眼嘴貼片之下。底圖 A-I 在眼嘴基準區
  之外逐像素相同，所以把臉的其餘部分凍成一張是安全的。

還原驗證：每張來源圖都重組一次（底圖對應字母 → 疊 static → 疊該態眼貼片 → 疊該態嘴
  貼片，退化鏈與 expression.js 同步）再跟原圖比殘差；>24 殘差超過畫布 0.05% 即 FAIL。
  這是整條管線唯一的端到端證據：區怎麼切、護欄怎麼擋，最後都要還原成來源那張臉。

用法（路徑相對 repo 根；--out 與 --manifest 指向該套外觀自己的素材夾）：
  單張表情（只有一態，鍵一律記成 any）：
  python tools/gen_expression.py --name smile --label 笑 \
      --base engine/assets/sample \
      --src  "<your-expression-fullbody>.png" \
      --out  engine/assets/sample/expr \
      --manifest engine/assets/sample/manifest.json
  多張套組（字母命名，各態分開切；--blush builtin＝這個表情自帶紅暈）：
  python tools/gen_expression.py --name shy --label 害羞 --blush builtin \
      --base engine/assets/sample \
      --src  expr-src/shy_A.png expr-src/shy_D.png expr-src/shy_G.png \
      --out  engine/assets/sample/expr \
      --manifest engine/assets/sample/manifest.json
  exit 0＝全 PASS；1＝有 FAIL（臉外變動／變動沒被任何貼片接住／空表情／基準區沒蓋滿／
  還原殘差超標／尺寸不符）。
"""
import argparse
import json
import re
import sys
from collections import namedtuple
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

THRESH = 24
MARGIN = 12      # 區外擴像素
FEATHER = 4      # 外緣羽化像素（< MARGIN）
CLOSE = 9        # 閉運算核（補洞）
GUARD = 3        # 眼嘴互避護欄：眼區絕不進「嘴基準區外擴 GUARD」，反之亦然（鼻子分界）
ZONE_REACH = 20  # 改動歸屬半徑：離眼／嘴基準區這麼近的差異歸該區，更遠的歸底色區（見 main 註解）
STATIC_THRESH = 4    # 底色區低門檻：整臉紅暈落在 4-16 級，THRESH 24 抓不到
FACE_PAD = 120       # 臉框＝眼嘴基準區 bbox 聯集外擴這麼多；框內的變動＝臉上的事，框外＝跑版
STATIC_MIN_PX = 200  # 低門檻差異少於這麼多＝沒有底色區（PSD 匯出雜訊），不出 static 貼片
MOTION_REACH = 30    # 表情自身眼／嘴運動只認「基準區外擴這麼多」以內（實測：真運動 93-99% 在 30px 內，
                     # 更遠的是生成工具每張微抖的髮絲／頰邊——放進區裡＝眨眼講話時那些地方在三張版本間跳）
SPECK_CORE = 5       # 保險絲的成塊判定：未接住像素經 5×5 MinFilter 還剩＝有成塊改動＝FAIL；只剩零星細線散點＝微抖
EYE_TOKENS = {"眼開": "open", "眼半": "half", "眼閉": "closed"}
MOUTH_TOKENS = {"嘴閉": "0", "嘴半": "1", "嘴開": "2"}
# 字母角色：對齊 sprite.js FRAME_TABLE_3（眼軸 open/half/closed × 嘴軸 0/1/2）
LETTER_ROLE = {"A": ("open", "0"), "B": ("open", "1"), "C": ("open", "2"),
               "D": ("half", "0"), "E": ("half", "1"), "F": ("half", "2"),
               "G": ("closed", "0"), "H": ("closed", "1"), "I": ("closed", "2")}
ROLE_LETTER = {v: k for k, v in LETTER_ROLE.items()}
# 一張來源圖的全部身家：路徑／影像／眼嘴區差異量／角色／對應底圖字母（還原驗證要用）
Src = namedtuple("Src", "path im eye_n mouth_n eye_role mouth_role letter")


def flat(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    bg = Image.new("RGBA", im.size, (128, 128, 128, 255))
    bg.alpha_composite(im)
    return bg.convert("RGB")


def diff_mask(a: Image.Image, b: Image.Image, thresh: int = THRESH) -> Image.Image:
    return ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > thresh else 0)


def count(m: Image.Image) -> int:
    # m 一律 mode "L" 的 0/255 遮罩；histogram()[1:] ＝ index 1-255 的像素數總和，
    # 跟舊寫法「非零像素數」語意相同、免掉 Python 逐像素迴圈與 getdata() 的 DeprecationWarning。
    return sum(m.histogram()[1:])


def dilate(m: Image.Image, r: int) -> Image.Image:
    return m.filter(ImageFilter.MaxFilter(2 * r + 1))


def close_and_dilate(m: Image.Image) -> Image.Image:
    m = m.filter(ImageFilter.MaxFilter(CLOSE)).filter(ImageFilter.MinFilter(CLOSE))  # close holes
    return m.filter(ImageFilter.MaxFilter(2 * MARGIN + 1))                            # dilate


def feather(m: Image.Image) -> Image.Image:
    # 外緣羽化：先內縮 FEATHER 得核心（全不透明），再對整區做模糊、取兩者最大值
    # ＝核心 255、外圈平滑降到 0。羽化帶落在外擴帶內（MARGIN > FEATHER）。
    core = m.filter(ImageFilter.MinFilter(2 * FEATHER + 1))
    soft = m.filter(ImageFilter.GaussianBlur(FEATHER))
    return ImageChops.lighter(core, soft)


def components(mask: Image.Image):
    """粗連通元件：用膨脹後的 bbox 分群（夠用——臉上差異就幾團）。回傳各元件 mask。"""
    w, h = mask.size
    grown = mask.filter(ImageFilter.MaxFilter(15))
    px = grown.load()
    seen = Image.new("L", (w, h), 0)
    seen_px = seen.load()
    comps = []
    bbox = grown.getbbox()
    if not bbox:
        return comps
    l, t, r, b = bbox
    for y in range(t, b):
        for x in range(l, r):
            if px[x, y] and not seen_px[x, y]:
                # flood fill (iterative)
                stack = [(x, y)]
                minx = maxx = x
                miny = maxy = y
                seen_px[x, y] = 255
                while stack:
                    cx, cy = stack.pop()
                    minx, maxx = min(minx, cx), max(maxx, cx)
                    miny, maxy = min(miny, cy), max(maxy, cy)
                    for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                        if l <= nx < r and t <= ny < b and px[nx, ny] and not seen_px[nx, ny]:
                            seen_px[nx, ny] = 255
                            stack.append((nx, ny))
                comp = Image.new("L", (w, h), 0)
                comp.paste(255, (minx, miny, maxx + 1, maxy + 1))
                comps.append(ImageChops.multiply(comp, mask))
    return comps


def roles_from_name(name: str):
    """字母優先（`_A.png`…`_I.png`），沒中字母再看中文 token，都沒有＝(None, None)。

    副檔名大小寫不拘（`.PNG`／`.webp` 都收，跟底圖 base() 收 png/webp 同步）；字母本身維持
    大小寫敏感——小寫 `_a` 不是角色（避免把 `xxx_a.png` 這種一般檔名誤判成眼開嘴閉）。
    """
    m = re.search(r"_([A-I])\.(?i:png|webp)$", name)
    if m:
        return LETTER_ROLE[m.group(1)]
    eye = next((v for k, v in EYE_TOKENS.items() if k in name), None)
    mouth = next((v for k, v in MOUTH_TOKENS.items() if k in name), None)
    return eye, mouth


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True, help="expression id (ASCII, e.g. laugh)")
    ap.add_argument("--label", default="", help="display name written into the json (any language; edit the manifest afterwards to give one name per language)")
    ap.add_argument("--base", required=True, help="folder of the appearance's current frames (A-I png)")
    ap.add_argument("--src", required=True, nargs="+", help="full-body image(s) of the expression (one or more)")
    ap.add_argument("--out", required=True, nargs="+", help="output folder(s); several = the same files written to each, e.g. mirrored deploy locations")
    ap.add_argument("--mode", choices=("auto", "flash", "sustain"), default="auto",
                    help="auto = flash when the mouth has only 'any' and the eyes have at most one state (both regions frozen, so only a moment), otherwise sustain")
    ap.add_argument("--blush", choices=("none", "builtin"), default="none",
                    help="builtin = this expression carries its own flush (json/manifest get blush:builtin; the engine holds the blush layer down while it is up)")
    ap.add_argument("--manifest", nargs="*", default=[], help="manifest.json file(s) to merge expressions.<id> into (several allowed)")
    ap.add_argument("--png", action="store_true", help="write PNG (default: lossless webp; PNG is larger, usually only for inspection)")
    ap.add_argument("--eyes-only", action="store_true",
                    help="the expression changes the eyes only (the mouth keeps the regular frames): differences in the mouth region and the face tint count as generator jitter: no mouth patch, no static patch, coverage fuse waived (the ignored amount is printed per image); the rebuild residual limit still applies (ignoring enough to look like a real mouth change fails the residual check)")
    ap.add_argument("--src-offset", nargs=2, type=int, metavar=("DX", "DY"), default=None,
                    help="when the source canvas is smaller than the base frames (generator canvases drift, e.g. 1024 to 1300), paste each source image as-is onto a transparent canvas of the base size at (DX, DY) before comparing; ignored when the sizes match. Measured example: 138 0 (a 1024 canvas pasted into 1300 vs base A: zero pixels over 24)")
    args = ap.parse_args()

    base_dir = Path(args.base)
    outs = [Path(o) for o in args.out]
    for o in outs:
        o.mkdir(parents=True, exist_ok=True)

    def base(n):
        for ext in ("png", "webp"):
            p = base_dir / f"{n}.{ext}"
            if p.exists():
                return Image.open(p)
        print(f"FAIL: base frame {n}.png/.webp missing"); sys.exit(1)

    A_rgba = base("A").convert("RGBA")
    W, H = A_rgba.size
    A = flat(A_rgba)
    eye_base = ImageChops.lighter(diff_mask(A, flat(base("D"))), diff_mask(A, flat(base("G"))))
    mouth_base = ImageChops.lighter(diff_mask(A, flat(base("B"))), diff_mask(A, flat(base("C"))))
    print(f"base {W}x{H} | eye reference bbox {eye_base.getbbox()} | mouth reference bbox {mouth_base.getbbox()}")

    # 鼻子分界：眼區硬切避開「嘴基準區外擴 GUARD」、嘴區避開「眼基準區外擴 GUARD」。
    # 兩區在這張臉只隔 ~10px，外擴 MARGIN 會互相咬到；硬切邊落在「表情圖＝底圖」
    # 的帶上（該帶底圖各幀也都＝A），肉眼無接縫。表情改動若真的畫進護欄＝FAIL 指名。
    # （原本算在 src 迴圈之後，提前到這裡：下面的歸屬半徑要先吃它。）
    allowed_eye = ImageChops.invert(dilate(mouth_base, GUARD))
    allowed_mouth = ImageChops.invert(dilate(eye_base, GUARD))
    # 改動歸屬：離眼／嘴基準區 ZONE_REACH 以內的差異歸該區，更遠的歸底色區。
    # 原本的「整個連通元件碰到哪區就整團歸哪區」遇到整臉紅暈會爆炸——紅暈超過 24 級的像素
    # 散佈全臉、彼此間距約 10px，連通元件的膨脹會把眼團、嘴團、下巴的紅暈點串成一大團
    # （實測：某組 9 張裡有 6 張只剩「一團」，bbox 從眉毛蓋到下巴），整團歸眼區的話眼貼片
    # 會吞掉整張臉、還會踩到嘴的分界護欄。改用「離基準區多近」判斷：那組圖的眼嘴結構改動
    # 全在基準區 10px 內，紅暈點才會跑到 20-60px（只換眉眼的那組則是 0 px 超過 20——所以
    # 既有單張表情的切法逐位元組不變）。距離之外的差異落在臉框內＝底色（交給 static 那張凍住，
    # 底圖 A-I 在基準區外逐像素相同，凍住是安全的）、落在臉框外＝真的跑版＝FAIL。
    eye_reach = ImageChops.multiply(dilate(eye_base, ZONE_REACH), allowed_eye)
    mouth_reach = ImageChops.multiply(dilate(mouth_base, ZONE_REACH), allowed_mouth)
    eb, mb = eye_base.getbbox(), mouth_base.getbbox()
    face_box = (max(0, min(eb[0], mb[0]) - FACE_PAD), max(0, min(eb[1], mb[1]) - FACE_PAD),
                min(W, max(eb[2], mb[2]) + FACE_PAD), min(H, max(eb[3], mb[3]) + FACE_PAD))
    face_mask = Image.new("L", (W, H), 0)
    face_mask.paste(255, face_box)
    print(f"face box {face_box} (union of the eye and mouth reference bboxes, padded by {FACE_PAD})")

    srcs = []
    failed = False
    eye_union = eye_base.copy()
    mouth_union = mouth_base.copy()
    for s in args.src:
        p = Path(s)
        im = Image.open(p).convert("RGBA")
        if im.size != (W, H):
            if args.src_offset is not None:
                # 畫布對位：整張原樣貼進底圖尺寸的透明畫布（paste 無 mask＝連 alpha 一起搬，
                # 透明處維持透明、不做合成）；貼完之後的 s.im 走完全相同的管線（diff／切片／還原驗證），
                # 對錯位由既有的「臉外變動＝FAIL」把關——偏移量給錯＝整個身體都是差異＝當場 FAIL。
                dx, dy = args.src_offset
                canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                canvas.paste(im, (dx, dy))
                print(f"  {p.name}: source {im.size[0]}x{im.size[1]} pasted onto the {W}x{H} canvas at offset ({dx},{dy})")
                im = canvas
            else:
                print(f"FAIL: {p.name} is {im.size}, base is {W}x{H} (canvas drifted? measure the offset and pass --src-offset DX DY)")
                failed = True
                continue
        d = diff_mask(flat(im), A)
        eye_hit = ImageChops.multiply(d, eye_reach)
        mouth_hit = ImageChops.subtract(ImageChops.multiply(d, mouth_reach), eye_hit)  # 交界帶讓給眼區
        rest = ImageChops.subtract(ImageChops.subtract(d, eye_hit), mouth_hit)
        tint = 0
        stray = 0
        for comp in components(rest):
            b = comp.getbbox()
            if b and b[0] >= face_box[0] and b[1] >= face_box[1] and b[2] <= face_box[2] and b[3] <= face_box[3]:
                tint += count(comp)   # 臉框內、離眼嘴基準區都遠＝臉上的底色（紅暈）→ 交給 static 區
            else:
                stray += count(comp)
                print(f"  FAIL: {p.name} changed outside the face, bbox {b} ({count(comp)} px); only the eyes, the mouth and the face tint may change")
                failed = True
        eye_n, mouth_n = count(eye_hit), count(mouth_hit)
        eye_role, mouth_role = roles_from_name(p.name)
        letter = ROLE_LETTER.get((eye_role or "open", mouth_role or "0"), "A")
        print(f"  {p.name}: eye diff {eye_n} px | mouth diff {mouth_n} px | face tint {tint} px | outside face {stray} px | "
              f"role eye={eye_role} mouth={mouth_role} (base frame {letter})")
        eye_union = ImageChops.lighter(eye_union, eye_hit)
        mouth_union = ImageChops.lighter(mouth_union, mouth_hit)
        srcs.append(Src(p, im, eye_n, mouth_n, eye_role, mouth_role, letter))
    if failed:
        return 1

    # （舊的「分界護欄」保險絲已移除：歸屬半徑改制後 eye_union ⊆ allowed_eye 恆成立＝那條
    # 永遠不會叫，每張還白花 4 次 count()。取而代之的是切完之後的「覆蓋保險絲」，見下方
    # 「保險絲：每一顆差異都要有貼片接住」——那條會真的叫。）

    # 表情自己的眼軸／嘴軸運動（交多張時）：基準張 vs 同軸另一態的差異。這些像素**一定**要
    # 落在對應區的貼片裡——被另一區或底色區蓋住＝那一塊會凍在基準張的樣子（實測：角色講話
    # 時人中、法令紋一帶有 82 px 卡在閉嘴的樣子）。等於把「基準區」的概念在表情自己身上再跑
    # 一次：底圖用 A vs D/G、A vs B/C 定義眼嘴會動的範圍，表情圖也照做。單張表情沒有同軸另
    # 一態＝兩張遮罩都是空的，切法與改版前逐位元組相同。
    # 基準張優先序：精確眼開＋嘴閉最優，其次退而求其次只鎖眼開／只鎖嘴閉，
    # 最後才是完全沒角色的泛用檔名（單張表情兜底用）。next() 逐層掃過 srcs，第一個命中即得。
    REF_PRIORITY = (("open", "0"), ("open", None), (None, "0"), (None, None))
    ref = next((s for role in REF_PRIORITY for s in srcs if (s.eye_role, s.mouth_role) == role), None)
    if ref is None and len(srcs) > 1:
        print("FAIL: no reference image (eyes open, mouth closed). Name a multi-image set A to I (A = eyes open, mouth closed), "
              "or include at least one image whose name marks it as eyes open and mouth closed")
        return 1
    if ref is not None and len(srcs) > 1:
        eye_motion = Image.new("L", (W, H), 0)
        mouth_motion = Image.new("L", (W, H), 0)
        ref_flat = flat(ref.im)
        for s in srcs:
            if s is ref:
                continue
            d_own = diff_mask(flat(s.im), ref_flat)
            if s.eye_role != ref.eye_role and s.mouth_role == ref.mouth_role:
                eye_motion = ImageChops.lighter(eye_motion, d_own)
            elif s.mouth_role != ref.mouth_role and s.eye_role == ref.eye_role:
                mouth_motion = ImageChops.lighter(mouth_motion, d_own)
        # 運動只認基準區附近：源圖若是生成工具逐張重繪，A vs D/G、A vs B/C 的差異會散到
        # 髮絲／頰邊／下顎；不限界的話眼區會吞到頭髮、嘴區會吞到額頭——每個眼態／嘴型各帶自己那張的
        # 微抖版本，眨眼講話時那些地方就在版本間跳（＝肉眼看到「這個表情怪怪的」的來源）。基準區外擴
        # MOTION_REACH 內的才算真運動，其餘不進任何區（也不進 static，只算進還原殘差）。
        # dilate 拆兩步（15+15）等價 30 但快一倍（MaxFilter 核 31² ×2 vs 61²）。
        half = MOTION_REACH // 2
        eye_motion_all, mouth_motion_all = count(eye_motion), count(mouth_motion)
        eye_motion = ImageChops.multiply(eye_motion, dilate(dilate(eye_base, half), MOTION_REACH - half))
        mouth_motion = ImageChops.multiply(mouth_motion, dilate(dilate(mouth_base, half), MOTION_REACH - half))
        if eye_motion_all - count(eye_motion) or mouth_motion_all - count(mouth_motion):
            print(f"  motion reach (reference box padded by {MOTION_REACH}): eye axis dropped {eye_motion_all - count(eye_motion)} px far away | "
                  f"mouth axis dropped {mouth_motion_all - count(mouth_motion)} px far away (generator jitter, not part of the region)")
        eye_union = ImageChops.lighter(eye_union, ImageChops.multiply(eye_motion, allowed_eye))
        mouth_union = ImageChops.lighter(mouth_union, ImageChops.multiply(mouth_motion, allowed_mouth))
        # 眼區讓位：嘴自己會動的地方（外擴 MARGIN、且在嘴區的允許範圍內）交給嘴貼片接手，眼區
        # 不准蓋——嘴區最後會扣掉眼區已佔像素，不先讓位的話那一塊兩邊都不接、直接凍住。
        # 只讓「嘴區確實吃得下」的像素（∩ allowed_mouth ∧ 在 mouth_union 外擴 MARGIN 內），不留破洞。
        allowed_eye = ImageChops.multiply(
            allowed_eye, ImageChops.invert(ImageChops.multiply(dilate(mouth_motion, MARGIN), allowed_mouth)))
        print(f"expression's own motion: eye axis {count(eye_motion)} px | mouth axis {count(mouth_motion)} px (each merged into its region)")

    eye_zone = ImageChops.multiply(feather(close_and_dilate(eye_union)), allowed_eye)
    # 嘴區再扣掉眼區已佔像素（兩區中間那幾像素帶兩邊都「允許」，得有人讓）：
    # 嘴基準區被護欄擋在眼區之外，扣完嘴區仍完整蓋住自己的基準區。
    mouth_zone = ImageChops.multiply(feather(close_and_dilate(mouth_union)), allowed_mouth)
    mouth_zone = ImageChops.multiply(mouth_zone, ImageChops.invert(eye_zone.point(lambda v: 255 if v > 0 else 0)))
    overlap = count(ImageChops.multiply(eye_zone.point(lambda v: 255 if v > 0 else 0),
                                        mouth_zone.point(lambda v: 255 if v > 0 else 0)))
    if overlap:
        print(f"FAIL: the eye and mouth regions still overlap by {overlap} px (should not happen; please report it)")
        return 1

    result = {"id": args.name, "label": args.label, "size": [W, H], "eyes": {}, "mouth": {},
              "zoneEye": eye_zone.getbbox(), "zoneMouth": mouth_zone.getbbox()}

    def cut(im, zone, tag):
        # PSD 匯出在臉部裡會散落 alpha 249-254 的像素（實測：來源圖 2.6k 顆、
        # 底圖 A 本身 10k 顆＝匯出雜訊、肉眼全不透明）——≥240 一律當不透明補成 255，
        # 免得貼片內留 2% 見底的針孔；真正的半透明（髮絲外緣 <240）照留。
        src_alpha = im.split()[3].point(lambda v: 255 if v >= 240 else v)
        alpha = ImageChops.multiply(src_alpha, zone)
        # 區外 RGB 歸零（alpha 0 的像素 PNG 仍會存 RGB＝白白撐大檔案 2MB→~100KB）；
        # 用 0/255 遮罩相乘＝區內 RGB 原樣、區外 0，不會把羽化邊預乘變暗。
        keep = alpha.point(lambda v: 255 if v > 0 else 0)
        r, g, b, _ = im.split()
        patch = Image.merge("RGBA", (ImageChops.multiply(r, keep), ImageChops.multiply(g, keep),
                                     ImageChops.multiply(b, keep), alpha))
        ext = "png" if args.png else "webp"
        fn = f"{args.name}_{tag}.{ext}"
        for o in outs:
            if args.png:
                patch.save(o / fn, optimize=True)
            else:
                patch.save(o / fn, "WEBP", lossless=True, quality=100, method=6)
        # 底色區沒有「基準區」要蓋（它蓋的是底圖各幀都一模一樣的臉頰），跳過蓋滿檢查
        if tag == "static":
            print(f"  -> {fn}  alpha bbox {alpha.getbbox()}  (tint patch: no coverage check against a reference box)")
            return fn, 0
        # 蓋滿檢查：基準區每個像素在貼片裡都必須不透明（≥240 視為不透明）
        base_zone = eye_base if tag.startswith("eye") else mouth_base
        holes = count(ImageChops.multiply(base_zone, alpha.point(lambda v: 255 if v < 240 else 0)))
        print(f"  -> {fn}  alpha bbox {alpha.getbbox()}  reference-box pixels left uncovered {holes}  {'PASS' if holes == 0 else 'FAIL'}")
        return fn, holes

    # 只交一張＝這個表情就只有一態（不管檔名帶不帶角色），鍵一律 any——引擎退化鏈的最後
    # 一站，底圖眨到哪一態都貼得上；若照字母記成 open，底圖一眨眼（closed）就找不到貼片。
    single = len(srcs) == 1
    for s in srcs:
        im, eye_role, mouth_role = s.im, s.eye_role, s.mouth_role
        if s.eye_n:
            if single:
                fn, holes = cut(im, eye_zone, "eye_any"); result["eyes"]["any"] = fn; failed |= bool(holes)
            elif eye_role and (mouth_role in (None, "0")):
                fn, holes = cut(im, eye_zone, f"eye_{eye_role}"); result["eyes"][eye_role] = fn; failed |= bool(holes)
        if s.mouth_n and not args.eyes_only:
            if single:
                fn, holes = cut(im, mouth_zone, "mouth_any"); result["mouth"]["any"] = fn; failed |= bool(holes)
            elif mouth_role and (eye_role in (None, "open")):
                fn, holes = cut(im, mouth_zone, f"mouth_{mouth_role}"); result["mouth"][mouth_role] = fn; failed |= bool(holes)

    # 底色區：基準張＝眼開＋嘴 0 那張（單張表情＝那張本身）。低門檻只在臉框內
    # 找差異，扣掉眼嘴兩區（那兩區各自的貼片會蓋），再閉運算補洞、外擴回去跟眼嘴區重疊一段
    # （底色畫在下面，重疊帶讓兩張貼片的羽化邊之間不會露出「沒上色的臉」）。
    static_fn = None
    static_zone = None
    if args.eyes_only:
        print("tint region: --eyes-only, skipped (mouth and tint differences count as whole-face jitter and are not frozen)")
    elif ref is None:
        print("tint region: no reference image (eyes open, mouth 0), skipped")
    else:
        static_raw = ImageChops.multiply(diff_mask(flat(ref.im), A, STATIC_THRESH), face_mask)
        static_raw = ImageChops.subtract(static_raw, eye_zone.point(lambda v: 255 if v > 0 else 0))
        static_raw = ImageChops.subtract(static_raw, mouth_zone.point(lambda v: 255 if v > 0 else 0))
        # 表情若某區一態都沒給（＝底圖照動），底色區也要避開那個基準區——不然基準張的眼睛／
        # 嘴會被凍在 static 上，底圖翻到別態就對不起來。
        if not result["eyes"]:
            static_raw = ImageChops.subtract(static_raw, dilate(eye_base, MARGIN))
        if not result["mouth"]:
            static_raw = ImageChops.subtract(static_raw, dilate(mouth_base, MARGIN))
        n_static = count(static_raw)
        if n_static >= STATIC_MIN_PX:
            print(f"tint region: {ref.path.name} vs base A differs by {n_static} px inside the face box at the low threshold (>{STATIC_THRESH}); cutting a static patch")
            static_zone = static_raw.filter(ImageFilter.MaxFilter(25)).filter(ImageFilter.MinFilter(25))
            static_zone = ImageChops.multiply(feather(dilate(static_zone, MARGIN)), face_mask)
            static_fn, _ = cut(ref.im, static_zone, "static")
            result["static"] = static_fn
            result["zoneStatic"] = static_zone.getbbox()
        else:
            print(f"tint region: only {n_static} px differ inside the face box at the low threshold (>{STATIC_THRESH}) (< {STATIC_MIN_PX}); no tint region, no patch")
    if args.blush == "builtin":
        result["blush"] = "builtin"

    # 保險絲：每一顆差異都要有貼片接住。臉框內的變動先前只是被歸進底色桶就放行，底色區若
    # 因為量太少（< STATIC_MIN_PX）根本沒切出來，那些像素就沒人接——只剩還原殘差那 786 px
    # 的額度在擋，量少就靜默過關（實測：額頭上放一塊 8x8＝64 px 的變動，改版前直接 PASS）。
    # 這裡拿「真的有切出貼片的區」做聯集逐張驗：沒切眼態就不算眼區、沒切嘴態就不算嘴區、
    # 沒有 static 就不算底色區——區存在但沒貼片＝那塊實際上是空的，不能當成蓋住。
    covered = Image.new("L", (W, H), 0)
    if result["eyes"]:
        covered = ImageChops.lighter(covered, eye_zone.point(lambda v: 255 if v > 0 else 0))
    if result["mouth"]:
        covered = ImageChops.lighter(covered, mouth_zone.point(lambda v: 255 if v > 0 else 0))
    if static_zone is not None:
        covered = ImageChops.lighter(covered, static_zone.point(lambda v: 255 if v > 0 else 0))
    if not result["eyes"] and not result["mouth"] and not static_fn:
        print("FAIL: this expression produced no patch at all (0 eye states, 0 mouth states, no tint region); an empty expression is not written to the manifest")
        return 1
    for s in srcs:
        miss = ImageChops.subtract(diff_mask(flat(s.im), A), covered)
        if args.eyes_only:
            # 眼區可及範圍以外的差異＝刻意不要的（嘴沿用平常口型／整臉微抖不凍）——豁免，但把量印出來；
            # 真正的守門交給下面的還原殘差上限（忽略太多＝殘差超標＝FAIL）。
            ignored = ImageChops.subtract(miss, eye_reach.point(lambda v: 255 if v > 0 else 0))
            n_ign = count(ignored)
            if n_ign:
                print(f"  --eyes-only: ignoring {s.path.name} differences outside the eye region, {n_ign} px, bbox {ignored.getbbox()} (not cut, not covered, counted into the rebuild residual)")
            miss = ImageChops.subtract(miss, ignored)
        n_miss = count(miss)
        if n_miss:
            # 成塊 vs 零星：5×5 MinFilter 後還有像素＝有一塊實心 ≥5×5 的改動沒人接（例如真的多
            # 點了顆痣、或 8×8 的人工測試案例）＝FAIL 照舊；濾完全空＝只剩細線散點（生成微抖）且總量
            # < STATIC_MIN_PX ＝印警告放行、算進還原殘差（殘差上限仍是最後一道門）。
            core = miss.filter(ImageFilter.MinFilter(SPECK_CORE))
            if count(core) == 0 and n_miss < STATIC_MIN_PX:
                print(f"  WARN: {s.path.name} has {n_miss} px of scattered uncovered change, bbox {miss.getbbox()} (no solid block of {SPECK_CORE}x{SPECK_CORE} or more = generator jitter, "
                      f"not cut, not covered, counted into the rebuild residual)")
                continue
            print(f"FAIL: {s.path.name} has change inside the face box that no patch covers, bbox {miss.getbbox()} ({n_miss} px, solid {count(core)} px); "
                  f"that area would show the base frame through. Check that the change sits on the eyes or the mouth, or that the tint region is large enough (>= {STATIC_MIN_PX} px)")
            return 1

    eyes_n, mouth_n = len(result["eyes"]), len(result["mouth"])
    if args.mode == "auto":
        result["mode"] = "flash" if (set(result["mouth"].keys()) == {"any"} and eyes_n <= 1) else "sustain"
    else:
        result["mode"] = args.mode

    # 逐張還原驗證：底圖對應字母 → 疊 static → 疊該態眼貼片 → 疊該態嘴貼片（退化鏈與
    # expression.js 的 _pickEye／_pickMouth 同步），跟原圖比殘差。讀的是剛剛真的寫出去
    # 的檔（不是記憶體裡的影像）＝連編碼一起驗。>24 殘差上限＝畫布 0.05%（羽化帶疊在半透明
    # 髮絲上會有幾十像素的合成誤差，不是接縫）。
    patch_cache = {}

    def patch(fn):
        if fn not in patch_cache:
            patch_cache[fn] = Image.open(outs[0] / fn).convert("RGBA")
        return patch_cache[fn]

    def pick_eye(state):
        e = result["eyes"]
        return e.get(state) or (e.get("open") if state == "half" else None) or e.get("any")

    def pick_mouth(state):
        m = result["mouth"]
        return m.get(state) or (m.get("2") if state == "1" else None) or m.get("any")

    limit = 0.0005 * W * H
    print(f"rebuilding each source image (eyes {eyes_n} states / mouth {mouth_n} states / tint {'yes' if static_fn else 'no'} | "
          f"residual limit over 24: {int(limit)} px):")
    for s in srcs:
        comp = flat(base(s.letter)).convert("RGBA")
        for fn in (static_fn, pick_eye(s.eye_role or "open"), pick_mouth(s.mouth_role or "0")):
            if fn:
                comp.alpha_composite(patch(fn))
        dr = ImageChops.difference(comp.convert("RGB"), flat(s.im)).convert("L")
        r24 = count(dr.point(lambda v: 255 if v > THRESH else 0))
        r8 = count(dr.point(lambda v: 255 if v > 8 else 0))
        ok = r24 <= limit
        print(f"  rebuild {s.path.name}: residual {r24} px (>24) / {r8} px (>8)  {'PASS' if ok else 'FAIL'}")
        if not ok:
            failed = True

    # 保險絲：走到這裡 failed 可能是「基準區未蓋滿」（holes）或還原殘差超標
    # 累積出來的軟 FAIL——前面只記了旗標、沒有立刻 return，讓貼片檔照樣落地方便開圖看哪裡歪。
    # 但 json／manifest 絕不能在 FAIL 時寫：manifest 一寫，引擎下次讀到 expressions.<id> 就會
    # 拿一批沒過驗證的貼片上場；json 一寫，試妝間也會把壞掉的狀態當正式資料。宣告不寫＝引擎
    # 看不到這個表情，跟沒切過一樣安全；貼片檔留在 --out 資料夾給人工檢視根因，不影響安全性。
    if failed:
        print("RESULT: FAIL. json not written, manifest not merged (the patch files are on disk for inspection; with no declaration the engine never sees them)")
        return 1

    for o in outs:
        (o / f"{args.name}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"json → {o / (args.name + '.json')}")
    # manifest 合併：expressions.<id>＝{label, mode, [blush], [static], eyes:{state: "expr/<file>"}, mouth:{…}}
    # （路徑相對 assetsPath；blush／static 沒有就不寫這個鍵——引擎兩個鍵都是可選的）
    for mp in args.manifest:
        mpath = Path(mp)
        m = json.loads(mpath.read_text(encoding="utf-8"))
        table = m.setdefault("expressions", {})
        table[args.name] = {
            "label": args.label,
            "mode": result["mode"],
            **({"blush": result["blush"]} if result.get("blush") else {}),
            **({"static": f"expr/{result['static']}"} if result.get("static") else {}),
            "eyes": {k: f"expr/{v}" for k, v in result["eyes"].items()},
            "mouth": {k: f"expr/{v}" for k, v in result["mouth"].items()},
        }
        mpath.write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"manifest ← expressions.{args.name}: {mpath}")
    print("RESULT:", "FAIL" if failed else "PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
