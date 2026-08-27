"""gen_expression.py's failure exits carry the feedback box (Mira 2026-08-27 rule: every
user-facing error path). Only the argument/setup-stage exit (missing base frame) is covered
here — it is the one that is cheap to trigger without building a full valid nine-frame
fixture; the other five FAIL exits deep in the pixel-diffing pipeline (no reference image,
eye/mouth region overlap, empty expression, uncovered face-box change, canvas-size drift)
got the identical one-line suffix but are not independently exercised by a dedicated test
here — this tool has no existing pytest coverage to extend, and building synthetic frames
that hit each of those branches precisely is a separate, larger undertaking than the text
change itself."""
import subprocess
import sys
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / "gen_expression.py"
FEEDBACK_LINE = "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup"


def test_missing_base_frame_carries_feedback_box(tmp_path):
    base_dir = tmp_path / "base"
    base_dir.mkdir()  # empty: no A.png/A.webp, so base("A") fails before --src is ever opened
    out_dir = tmp_path / "out"
    r = subprocess.run(
        [sys.executable, str(TOOL), "--name", "x", "--base", str(base_dir),
         "--src", str(tmp_path / "nonexistent.png"), "--out", str(out_dir)],
        capture_output=True, text=True,
    )
    out = r.stdout + r.stderr
    assert r.returncode == 1, out
    assert "FAIL: base frame A.png/.webp missing" in out
    assert FEEDBACK_LINE in out
