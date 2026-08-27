# tools/

Maintainer scripts, plus one check for people connecting a backend. **Nothing in this folder is needed to run EverOtome.** While you wire in a backend, `check_integration.py` is the one script worth running; the rest regenerate shipped assets, and an AI assistant helping you set the project up does not need to run them.

| Script | What it does | Who needs it |
|---|---|---|
| `check_integration.py` | Checks a server that hosts EverOtome: shell served, WebSocket answers a message with a well-formed reply, optional endpoints have the right shape. Standard library only; see `docs/integration-guide.md` | Anyone connecting a backend, and the AI helping them |
| `gen_expression.py` | Cuts expression patches out of full-body art you drew (see `docs/sprite-guide.md`) | People adding expressions to their own character |
| `check_alignment.py` | Checks that the nine sprite frames line up | Same |
| `make_cg_safe_zone.py` | Redraws the CG safe-zone templates in `docs/` | Maintainers, after a layout change |
| `make_placeholder_icons.py` | Regenerates placeholder favicon and app icons; refuses unless `--force`, and `--force` replaces the shipped brand icons | Self-hosters who want temporary icons |
| `gen_theme_frames.py` | Regenerates the per-theme Chat Log frame SVGs; refuses unless `--force` | Maintainers |
| `make_sample_ringtone.py` | Regenerates the placeholder ringtone; refuses unless `--force` | Maintainers |
| `record_demo.py` | Records the demo videos with Playwright | Maintainers |
| `_overwrite_guard.py` | Shared helper the three regenerators import for their `--force` check; not a command | Nobody runs it directly |

`--help` on each command listed above prints usage and writes nothing; for `gen_expression.py`, `check_alignment.py` and `make_cg_safe_zone.py` it needs Pillow installed first, because they import it at the top. `check_integration.py` needs nothing installed. The three regenerators (`make_placeholder_icons.py`, `gen_theme_frames.py`, `make_sample_ringtone.py`) refuse to overwrite shipped files unless you pass `--force`. `make_cg_safe_zone.py` has no `--force`: it redraws the safe-zone templates in `docs/` every time it runs, so run it only after a layout change. Dependencies: Pillow (`pip install pillow`) for the image scripts (`gen_expression.py`, `check_alignment.py`, `make_cg_safe_zone.py`, and `make_placeholder_icons.py` when it actually draws), pydub plus ffmpeg on `PATH` for `make_sample_ringtone.py`, Playwright for `record_demo.py`.

Tests: from the repository root, `pip install pytest pillow` once, then `python -m pytest tools/tests` (the engine's own suite is `cd engine && npm install && npm test`).

Stuck? Tell us: [marshmallow-qa.com/a4u0myommjpyzup](https://marshmallow-qa.com/a4u0myommjpyzup)
