import subprocess, sys
from pathlib import Path
from PIL import Image

TOOL = Path(__file__).resolve().parents[1] / "make_cg_safe_zone.py"
GREEN = (110, 235, 160)

EXPECTED = {
    "cg-safe-zone-desktop.png": (2560, 1440),
    "cg-safe-zone-mobile.png": (1440, 3120),
    "cg-safe-zone-desktop-zh.png": (2560, 1440),
    "cg-safe-zone-mobile-zh.png": (1440, 3120),
}

def _run(*args):
    return subprocess.run([sys.executable, str(TOOL), *args], capture_output=True, text=True)

def test_writes_four_transparent_templates(tmp_path):
    r = _run("--out", str(tmp_path))
    assert r.returncode == 0, r.stdout + r.stderr
    for name, size in EXPECTED.items():
        im = Image.open(tmp_path / name)
        assert im.size == size, name
        assert im.mode == "RGBA", name
        assert im.getchannel("A").getextrema()[0] == 0, f"{name}: background must stay transparent"
    en = Image.open(tmp_path / "cg-safe-zone-desktop.png").tobytes()
    zh = Image.open(tmp_path / "cg-safe-zone-desktop-zh.png").tobytes()
    assert en != zh, "the two languages must render different labels"

def test_sweet_zone_and_face_center_sit_at_the_measured_place(tmp_path):
    assert _run("--out", str(tmp_path)).returncode == 0
    desk = Image.open(tmp_path / "cg-safe-zone-desktop.png").convert("RGBA")
    assert desk.getpixel((800, 175))[:3] == GREEN   # top edge of the sweet zone (y 172-179)
    assert desk.getpixel((387, 400))[:3] == GREEN   # left edge (x 384-391)
    assert desk.getpixel((768, 432))[:3] == GREEN   # face-center dot at (30%, 30%)
    mob = Image.open(tmp_path / "cg-safe-zone-mobile.png").convert("RGBA")
    assert mob.getpixel((720, 315))[:3] == GREEN    # top edge (y 312-319)
    assert mob.getpixel((720, 748))[:3] == GREEN    # face-center dot at (50%, 24%)

def test_lang_filter_writes_only_that_pair(tmp_path):
    assert _run("--out", str(tmp_path), "--lang", "en").returncode == 0
    names = sorted(p.name for p in tmp_path.iterdir())
    assert names == ["cg-safe-zone-desktop.png", "cg-safe-zone-mobile.png"]

def test_explicit_missing_font_path_aborts(tmp_path):
    r = _run("--out", str(tmp_path), "--font-cjk", str(tmp_path / "nope.ttf"))
    assert r.returncode != 0
    out = r.stdout + r.stderr
    assert "[abort]" in out
    assert "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup" in out  # Mira 2026-08-27 rule
