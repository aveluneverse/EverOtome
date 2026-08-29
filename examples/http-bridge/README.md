# http-bridge

A translator between EverOtome and a companion that already answers HTTP. One Python file, no dependencies. It serves the `engine/` folder, accepts the shell's WebSocket at `/ws`, and turns every chat message into one HTTP request to your companion:

```
POST http://127.0.0.1:8401/reply
{"text": "what the user typed"}

200 OK
{"text": "the companion's reply"}
```

That is the whole protocol. Two optional keys in the answer: `"thoughts"` (a string the shell shows behind the Thinking button) and `"system"` (one notice line in the Chat Log). Empty `"text"` draws no reply; for an ordinary message the bridge then adds a Chat Log notice that the companion sent nothing back, while an empty answer to `/new` stays silent.

The companion's persona, memory and process stay exactly where they are. The bridge only calls the one route you give it.

## Try it with the echo companion first

From the repository root. Commands are one per line on purpose (PowerShell 5 has no `&&`).

Terminal 1:

```bash
python examples/http-bridge/echo_companion.py
```

Terminal 2:

```bash
python examples/http-bridge/bridge.py --reply http://127.0.0.1:8401/reply
```

Then open `http://127.0.0.1:8400/` in the browser and say something. The echo answers `You said: ...`. To check without a browser:

```bash
python tools/check_integration.py http://127.0.0.1:8400
```

`RESULT: PASS` with two warnings is the expected outcome on a fresh clone: no `config.json` yet, and voice (see below).

No `python` command? Use `python3`.

## Point it at your companion

Give your companion one HTTP route that takes `{"text": "..."}` and answers `{"text": "..."}`, then pass its URL as `--reply`. If an existing route already does the job under other names (say `POST /chat` with `message` in and `reply` out), keep it and tell the bridge the names; do not rename what already works:

```bash
python examples/http-bridge/bridge.py --reply http://127.0.0.1:8401/chat --text-key message --reply-key reply
```

Your route also receives `{"text": "/new", "command": "new"}` when the user picks "New conversation" in the MENU (with `--text-key`, that name replaces `"text"` here as well). Reset your session there if that makes sense for your companion, or answer `{"text": ""}` to say nothing. `/status` never reaches you; the bridge answers it itself.

A bot that runs its own polling loop (Telegram, Discord, WeChat) keeps running as it is: the bridge is a separate process and only talks to the route you added. If that route lives inside the bot's process, start the HTTP server in a thread before the polling loop, not after it.

Edit `engine/config.json` (if it does not exist yet, copy `engine/config.example.json` to `engine/config.json` first; the sample lives in `engine/`, not in the repository root):

- keep `"wsEndpoint": "/ws"` (or pass the same value as `--ws-path`)
- set `"ttsEndpoint": ""` so no silent play buttons appear
- keep `"historyEndpoint": "/api/history"` (or whatever you pass as `--history-path`): the bridge serves this run's chat as scrollback

Options: `--reply` (the companion's route, required), `--port` (default 8400), `--host`, `--engine` (the `engine/` folder, default the one in this repository), `--ws-path`, `--history-path`, `--reply-timeout` (seconds to wait for the companion, default 120), `--text-key` and `--reply-key` (the JSON field names when the companion's route uses names other than `text`). `--help` lists them.

On a server, start the bridge with `--host 0.0.0.0` so a browser elsewhere can reach it, or put it behind the reverse proxy from the [backend contract](../../docs/backend-contract.md#deployment-one-origin). The bridge has no login of its own: anyone who can reach the port can talk to the companion, so keep the port firewalled or behind whatever already protects the rest of the server.

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
