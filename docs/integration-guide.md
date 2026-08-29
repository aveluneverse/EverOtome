# Connect an existing companion

*A brief for the AI assistant helping someone connect a companion that already runs somewhere. If that is you, read this page first; the [backend contract](backend-contract.md) has every detail, but you only need a small part of it.*

**Do not move the companion. Add EverOtome as one more channel; persona and memory stay where they are.**

EverOtome is a face, not a home and not a brain. The companion keeps living where it lives: a Telegram bot, a Discord bot, a WeChat bridge, a self-made web page, an Everthine folder, a Python or Node script around an API. Your job is to give that companion one more way to be talked to, with the smallest change and the smallest risk.

## Can this companion be connected?

- **Yes** when the companion runs as a process on a machine the person controls (a VPS, a home PC, a small board) and you can add a few lines to it, or run one more small process next to it.
- **Not yet** when the companion lives only inside an app or website you cannot run code on (Claude.ai, ChatGPT, character.ai, Kelivo and similar apps). There is nothing to connect to; say so plainly rather than building a workaround.

## The whole protocol

The shell needs two things from your side. Everything else is optional: a feature stays off while its config key is missing, except the three buttons in trap 4.

1. **Serve the `engine/` folder as static files**, with `index.html` at `/`.
2. **Accept a WebSocket at a same-origin path** (the sample config says `/ws`). For ordinary chat, the shell sends each message as a **bare string**, not JSON. Answer each one with one JSON frame:

```json
{ "role": "assistant", "text": "the companion's reply" }
```

