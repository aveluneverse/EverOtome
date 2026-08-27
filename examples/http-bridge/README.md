# http-bridge

A translator between EverOtome and a companion that already answers HTTP. One Python file, no dependencies. It serves the `engine/` folder, accepts the shell's WebSocket at `/ws`, and turns every chat message into one HTTP request to your companion:

```
POST http://127.0.0.1:5000/reply
{"text": "what the user typed"}

200 OK
{"text": "the companion's reply"}
```

That is the whole protocol. Two optional keys in the answer: `"thoughts"` (a string the shell shows behind the Thinking button) and `"system"` (one notice line in the Chat Log). Empty `"text"` puts nothing on the screen.

The companion's persona, memory and process stay exactly where they are. The bridge only calls the one route you give it.

## Try it with the echo companion first

From the repository root. Commands are one per line on purpose (PowerShell 5 has no `&&`).

Terminal 1:

```bash
python examples/http-bridge/echo_companion.py
```

Terminal 2:

```bash
python examples/http-bridge/bridge.py --reply http://127.0.0.1:5000/reply
```

Then open `http://127.0.0.1:8400/` in the browser and say something. The echo answers `You said: ...`. To check without a browser:

```bash
python tools/check_integration.py http://127.0.0.1:8400
```

`RESULT: PASS` with a warning about voice is the expected outcome (see below).

No `python` command? Use `python3`.

## Point it at your companion

Give your companion one HTTP route that takes `{"text": "..."}` and answers `{"text": "..."}`, then pass its URL as `--reply`. If the companion's existing route uses other names (say `POST /chat` with `message` and `reply`), either add the new route next to it or write a ten-line shim server that translates; do not rename what already works.

Your route also receives `{"text": "/new", "command": "new"}` when the user picks "New conversation" in the MENU. Reset your session there if that makes sense for your companion, or answer `{"text": ""}` to say nothing. `/status` never reaches you; the bridge answers it itself.

A bot that runs its own polling loop (Telegram, Discord, WeChat) keeps running as it is: the bridge is a separate process and only talks to the route you added. If that route lives inside the bot's process, start the HTTP server in a thread before the polling loop, not after it.

Edit `engine/config.json` (copy `config.example.json` first if you have not):

- keep `"wsEndpoint": "/ws"` (or pass the same value as `--ws-path`)
- set `"ttsEndpoint": ""` so no silent play buttons appear
- keep `"historyEndpoint": "/api/history"`: the bridge serves this run's chat as scrollback

Options: `--port` (default 8400), `--host`, `--engine` (the `engine/` folder, default the one in this repository), `--ws-path`, `--history-path`, `--reply-timeout` (seconds to wait for the companion, default 120). `--help` lists them.

## What it does not relay

- Photos: the paperclip reports "feature not enabled" when used.
- Voice: no play buttons once `ttsEndpoint` is empty.
- Phone calls: the phone button shows an error when pressed.
- CG management: the bundled demo album is visible; upload, reorder, edit and delete answer 404.
- Scene changes (`/cg`): answered with a notice line.

Each of these has a real endpoint shape in the [backend contract](../../docs/backend-contract.md); add them to your own server when you want them, in front of or instead of the bridge.

The history it serves lives in memory and is gone when the bridge stops. Your companion's own memory is untouched either way.

## Stopping

Ctrl+C in each terminal.

Stuck? Tell us: [marshmallow-qa.com/a4u0myommjpyzup](https://marshmallow-qa.com/a4u0myommjpyzup)
