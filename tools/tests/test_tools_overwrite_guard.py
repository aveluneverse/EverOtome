"""The three regenerating tools must never touch shipped files unless asked with --force.
Each tool locates the repo root from its own __file__, so a copy of the tool inside a
temporary fake repo (tmp/tools/<tool>.py + tmp/engine/...) exercises the real code paths
without touching the real engine/ tree."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1]
SENTINEL = b"shipped-bytes-do-not-touch"

# tool file -> the files (relative to the fake repo root) it would overwrite
TARGETS = {
    "make_placeholder_icons.py": ["engine/favicon.png", "engine/app-icon-180.png",
                                  "engine/app-icon-192.png", "engine/app-icon-512.png"],
    "gen_theme_frames.py": [f"engine/assets/themes/{t}/chatlog-frame.svg"
                            for t in ("snow-palace", "crimson-nocturne", "rose-vow", "verdant-dawnsong")],
    "make_sample_ringtone.py": ["engine/assets/sample/ring.mp3"],
}

# gen_theme_frames.py reads this source frame; it must contain the five crystal-swan colours
SRC_FRAME = ("engine/assets/themes/crystal-swan/chatlog-frame.svg",
             '<svg><path stroke="#bedaff"/><path stroke="#e5f0ff"/><feFlood flood-color="#cfe2ff"/>'
             '<feFlood flood-color="#6fa5ff"/><path fill="rgba(125, 155, 212, 0.16)"/></svg>')


def fake_repo(tmp_path, tool):
    """Copy the tool + guard helper into tmp/tools and pre-create every target with sentinel bytes."""
    (tmp_path / "tools").mkdir()
    shutil.copy(TOOLS / tool, tmp_path / "tools" / tool)
    shutil.copy(TOOLS / "_overwrite_guard.py", tmp_path / "tools" / "_overwrite_guard.py")
    for rel in TARGETS[tool]:
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(SENTINEL)
    src = tmp_path / SRC_FRAME[0]
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text(SRC_FRAME[1], encoding="utf-8")
    return tmp_path / "tools" / tool


def run(tool_path, *args):
    return subprocess.run([sys.executable, str(tool_path), *args], capture_output=True, text=True)


def untouched(tmp_path, tool):
    return all((tmp_path / rel).read_bytes() == SENTINEL for rel in TARGETS[tool])


@pytest.mark.parametrize("tool", sorted(TARGETS))
def test_help_prints_usage_and_writes_nothing(tmp_path, tool):
    r = run(fake_repo(tmp_path, tool), "--help")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "usage" in r.stdout.lower()
    assert "--force" in r.stdout
    assert untouched(tmp_path, tool)


@pytest.mark.parametrize("tool", sorted(TARGETS))
def test_bare_run_refuses_when_targets_exist(tmp_path, tool):
    r = run(fake_repo(tmp_path, tool))
    out = r.stdout + r.stderr
    assert r.returncode == 1, out
    assert "[abort]" in out
    assert "--force" in out
    assert f"{len(TARGETS[tool])} shipped file(s)" in out   # the count of files it would overwrite
    assert untouched(tmp_path, tool)


@pytest.mark.parametrize("tool", ["make_placeholder_icons.py", "gen_theme_frames.py"])
def test_force_regenerates(tmp_path, tool):
    if tool != "gen_theme_frames.py":
        pytest.importorskip("PIL")
    r = run(fake_repo(tmp_path, tool), "--force")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not untouched(tmp_path, tool)
    for rel in TARGETS[tool]:
        assert (tmp_path / rel).stat().st_size > 0


def test_guard_helper_speaks_for_itself(tmp_path):
    sys.path.insert(0, str(TOOLS))
    from _overwrite_guard import refuse_unless_force
    a, b = tmp_path / "a.txt", tmp_path / "b.txt"
    a.write_bytes(b"x")
    assert refuse_unless_force([a, b], force=False, label="sample") == 1
    assert refuse_unless_force([a, b], force=True, label="sample") == 0
    assert refuse_unless_force([b], force=False, label="sample") == 0   # nothing to overwrite


def test_abort_line_carries_the_feedback_box(tmp_path, capsys):
    """Mira 2026-08-27 rule: every user-facing error path carries the feedback box."""
    sys.path.insert(0, str(TOOLS))
    from _overwrite_guard import refuse_unless_force
    a = tmp_path / "a.txt"
    a.write_bytes(b"x")
    refuse_unless_force([a], force=False, label="sample")
    out = capsys.readouterr().out
    assert "[abort]" in out
    assert "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup" in out