That is the required part. A reply can also carry `"thoughts"` (a string shown behind the Thinking button), and the [reply text markers](backend-contract.md#reply-text-markers) let the companion trigger an expression or a blush with a tag inside `text`.

Three more shapes can arrive on the same socket. Two are JSON objects with a `text` field: `{ "text": "...", "photos": [...] }` after a photo upload, and `{ "call": true, "text": "..." }` during a phone call. The third is a bare string that starts with a slash: `/new` and `/status` from menu items, and `/cg <id>` when a card in the album is tapped. If you do nothing else, read `text` out of the JSON ones and treat the slash strings as you like; ignoring them is fine.

`config.json` (copy `config.example.json` to `config.json` inside `engine/`, then edit):

- `"wsEndpoint": "/ws"` is the only required key. Keep it a path, not a URL.
- `"ttsEndpoint": ""` unless the companion has a voice endpoint. Leaving the key out does not turn voice off; it turns the default path on, and every reply gets a play button that stays silent.
- `"historyEndpoint"`: keep it only if you serve scrollback (shape in trap 5 below); remove it otherwise.
- `"cgEndpoint"`: keep it while the bundled demo album is reachable (it is whenever `engine/` is served as static files and `/api/` is not proxied away); remove it once it is not.

## Three ways in: pick one

**A. Run the bridge.** No dependencies, and nothing to add to the companion beyond one HTTP route. `examples/http-bridge/bridge.py` serves `engine/`, accepts `/ws`, and turns each chat message into one `POST` to the companion: `{"text": "..."}` in, `{"text": "..."}` out. Give the companion that one route; when an existing route already does the job under other names, keep it and tell the bridge the names, for example `--text-key message --reply-key reply`. Then, from the EverOtome folder:

```bash
python examples/http-bridge/bridge.py --reply http://127.0.0.1:8401/reply
```

Details, an echo companion to try first, and what the bridge does not relay: [`examples/http-bridge/README.md`](../examples/http-bridge/README.md).

**B. Add the WebSocket to the companion's own process.** Best when the companion is a Python or Node program you can edit. Both examples below serve `engine/` and answer `/ws`; replace the one function that fakes the reply with a call into the companion. Both were run against this repository on 2026-08-28.

Python (`python -m pip install aiohttp`):

```python
import json
from aiohttp import web

ENGINE = "/path/to/EverOtome/engine"


async def companion_reply(text):
    return "You said: " + text          # call your own companion here


async def ws_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    async for msg in ws:
        if msg.type != web.WSMsgType.TEXT:
            continue
        text = msg.data
        try:                             # photo and call messages arrive as JSON with a "text" field
            obj = json.loads(text)
            if isinstance(obj, dict) and isinstance(obj.get("text"), str):
                text = obj["text"]
        except ValueError:
            pass
        await ws.send_json({"role": "assistant", "text": await companion_reply(text)})
    return ws


async def index(request):
    return web.FileResponse(ENGINE + "/index.html")


app = web.Application()
app.router.add_get("/ws", ws_handler)
app.router.add_get("/", index)
app.router.add_static("/", ENGINE)
web.run_app(app, host="127.0.0.1", port=8400)
```

Node (Node.js 20.19+ or 22.12+ with npm; `npm install express ws`):

```js
const express = require("express");
const { WebSocketServer } = require("ws");

const ENGINE = "/path/to/EverOtome/engine";

async function companionReply(text) {
  return "You said: " + text;          // call your own companion here
}

const app = express();
app.use(express.static(ENGINE));
const server = app.listen(8400, "127.0.0.1", () => console.log("open http://127.0.0.1:8400/"));
new WebSocketServer({ server, path: "/ws" }).on("connection", (ws) => {
  ws.on("message", async (data) => {
    let text = data.toString();
    try {                                // photo and call messages arrive as JSON with a "text" field
      const obj = JSON.parse(text);
      if (obj && typeof obj.text === "string") text = obj.text;
    } catch (e) {}
    ws.send(JSON.stringify({ role: "assistant", text: await companionReply(text) }));
  });
});
```

**C. Reverse proxy.** For a companion that already answers `/ws` in the shell's own format (one built to the [backend contract](backend-contract.md)) but serves from another port: put a proxy in front, static files from `engine/`, `/ws` and `/api/` forwarded to the companion. Two configurations that were run against this repository (Caddy and nginx) are in the [contract's deployment section](backend-contract.md#deployment-one-origin). A companion that does not speak the WebSocket format yet belongs in A or B, not here.

## Five traps

1. **Same origin.** The shell builds the socket address from the page's own host plus the path in `wsEndpoint`. A page served from port 8400 cannot talk to a socket on port 8401. Either the companion's process serves `engine/` itself, or one proxy (or the bridge) fronts both.
2. **Do not move the brain.** Persona files, memory, conversation logs and API keys stay in the companion's own folder and process. The connection code calls into the companion; it never copies its files somewhere else.
3. **Two loops, one process.** A Telegram, Discord or WeChat bot blocks on its own polling loop. Start the web server in a thread (or as an asyncio task, or as the separate bridge process) before that loop, never after it, because the loop does not return. The Everthine adapter below shows the thread version.
4. **Three buttons are drawn no matter what you serve.** The paperclip (photos), the phone and the play button on replies appear even when nothing answers them. Without endpoints: the paperclip reports "feature not enabled" on use, the phone shows an error when pressed, and the play button stays silent. The first two are acceptable defaults; the third is not, so set `"ttsEndpoint": ""` when there is no voice (the play button is the only one of the three that can be switched off). When you do implement them, the paths are `photoEndpoint` (default `/api/photo`), the fixed `/api/call/*` routes, and `ttsEndpoint` (default `/api/v4/tts`). A static-file framework that answers `405` to the photo upload (aiohttp does) makes the paperclip say "upload failed" instead of "feature not enabled"; answer `404` on that route when you do not take photos.
5. **History has one shape.** `GET historyEndpoint` answers `{ "entries": [ { "ts": "...", "speaker": "User", "text": "..." }, ... ] }`: an object with an `entries` array, never a bare array; `speaker` is exactly `User`, `Assistant` or `System`; `audio`, when present, is an array of URLs.

On Windows, the commands on this page are one per line on purpose; PowerShell 5 has no `&&`.

## Check it

You cannot see the screen, so use the checker. It does what the browser does on load, sends one message, and prints a verdict per area:

```bash
python tools/check_integration.py http://127.0.0.1:8400
```

`RESULT: PASS` means the shell is served, the socket accepted the message, and a well-formed reply came back within the time limit (60 seconds by default; `--timeout 180` for a slow companion). Each `[FAIL]` line carries a `fix:` line. `[WARN]` lines are things to decide rather than breakage: a silent play button, a missing history, a sample config still in use, a `405` where a `404` would read better. The checker sends exactly one chat message (the text after `--message`, or a default greeting), and the companion may remember it; it never starts a call and never sends `/new`. `--no-chat` opens the socket without sending a chat message, for a companion that must not be talked to yet; the other probes still run (add `--skip-tts` to leave the voice endpoint alone as well), and `RESULT: PASS` then says nothing about the reply path. Standard library only, Python 3.7 or newer.

Then have the person open the address in a browser and say something. The checker proves the pipe; their eyes prove the face.

## Example: Everthine

[Everthine](https://github.com/aveluneverse/Everthine) keeps its companion in Telegram, with the Claude Code CLI as the engine and memory on disk, and its `bot.py` has a seam, `produce_reply()`, that turns one message into one reply. [`examples/everthine-adapter/`](../examples/everthine-adapter/README.md) wraps that seam (its `companion_server.py`) as `POST /reply` for the bridge without touching Everthine's code or copying its files; memory and session stay on Everthine's own disk, read and written by Everthine itself as they are from Telegram. Run it from the Everthine folder, then run the bridge against it. Its README covers the choice between running Telegram in the same process and serving HTTP only. Everthine is one example of the pattern, not a requirement; any companion with a "text in, text out" function can be wrapped the same way.

## When something does not fit

The shapes above are the shell's; the companion's shapes are yours. If the two cannot meet without moving the brain, stop and tell the person what would have to move, rather than moving it. Stuck? Tell us: [marshmallow-qa.com/a4u0myommjpyzup](https://marshmallow-qa.com/a4u0myommjpyzup)
