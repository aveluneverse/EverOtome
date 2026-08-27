"""examples/everthine-adapter/companion_server.py: --help works anywhere and touches nothing; run outside an
Everthine folder it aborts with a sentence that says so and the feedback line. The live run against
Everthine's code is done by hand (see the SDD ledger), not here."""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / "examples" / "everthine-adapter" / "companion_server.py"
FEEDBACK = "Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup"
CJK = re.compile(r"[\u4e00-\u9fff]")


def test_help_needs_nothing_and_writes_nothing(tmp_path):
    r = subprocess.run([sys.executable, "-S", str(ADAPTER), "--help"], capture_output=True, text=True, cwd=tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "usage" in r.stdout.lower() and "--with-telegram" in r.stdout
    assert not CJK.search(r.stdout), r.stdout
    assert list(tmp_path.iterdir()) == []


def test_outside_an_everthine_folder_aborts(tmp_path):
    r = subprocess.run([sys.executable, str(ADAPTER)], capture_output=True, text=True, cwd=tmp_path)
    out = r.stdout + r.stderr
    assert r.returncode == 1, out
    assert "[abort]" in out and "Everthine folder" in out and FEEDBACK in out
    assert list(tmp_path.iterdir()) == []
