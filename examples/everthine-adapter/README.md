# everthine-adapter

One example of the pattern in the [integration guide](../../docs/integration-guide.md): a companion that already lives somewhere gets EverOtome as one more face, without moving.

[Everthine](https://github.com/aveluneverse/Everthine) keeps its companion in Telegram, uses the Claude Code CLI as the engine, and keeps memory on disk. Its `bot.py` has a seam, `produce_reply()`, that turns one message into one reply. `companion_server.py` exposes that seam as `POST /reply`, the route the [http-bridge](../http-bridge/README.md) talks to. Nothing inside Everthine is modified, copied or written to; the script only imports it.

## Run

From your Everthine folder (the one with `run.py`, `.env` and `data/`), one command per line:

```bash
cd <your Everthine folder>
python <path to EverOtome>/examples/everthine-adapter/companion_server.py
```

Then, from the EverOtome folder, the bridge:

```bash
python examples/http-bridge/bridge.py --reply http://127.0.0.1:8401/reply --reply-timeout 180
```

The adapter listens on `127.0.0.1:8401` by default (`--host` and `--port` change that; `--reply` must then match). `--reply-timeout 180` gives the Claude CLI the same three minutes the checker below allows; without it the bridge gives up at 120 seconds.

Open `http://127.0.0.1:8400/`. In `engine/config.json` set `"ttsEndpoint": ""` (Everthine has no voice endpoint) and keep `"wsEndpoint": "/ws"`.

To check without a browser, from the EverOtome folder:

```bash
python tools/check_integration.py http://127.0.0.1:8400 --timeout 180
```

Replies go through the Claude CLI, so allow a minute or more.

## Telegram at the same time

Pick one:

- `--with-telegram`: the adapter starts Everthine's own Telegram bot inside the same process, so Telegram and EverOtome see the same companion and the same session. Two messages arriving at once are answered one after the other, because the Claude CLI is serialized by Everthine's own engine lock (`engine._reply_lock`, held by both the Telegram path and `POST /reply`); the adapter adds no lock of its own beyond the one around its own route. Use this instead of `run.py`. This mode was not part of the verification run below; it needs a real bot token.
- No flag: the adapter serves HTTP only. Stop `run.py` first. Never run `run.py` and the adapter side by side: two processes would fight over the session file and the Claude CLI.

## What comes back

- The reply text, chunks joined by blank lines.
- A reaction Everthine attached to your message, as EverOtome's `[react:<emoji>]` marker at the head of the text; the shell pins it to your message.
- Everthine's system notices (a full notebook, for instance) in the `system` key; the bridge shows them as one Chat Log line.
- "New conversation" from the MENU answers nothing: Everthine keeps one continuous conversation and has no reset.

Run on 2026-08-28 against Everthine `3334d21` with a stub Claude CLI: the HTTP path executed end to end through Everthine's `produce_reply` (adapter, bridge and `tools/check_integration.py` all passing); the CLI itself was substituted, so no real session was created, and `--with-telegram` was not exercised.

Stuck? Tell us: [marshmallow-qa.com/a4u0myommjpyzup](https://marshmallow-qa.com/a4u0myommjpyzup)
