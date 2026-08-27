# tools/

Maintainer scripts. **Nothing in this folder is needed to run EverOtome or to connect a backend**, and an AI assistant helping you set the project up does not need to run any of them.

| Script | What it does | Who needs it |
|---|---|---|
| `gen_expression.py` | Cuts expression patches out of full-body art you drew (see `docs/sprite-guide.md`) | People adding expressions to their own character |
| `check_alignment.py` | Checks that the nine sprite frames line up | Same |
| `make_cg_safe_zone.py` | Redraws the CG safe-zone templates in `docs/` | Maintainers, after a layout change |
| `make_placeholder_icons.py` | Regenerates placeholder favicon and app icons; refuses unless `--force`, and `--force` replaces the shipped brand icons | Self-hosters who want temporary icons |
| `gen_theme_frames.py` | Regenerates the per-theme Chat Log frame SVGs; refuses unless `--force` | Maintainers |
| `make_sample_ringtone.py` | Regenerates the placeholder ringtone; refuses unless `--force` | Maintainers |
| `record_demo.py` | Records the demo videos with Playwright | Maintainers |

`--help` on any script is safe: it prints usage and writes nothing. The three regenerators refuse to overwrite shipped files unless you pass `--force`. The image scripts need Pillow (`pip install pillow`).
