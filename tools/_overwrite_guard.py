# -*- coding: utf-8 -*-
"""Shared refuse-to-overwrite check for the tools that regenerate shipped files.

The repo ships hand-made assets in the very paths these generators write to
(Rye's manifest, the brand icons, the theme frames, the sample ringtone). A bare
run must therefore stop before touching anything; only --force regenerates."""
from __future__ import annotations

import argparse
from pathlib import Path


def add_force_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("-f", "--force", action="store_true",
                        help="overwrite the shipped files that already exist at the output paths")


def refuse_unless_force(targets: list, force: bool, label: str) -> int:
    """Return 0 when writing may proceed, 1 after printing the abort line.

    targets: the exact files the caller is about to write
    label:   a short name for the output location used in the message"""
    existing = [Path(p) for p in targets if Path(p).exists()]
    if not existing or force:
        return 0
    names = ", ".join("/".join(p.parts[-2:]) for p in existing[:6]) + (", ..." if len(existing) > 6 else "")
    print(f"[abort] {len(existing)} shipped file(s) already exist in {label} ({names}). "
          f"Nothing was written. Re-run with --force to overwrite them. "
          f"Stuck? Tell us: https://marshmallow-qa.com/a4u0myommjpyzup")
    return 1
