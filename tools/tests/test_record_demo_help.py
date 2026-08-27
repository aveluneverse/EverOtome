"""record_demo.py --help must work even when playwright is not importable — it only needs
playwright right before it launches a browser, well after argument parsing is done. Run with
-S (skip site-packages) so a normally pip-installed playwright is not on sys.path, proving the
top-level `from playwright.sync_api import sync_playwright` really moved out of module scope.
A bad segment name is existing behaviour (SystemExit before playwright is ever touched); this
just pins it with a real test."""
import subprocess
import sys
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / "record_demo.py"


def test_help_prints_usage_without_needing_playwright():
    r = subprocess.run([sys.executable, "-S", str(TOOL), "--help"], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "usage" in r.stdout.lower()
    assert "--lang" in r.stdout


def test_unknown_segment_still_fails_cleanly():
    r = subprocess.run([sys.executable, str(TOOL), "nonsense-segment"], capture_output=True, text=True)
    out = r.stdout + r.stderr
    assert r.returncode == 1, out
    assert "[abort]" in out
