# Sprite frame spec and generation guide

What it takes to make a character blink and talk in EverOtome: nine sprite frames and one small manifest. This guide covers the frame grid, a production order that keeps the set consistent, the manifest format, and the two optional layers that ride on top of it: blush and expressions. It applies to hand-drawn art and AI-generated art alike.

Only have one image? That works too; skip to [Static portrait mode](#static-portrait-mode).

## The 3×3 grid

Full animation uses nine frames, named A through I: three eye states crossed with three mouth states.

|  | Mouth closed | Mouth half open | Mouth open |
|---|---|---|---|
| **Eyes open** | **A** (base) | B | C |
| **Eyes half closed** | D | E | F |
| **Eyes closed** | G | H | I |

The engine picks a frame by looking up (eye state, mouth state) in this grid: blinking sweeps down the eye axis, talking flips along the mouth axis, and both can happen at once (a blink mid-sentence lands on E or F, and it just works).

What each state should look like:

- **Eyes half closed (D/E/F row)**: eyelids relaxed and halfway down, as caught mid-blink. Not a squint or a glare.
- **Eyes closed (G/H/I row)**: eyes resting shut, calm. Not squeezed.
- **Mouth half open**: a natural talking mouth, slightly parted.
- **Mouth open**: a clearly open mouth for stressed syllables. Not a gasp or a shout.

## Production order

The one rule that keeps a set consistent: **each new frame changes exactly one feature, either the eyes or the mouth, from a frame you already have.** Hair, clothes, lighting, outline: not a single line moves. This matters even more for AI generation, where every regenerated pixel is a chance to drift.

1. **Finalize A first** (eyes open, mouth closed). Everything derives from it, so get A exactly right before producing anything else.
2. **From A, change only the eyes** to get **D** (half closed) and **G** (closed). The mouth stays untouched.
3. **From each of A, D, G, change only the mouth** to get the remaining six: A gives B and C, D gives E and F, G gives H and I.

Check the finished set against the 3×3 table before shipping it. If one frame drifted (hair moved, shading shifted), redo that one frame from its parent; the grid makes the odd one out easy to spot by flipping between neighbors.

## Technical spec

- **Same canvas size for all nine frames**, pixel-identical framing. The bundled sample character uses 1024×1536; any size works as long as all frames match.
- **PNG with a transparent background.** The sprite is composited over the room background, so the final frames must carry alpha. (If your generator can't output transparency, generate on a plain solid background and cut it out afterward.)
- Keep the character's position identical across frames; the engine swaps images in place and any shift shows up as jitter.

## manifest.json

Drop the nine frames and a `manifest.json` into one folder (this is the folder `assetsPath` points at):

```json
{
  "size": [1024, 1536],
  "eyeStates": 3,
  "moods": {
    "neutral": {
      "A": "A.png", "B": "B.png", "C": "C.png",
      "D": "D.png", "E": "E.png", "F": "F.png",
      "G": "G.png", "H": "H.png", "I": "I.png"
    }
  }
}
```

- `size`: the frame canvas in pixels, `[width, height]`. Drives the on-stage aspect ratio.
- `eyeStates: 3` declares the nine-frame grid. (Without it, the engine falls back to an older six-frame layout kept for compatibility; new sets should always declare 3.)
- `moods.neutral` is the frame table the engine uses. The file names are yours to choose; the A-I keys are fixed.
- Optional `bottomGap` (a value between 0 and 1): if your canvas has empty space below the feet (common with generated art), declare it here so the sprite sits on the floor instead of floating.

## Static portrait mode

One image, no animation, still composed nicely on stage:

```json
{
  "static": true,
  "image": "portrait.png",
  "size": [1024, 1536]
}
```

The engine skips blinking and mouth animation entirely for this appearance. It also has no frames to follow, so the engine treats the `blush` and `expressions` keys described below as absent on a static appearance. Both of those are for the nine-frame layout.

## Wiring it into config

Point `assetsPath` at the folder, or add it as an outfit in `appearances`:

```json
{
  "assetsPath": "assets/my-character/",
  "appearances": [
    { "id": "default", "label": "My Character", "assetsPath": "assets/my-character/" }
  ]
}
```

Multiple appearances (outfits, alternate looks) each get their own folder and manifest, switchable in the appearance panel.

## Expressions and blush

Two optional layers ride on top of the nine frames: a blush overlay, and expression patches that swap part of the face for a while. Both are declared per appearance in `manifest.json`, and both stay completely silent unless declared.

Both need the nine-frame layout. A static portrait appearance has no stacked frames to sit over and no eye or mouth states to follow, so the engine reads both keys as absent there: declaring them on a static appearance does nothing at all.

## Blush

One image, faded in over the sprite when the character reacts to something. No tool and no extra frames.

Draw it on the same canvas as the nine frames, on a transparent background, and paint only the flush on the cheeks. Leave the rest empty. The engine stacks it over the frames edge to edge, so a matching canvas is what keeps it aligned. Paint it at full strength: the engine dims it for the lighter of the two levels.

Declare it at the top level of `manifest.json`, next to `moods`:

```json
{
  "blush": "blush.webp"
}
```

The file name is yours, and the path is relative to `assetsPath`, the same as the frames.

The backend turns it on by putting a marker in the reply text: `[blush]` for the normal level, `[blush:deep]` for the strong one. The interface strips markers out of every line before it reaches the screen, so they are never visible. See the [backend contract](backend-contract.md) for how the backend sends replies.

The timing, so you know what you are looking at: the layer fades in over 0.9s, holds for 90 seconds, then eases out over 2.8s. A second marker while it is still up resets the hold and updates the level. Switching appearance clears it at once.

An appearance with no `blush` key never blushes. There is no layer, no error, and markers in the reply are still stripped, so a character whose face is covered simply stays as it is.

## Expressions

An expression is a set of patches that replaces part of the face: a different pair of eyes, a different mouth, or both. It sits over the nine frames and follows them, so the character keeps blinking and talking while wearing it.

Expressions are declared per appearance under `expressions`, keyed by id:

```json
{
  "expressions": {
    "smile": {
      "label": "Smile",
      "mode": "flash",
      "eyes": { "any": "expr/smile_eye_any.webp" },
      "mouth": { "any": "expr/smile_mouth_any.webp" }
    },
    "shy": {
      "label": "Shy",
      "mode": "sustain",
      "blush": "builtin",
      "static": "expr/shy_static.webp",
      "eyes": { "open": "expr/shy_eye_open.webp", "half": "expr/shy_eye_half.webp" },
      "mouth": { "0": "expr/shy_mouth_0.webp", "2": "expr/shy_mouth_2.webp" }
    }
  }
}
```

Key by key:

- The id of each entry (`smile`, `shy`) is what the backend refers to. It reaches the interface as `[expr:smile]` in the reply text, and is stripped before display like the blush marker.
- `label` is a display name for the preview page: a string, or one per language, `{ "zh-Hant": "…", "en": "…" }`, the same shape as the labels in `config.json`. The engine itself does not read it.
- `mode` is `"flash"` or `"sustain"`. Any other value, a misspelling and a missing key included, counts as `"sustain"`.
- `eyes` and `mouth` map a face state to one patch file each. Paths are relative to `assetsPath`.
- `static` is optional: a patch that stays on for as long as the expression does, drawn underneath the eye and mouth patches. Use it for a change that covers the rest of the face, such as a tint across both cheeks.
- `blush` is optional and takes exactly one value, `"builtin"`. It says the patches already include a flush, so the engine holds the separate blush layer down while this expression is up and lets it return afterwards. Two flushes stacked read as a muddy blotch.

An id an appearance does not declare does nothing at all: no patch, no error in the console. An appearance with no `expressions` key never shows one. The bundled sample character declares one, `smile`: a single eye patch under `any`, in `flash` mode, with the mouth left to the frames underneath. It carries a `blush` layer as well.

## How many states to provide

The eye states are `open`, `half`, `closed` and `any`. The mouth states are `0` (closed), `1` (half open), `2` (open) and `any`. They are the same two axes as the A-I grid.

Provide what you drew. The engine looks for the exact state first, then falls back:

- Eyes: the exact state, then `open` if the sprite is on `half`, then `any`.
- Mouth: the exact state, then `2` if the sprite is on `1`, then `any`.

A `closed` sprite falls back to `any` only, never to `open`. Open eyes painted over closed lids is the one substitution that always looks wrong, so the engine declines it.

When nothing matches, that region is left alone and the frame underneath shows through. That is the right outcome for an expression that only changes the eyes: the mouth keeps talking on its own.

A single patch under `any` is the smallest expression that works. It stays put whatever the frame does, and it is what the generator writes when you hand it one image.

## flash and sustain

`flash` clears itself after 2.5 seconds. It suits an expression whose patches freeze the mouth, since a frozen mouth cannot talk and only reads as a moment.

`sustain` stays until the character's next reply arrives without an `[expr:...]` marker, with a 90 second cap so it cannot get stuck. It suits expressions that leave the mouth free to move.

Either way the patch fades in over 0.35s and out over 0.6s. Swapping states within one expression is instant, because a blink lasts around 180ms and a cross fade across it smears.

## Generating expression patches

`tools/gen_expression.py` cuts the patches (it needs Pillow, `pip install pillow`; run it from the repository root). Feed it the appearance's frame folder and one or more full-body images of the expression, drawn on the same canvas with nothing changed outside the eyes, the mouth and the face tint:

```
python tools/gen_expression.py --name smile --label Smile \
    --base engine/assets/my-character \
    --src expr-src/smile_A.png \
    --out engine/assets/my-character/expr \
    --manifest engine/assets/my-character/manifest.json
```

What it does: it measures which pixels the base frames actually move (A against D and G for the eyes, A against B and C for the mouth), derives the patch regions from that, cuts the eye and mouth pieces out of your image with a feathered edge, writes them into `--out`, and merges the `expressions.<name>` entry into every `--manifest` you list.

The tool writes `label` as the plain string you pass; if the manifest entry already carries a per-language label object (like the bundled sample), re-running the tool overwrites it, so restore the object or edit the manifest afterwards.

Point `--out` at a folder named `expr` inside the appearance folder. The manifest entry always writes file names with an `expr/` prefix, so that is where the engine will look for them. Alongside the patches the tool drops a `<name>.json` sidecar, a record of what it cut and where. The engine never reads it.

The tool checks its own work. Each source image is rebuilt from its base frame plus the patches and compared against the original, and any change landing outside the eyes, the mouth and the face is reported by file name.

Some checks stop it before it cuts anything, and nothing reaches the output folder in those cases: a missing base frame, a canvas size that does not match the frames, a change outside the face, a set with no reference image, or eye and mouth regions that end up overlapping. The checks that run after cutting leave the patch files on disk so you can open them and see what went wrong: patch coverage, the rebuild residual, and the fuse that requires every changed pixel to be covered by some patch. Either way nothing is written to the manifest, so a failed expression stays invisible to the engine instead of shipping half cut.

The coverage check asks that a patch be fully opaque everywhere the base frames move the eyes or the mouth, so that none of the frame underneath can show through it. Semi-transparent pixels inside that region, hair strands or an accessory drawn across the eyes, make it fail, and the message names the check and counts the pixels. If a patch cannot be cut automatically, the manifest format above stands on its own: patches cut by hand are read exactly the same way.

Two escape hatches, both used on the bundled sample. If your generator re-rendered the whole body, the run stops on a change outside the face; paste the face region of your expression image over the base `A` frame and run the tool on that composite instead, taking the region from the face box the tool prints as it starts. If it then fails only the coverage or residual checks while the rebuild is otherwise fine, the patch files in `--out` are still good: write the manifest entry by hand in the format above, which the engine reads exactly the same way. The sample's `smile` was placed that way, because its base blink frames move a few pixels along the nose bridge, inside the guard band that keeps the eye patch clear of the mouth, and the coverage check counts those pixels as holes the patch left unfilled.

Naming your source images `<name>_A.png` through `<name>_I.png` maps them onto the frame grid, so the tool knows which state each one holds. A multi-image set also needs a reference image with eyes open and mouth closed (`_A`), because the rest are measured against it; the tool stops with a named error if the set has no candidate for it. A single source image is always recorded under `any`, whatever letter its file name carries, because one patch has to sit on every frame the sprite can reach. Run `python tools/gen_expression.py --help` for the remaining options, including `--blush builtin`, `--eyes-only` for expressions that change the eyes alone, and canvas offset correction for generators that pad the canvas.

## Previewing expressions and blush

`engine/demo/expression-lab.html` puts an appearance on a live sprite with a button for every expression its manifest declares, plus talking and blush. Start the local server from the repository root and open it:

```
python engine/serve.py
# then http://127.0.0.1:8300/demo/expression-lab.html
```

`?set=` picks the appearance, and takes the same folder string as `assetsPath` in `config.json`:

```
http://127.0.0.1:8300/demo/expression-lab.html?set=assets/my-character/
```

The bundled sample opens with its Smile button and its blush both working. An appearance that declares neither key opens with the buttons quiet and a note naming what is missing; add the keys and the buttons appear.

One difference from the chat room, on purpose: the lab holds whatever you pick until you pick something else, so a `flash` expression does not clear itself after 2.5 seconds and blush does not ease out after 90. The status line names the mode, and its tooltip gives the chat-room timing.
