import subprocess, sys
from pathlib import Path
from PIL import Image

TOOL = Path(__file__).resolve().parents[1] / "check_alignment.py"

def _make_set(tmp_path, tamper=False):
    base = Image.new("RGBA", (100, 150), (200, 180, 160, 255))
    for name in "ABCDEF":
        img = base.copy()
        if name in "BCEF":  # 嘴區差分：只在「嘴區」(40,90)-(60,105) 動
            img.paste((120, 60, 60, 255), (40, 90, 60, 105))
        if name in "DEF":   # 眼區差分：只在「眼區」(30,50)-(70,60) 動
            img.paste((90, 70, 60, 255), (30, 50, 70, 60))
        if tamper and name == "C":  # 污染：頭髮區亂動＝差分做壞
            img.paste((0, 0, 0, 255), (10, 10, 30, 30))
        img.save(tmp_path / f"{name}.png")

def _run(d):
    return subprocess.run([sys.executable, str(TOOL), str(d)],
                          capture_output=True, text=True)

def test_clean_set_passes(tmp_path):
    _make_set(tmp_path)
    r = _run(tmp_path)
    assert r.returncode == 0
    assert "PASS" in r.stdout

FEEDBACK_LINE = "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup"

def test_tampered_set_fails_and_names_culprit(tmp_path):
    _make_set(tmp_path, tamper=True)
    r = _run(tmp_path)
    assert r.returncode == 1
    assert "FAIL: C" in r.stdout  # 指名哪張要重生（緊扣 FAIL 摘要行，不吃到逐張診斷行裡的 "C"）
    assert FEEDBACK_LINE in r.stdout  # Mira 2026-08-27 rule: every user-facing error path

def test_size_mismatch_fails(tmp_path):
    _make_set(tmp_path)
    Image.new("RGBA", (99, 150)).save(tmp_path / "F.png")
    r = _run(tmp_path)
    assert r.returncode == 1
    assert FEEDBACK_LINE in r.stdout

def test_missing_frame_fails_with_feedback_box(tmp_path):
    _make_set(tmp_path)
    (tmp_path / "F.png").unlink()  # 缺一張——load_set 該直接指名報 FAIL
    r = _run(tmp_path)
    assert r.returncode == 1
    assert "FAIL: missing F.png/.webp" in r.stdout
    assert FEEDBACK_LINE in r.stdout

def test_box_mode_catches_tamper(tmp_path):
    _make_set(tmp_path, tamper=True)
    r = subprocess.run(
        [sys.executable, str(TOOL), str(tmp_path),
         "--eye-box", "30,50,70,60", "--mouth-box", "40,90,60,105"],
        capture_output=True, text=True)
    assert r.returncode == 1
    assert "FAIL: C" in r.stdout


# ── 9 張（眼三態 open/half/closed×嘴三態 closed/half/full）── NAMES 自動偵測 A-I ──
#
# 沿用既有的九幀變化規則：D/G 是「純眼」（只有眼變、嘴維持 A 的閉合），B/C 是「純嘴」
# （只有嘴變、眼維持 A 的睜開），E/F/H/I 是「眼嘴聯集」（兩軸都變）——這個形狀
# 正是 leave-one-out 合法區推定能否認出 9 張版型的關鵼：若 detect_names 沒把
# G/H/I 也納入檢查範圍，污染 H 的測試會偵測不到（回退成只查 A-F，H 根本不在
# 查核範圍內），因此 test_nine_frame_tampered_set_fails_and_names_culprit 是這裡
# 真正有鑑別力的案例（比 clean-passes 更能抓出「9 張偵測沒接上」這種迴歸）。
def _make_nine_set(tmp_path, tamper=False):
    base = Image.new("RGBA", (100, 150), (200, 180, 160, 255))
    eye_box = (30, 50, 70, 60)
    mouth_box = (40, 90, 60, 105)
    eye_paint = {0: None, 1: (90, 70, 60, 255), 2: (50, 30, 20, 255)}      # open/half/closed
    mouth_paint = {0: None, 1: (120, 60, 60, 255), 2: (160, 40, 40, 255)}  # closed/half/full
    spec = {"A": (0, 0), "B": (0, 1), "C": (0, 2),
            "D": (1, 0), "E": (1, 1), "F": (1, 2),
            "G": (2, 0), "H": (2, 1), "I": (2, 2)}
    for name, (eye, mouth) in spec.items():
        img = base.copy()
        if eye_paint[eye]:
            img.paste(eye_paint[eye], eye_box)
        if mouth_paint[mouth]:
            img.paste(mouth_paint[mouth], mouth_box)
        if tamper and name == "H":  # 污染：非眼嘴區（左上角）亂動＝差分做壞
            img.paste((0, 0, 0, 255), (10, 10, 30, 30))
        img.save(tmp_path / f"{name}.png")

def test_nine_frame_clean_set_passes(tmp_path):
    _make_nine_set(tmp_path)
    r = _run(tmp_path)
    assert r.returncode == 0
    assert "PASS" in r.stdout

def test_nine_frame_tampered_set_fails_and_names_culprit(tmp_path):
    _make_nine_set(tmp_path, tamper=True)
    r = _run(tmp_path)
    assert r.returncode == 1
    assert "FAIL: H" in r.stdout

def test_nine_frame_box_mode_catches_tamper(tmp_path):
    _make_nine_set(tmp_path, tamper=True)
    r = subprocess.run(
        [sys.executable, str(TOOL), str(tmp_path),
         "--eye-box", "30,50,70,60", "--mouth-box", "40,90,60,105"],
        capture_output=True, text=True)
    assert r.returncode == 1
    assert "FAIL: H" in r.stdout
