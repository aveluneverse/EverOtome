# Backend contract

This document defines the WebSocket messages and REST endpoints that EverOtome expects from a backend. It is written for developers and AI assistants helping with integration.

Every claim below is verified against the engine source. When in doubt, the source of truth is `engine/js/` (mainly `app.js`, `chat.js`, `phone.js`, `cg.js`, `theme.js`, `furniture.js`).

## Overview

A backend integration falls into three categories:

1. **Required: live chat** over a WebSocket (`wsEndpoint`). This is the only required config key.
2. **Optional, config-gated REST**: history, CG, model switching, sandbox mode, favorites, room state, Thinking visibility. Each is enabled by its own config key, and a missing key means the matching UI never renders. No errors, no dead buttons. Three features are always on and fall back to built-in default paths when their key is absent: text-to-speech (`ttsEndpoint`, default `/api/v4/tts`), photo attachments (`photoEndpoint`, default `/api/photo`) and phone calls (fixed `/api/call/*` paths). To hide the TTS play buttons, set `"ttsEndpoint": ""` (an empty string); the paperclip and the phone button are always rendered.
3. **Optional, fixed-path REST**: the phone-call endpoints and the chat-clear sync endpoint use fixed paths (`/api/call/*`, `/api/v4/chat-clear`) rather than config keys in this version. See [Fixed-path endpoints](#fixed-path-endpoints).

The shell ignores unknown WebSocket roles and unknown JSON fields, so a richer backend can send more than the shell reads and nothing breaks. One exception: a frame carrying a truthy `room` field is dropped entirely (that field is reserved), so do not reuse `room` as your own room or thread id.

## config.json keys

| Key | Purpose |
|---|---|
| `characterName` | Fallback display name for the nameplate when `displayName` is absent. Never transmitted to the backend. |
| `displayName` | Name shown in the UI (name plate, brand corner). |
| `brandTitle` | The label in the top-left corner. Once `modelEndpoint` reports a model, the corner shows that model name instead. The sample ships `AI Model` as a placeholder that says what belongs there; change it to anything you like. |
| `pwaTitle` | Browser tab title, and the home-screen name iOS uses for a page added from Safari. Falls back to `brandTitle`, then to `displayName`. The sample sets it to `EverOtome` so the tab keeps the product name while the corner says `AI Model`; both are yours to change. On other platforms the installed name comes from `manifest.webmanifest`. |
| `locale` | Interface language. `"zh-Hant"` or `"en"` pins one for every visitor; `"auto"` (the sample default) follows each visitor's browser instead. A visitor can still switch it from **Settings → Language** on their own device, or force one page load with `?lang=en` in the URL. |
| `assetsPath` | Folder for the active character's sprite frames and manifest. |
| `appearances` | List of `{ id, label, assetsPath }` outfits to switch between. `label` is a string, or one per language: `{ "zh-Hant": "…", "en": "…" }`. |
| `furniture` | List of furniture pieces the room can display; absent or empty means no furniture layer and no furniture tab. See [roomEndpoint](#roomendpoint). |
| `wsEndpoint` | WebSocket endpoint for live chat. **Required.** A same-origin path such as `/ws`: the shell builds `ws(s)://<current host><path>`, so a full URL to another host is not supported; put the backend behind the same origin with a reverse proxy. |
| `historyEndpoint` | REST endpoint for chat scrollback; absent = chat opens blank. |
| `ttsEndpoint` | Text-to-speech endpoint (also used during phone calls). |
| `ttsUsageEndpoint` | Optional TTS usage/quota meter; the meter row is hidden if unset. |
| `photoEndpoint` / `photoMaxCount` | Photo upload endpoint and max attachments per message. |
| `cgEndpoint` | CG album endpoint base; the whole CG feature is absent if unset. |
| `ringtonePath` | Audio file looped while a call rings. |
| `modelEndpoint` / `models` | Model-switch endpoint plus the list of selectable models; the switcher is absent if unset. |
| `sandboxEndpoint` | Sandbox conversation mode; the toggle is hidden if unset. |
| `thoughtsToggleEndpoint` | Lets the user hide the Thinking content; the settings row is absent unless the key is set **and** the startup probe succeeds. |
| `roseEndpoint` / `roseFlagsEndpoint` | "Favorite this line" endpoints; the heart button is absent unless **both** are set. |
| `ui.path` | Overlay folder for a custom UI skin (icons etc.); falls back to built-in art if unset. |
| `layout.desktopSpriteWidth` | Sprite panel width on desktop (CSS length or percentage). |
| `themes` | List of theme objects; see [Themes](#themes). |
| `themeEndpoint` | Receives the interface theme whenever the user applies one; a theme pushed by the backend is never reported back. Absent means no theme is ever reported. |
| `roomEndpoint` | Shared room state (theme, outfit, furniture): read once at startup, written when the user changes something. |

## Themes

The **first theme listed in `config.json` is the default** on load. Each theme is:

```json
{
  "id": "crystal-swan",
  "label": "display name",
  "vars": { "primary": "#6fbdd3", "...": "..." },
  "assets": {
    "bgRoom": "assets/themes/crystal-swan/bg-room.webp",
    "compass": "assets/themes/crystal-swan/compass.webp",
    "chatlogFrame": "assets/themes/crystal-swan/chatlog-frame.svg"
  }
}
```

`label` is a string, or one per language: `{ "zh-Hant": "…", "en": "…" }`. `vars` are CSS custom-property values; a theme may override as many or as few as it needs and inherits the rest from the built-in defaults. `assets` are the three art pieces (room background, compass ornament, Chat Log frame). The five bundled ids: `crystal-swan`, `rose-vow`, `crimson-nocturne`, `verdant-dawnsong`, `snow-palace`.

## WebSocket: client to server

| Situation | Wire format |
|---|---|
| Plain text message | **Bare string** (not JSON) |
| Message with photos | JSON: `{ "text": "<caption>", "photos": ["<photoId>", "..."] }` (ids from `photoEndpoint` uploads) |
| In-call message (mic transcript or typed) | JSON: `{ "call": true, "text": "..." }` |
| Menu commands | Bare strings `/new` (start a new conversation) and `/status` (status query), sent by built-in MENU items |
| Scene pick | Bare string `/cg <item id>`, sent when the user taps a card in the CG album. Answer with a `cg_state` frame to actually switch the scene |

## WebSocket: server to client

Every downstream frame is JSON and is dispatched on its **`role`** field. Frames with an unknown `role` are silently ignored (forward compatibility).

| `role` | Meaning | Fields the shell reads |
|---|---|---|
| `assistant` | Full reply for the turn (single shot, not a token stream) | `text`; optional `thoughts`, `audio` (array of URLs), `timestamp`, `thoughts_pending`. `timestamp` becomes required when `thoughts_pending` is `true`: the later `thoughts` frame is matched to this turn by `for_ts === timestamp` (string compare) |
| `partial` | In-progress preview of the reply being typed | `text` (the full text so far, not a delta) |
| `thoughts` | Late-arriving thoughts backfill | `text` (string or `null`), `for_ts` |
| `status` | Transient status line (replaced by the next frame) | `text` |
| `system` | Persistent system line (kept in the Chat Log) | `text` |
| `call` | One sentence spoken during a phone call | `text`, `audio` (single URL), `final` |
| `incoming_call` | Character-initiated call is ringing | `call_id` (required; a frame without it is dropped) |
| `incoming_call_end` | The caller gave up or the call was canceled | `call_id` (must match the ringing call), `status` (free-form, informational; the shell does not interpret it) |
| `cg_state` | CG stage direction | `intimate` (bool: enter/exit CG mode), `scene` (item id, or `null` for the opening scene) |
| `sandbox_state` | Sandbox mode changed (broadcast to all connected tabs) | `on` (bool); optional `forgot` (bool: sandbox buffer was destroyed, shell reloads history) |
| `room_state` | Current room state, pushed by the backend | `theme` (string), `outfit` (string), `furniture` (`{ "<id>": bool }`); each optional and independent |
| `thoughts_visible_state` | Thinking visibility changed (broadcast to all connected tabs) | `on` (bool) |

Examples:

```json
{ "role": "assistant", "text": "Was just thinking about you.", "thoughts": "...If I say that out loud, I lose." }
{ "role": "partial", "text": "Was just thin" }
{ "role": "call", "text": "Did you miss me?", "audio": "/api/v4/tts/xxx.mp3", "final": true }
{ "role": "cg_state", "intimate": true, "scene": null }
```

### Field notes

- **`assistant.thoughts`** is the character's inner monologue or aside, provided explicitly by your backend for display. It is not the model's hidden reasoning trace; the shell never asks for or infers one. A reply that carries `thoughts` gets the Thinking button; a reply without it keeps the interface clean.
- **`assistant.audio`** is an **array** of audio URLs (the history ledger uses the same shape). `call.audio` is a **single** URL string. Any voice URL the shell plays is also fetched once in the background, to work out the mouth movement for that line, so your server can see two GETs for the same file. Results are cached per URL, the most recent 60, so a long session with many distinct voice URLs can fetch one again later. A failed analysis is not kept, so that URL can be retried.
- **Thoughts backfill anchoring:** if producing the thoughts takes longer than the reply, send the reply with `thoughts_pending: true` plus a `timestamp`, then later send a `{ "role": "thoughts", "text": "...", "for_ts": "<same timestamp>" }` frame on the same socket. The shell accepts the backfill only when `for_ts` exactly matches the pending reply's `timestamp`; anything else is discarded. If the socket disconnects in between, do not resend the backfill on the new connection: the shell clears the pending state on disconnect.
- **`partial`** frames are only honored between the user sending a message and the turn's closing frame, which is that turn's `assistant` frame; `partial` frames received outside that window are ignored.
- **`call.final: true`** closes the character's speaking turn in a call. Extra fields (e.g. a sentence counter) are ignored by the shell.
- **`room_state` is applied, never echoed.** The three tracks are independent, and a missing track means "leave that one alone". Each is compared against what the tab is currently showing and applied only if it differs, so the same frame arriving twice costs nothing. Nothing applied from a frame is reported back to `roomEndpoint` or `themeEndpoint`. Answering a POST with a `room_state` broadcast is therefore safe: the tab that sent the POST compares the frame against what it already shows, finds nothing different, and reports nothing back, so broadcast it if you want other devices to follow live. The reference backend persists the value and stops there, and pushes `room_state` only when the character or another device moved the state. An id the shell does not know, such as an outfit this build has no entry for, is a safe no-op on that track alone.
- **`thoughts_visible_state`** is a one-way sync, server to client. `on: false` hides the Thinking button and the THINKING tab; any other value, a missing field included, shows them. The shell applies it whether or not `thoughtsToggleEndpoint` is configured, and never reports back. Only push it if you also serve that endpoint: without it the settings row does not exist, and the user has no way to bring Thinking back.

## Reply text markers

Some behavior travels inside the reply itself, as bracketed markers your backend writes into `text`. The shell removes every family listed below before a line reaches the screen, in live replies, in `partial` previews and in history replay alike, so a marker is never visible even when the shell does nothing else with it.

Two things stay on your side:

- **The values are yours.** Theme ids, outfit ids, furniture labels, expression ids: the shell holds no vocabulary of its own and validates nothing. An id it does not recognize does nothing at all.
- **Execution is yours, except for the face.** For scenes and room state the shell only cleans up the display. Scan the reply, check it against your own whitelist, persist the result, then push the matching frame (`cg_state` or `room_state`). A marker on its own changes nothing on screen. Blush and expressions are the exception: those the shell acts on directly.

| Marker | What the shell does with it | Who defines the values |
|---|---|---|
| `[react:<emoji>]` | Removed. The emoji is pinned to the user's last message as a small reaction badge. Recognized at the head of the reply only. | Backend; 1 to 8 characters with no spaces, usually one emoji. |
| `[sticker:<label>]` | Removed, anywhere in the line. The label is then discarded: sticker art is retired, and a full sprite is on screen already. | Backend; the shell never uses it. |
| `[intimate:<word>]` | Removed, anywhere in the line, and nothing else. CG mode itself is driven by the `cg_state` frame. | Backend. |
| `[cg:<id>]` | Removed, anywhere in the line, and nothing else. The scene change arrives as a `cg_state` frame. | Backend; ids come from your own album. |
| `[theme:<label>]` | Removed, anywhere in the line. The theme change arrives as a `room_state` frame. | Backend; ids come from `themes` in `config.json`. |
| `[outfit:<label>]` | Removed, anywhere in the line. The outfit change arrives as a `room_state` frame. | Backend; ids come from `appearances`. |
| `[furniture:<label>:<on\|off>]` | Removed, anywhere in the line. The shell does not read the `on` or `off` word; it strips the whole marker. The change arrives as a `room_state` frame. | Backend; ids come from `furniture`, and the `on`/`off` convention is yours to enforce. |
| `[blush]`, `[blush:deep]` | Removed, anywhere in the line. On a final reply the shell also raises the blush layer: the strong level if any marker in that line says `deep`, the lighter one for any other level it can read. | Two levels, fixed. |
| `[expr:<id>]` | Removed, anywhere in the line. On a final reply the shell also shows that expression, or lets a held one fade out when the reply carries no marker. The last marker in the line wins. | Backend; ids come from the appearance's `manifest.json`. |

Details that matter when you write the side that produces them:

- **Stripping is loose, reading is strict.** A marker the shell cannot parse, `[expr:not a valid id]` for instance, is still removed from the display, and behaves exactly as if the reply carried no expression marker at all, which means a held expression is released. The two rules are deliberately different: a strict strip would let a malformed marker through onto the screen. Blush follows the same rule: a level the shell cannot read, anything but one to sixteen letters, is stripped from the line and raises no blush at all.
- **`[expr:<id>]` ids** are 1 to 24 characters of letters, digits, `-` and `_`, matched without regard to case and lowercased before lookup. `[theme:]`, `[outfit:]`, `[furniture:]` and `[blush]` are matched without regard to case too.
- **Order matters for `[react:]`.** The whole-line families, `[intimate:]`, `[cg:]`, the room three, `[blush]` and `[expr:]`, are cleared first, so a reply that opens with `[intimate:open][react:...]` still has its `[react:]` at the head by the time the shell looks there.
- **Blush and expressions fire on the final reply only.** `partial` frames and history entries are stripped but never trigger, and neither state is stored anywhere, so a page reload leaves the character calm. They also need the nine-frame sprite layout and the matching keys in `manifest.json`; a static portrait, or an appearance that declares neither key, stays as it is. See the [sprite guide](sprite-guide.md) for the manifest format.
- **A reply made only of markers still shows something.** With nothing left after stripping, and nothing else on that turn, the shell renders a faint placeholder bubble instead of dropping the turn, so a reply that arrived is never silently missing.
- **Read-aloud gets the original text.** The shell posts the reply to `ttsEndpoint` exactly as you sent it, markers included, so that one place, yours, owns the rule for what gets spoken. Strip them there before synthesis. The per-sentence play button is the exception: it posts the cleaned line, because that is the text on screen next to it.

## REST endpoints

All endpoints below exist only if their config key is set. Requests carry same-origin credentials.

### historyEndpoint

`GET` → the chat ledger:

```json
{
  "entries": [
    { "ts": "<ISO timestamp>", "speaker": "User", "text": "hello" },
    { "ts": "...", "speaker": "Assistant", "text": "...", "audio": ["/path.mp3"] },
    { "ts": "...", "speaker": "System", "text": "..." }
  ]
}
```

- `speaker` wire literals are exact: `"User"`, `"Assistant"`, `"System"`. Entries with any other speaker are skipped silently.
- `audio` on an entry is an array of URLs (adds replay buttons to that bubble).
- A missing or non-array `entries` renders as an empty history. The ledger stores one full entry per turn (no partials).

### ttsEndpoint

`POST { "text": "..." }` → the audio file itself (binary body). Used for read-aloud and during calls.

Assistant bubbles that carry no archived `audio` also get a play button: clicking it POSTs this same endpoint on demand to synthesize that one sentence. The cache is per sentence, per page load, so repeat plays of the same sentence do not re-POST. A `429` response still routes to the daily-cap notice.

Audio synthesized here is analyzed for mouth movement straight from the response body, so it costs no extra request; audio delivered as a URL does (see `assistant.audio` above).

If your backend does not implement TTS, set `"ttsEndpoint": ""` (an empty string) in your `config.json`. Removing the key is not enough: a missing key falls back to the built-in default path `/api/v4/tts`, and every assistant bubble renders a play button that cannot produce sound.

### photoEndpoint (+ photoMaxCount)

`POST` multipart form, field `photo` (one file per request) → JSON `{ "photo_id": "<id>" }` (snake_case; the shell reads `photo_id` only). On a non-2xx response the shell shows `detail` from the JSON body if present; a `404` is shown as "feature not enabled". Multiple attachments upload sequentially, one request each; the shell then sends the WS message `{ "text": ..., "photos": [ids] }`. `photoMaxCount` caps attachments per message (sample default: 3).

### cgEndpoint (album base URL)

Four channels under one base:

| Channel | Method | Purpose |
|---|---|---|
| `{cgEndpoint}/album` | GET | Display list: `{ "items": [...] }`. Never includes `desc`. `name` is a string, or one per language: `{ "zh-Hant": "…", "en": "…" }`; the shell shows the visitor's current interface language. See the [CG guide](cg-guide.md) for the item format. |
| `{cgEndpoint}/file/{id}` | GET | The image file for an item. |
| `{cgEndpoint}/manage` | GET / POST | Management channel. GET returns the same list **plus `desc`** (the only channel that carries it); `name` and `desc` are each a string, or one per language: `{ "zh-Hant": "…", "en": "…" }`, and the shell shows the visitor's current interface language. POST takes the operations below. |
| `{cgEndpoint}/upload` | POST | Multipart form: `file` (png/jpg/webp), `name` and `desc` (plain strings here, whatever was typed), `target` (`desktop` or `mobile`; defaults to desktop if omitted). Respond `400` for a rejected file type and `413` for oversize (the shell shows matching hints; its own limit message assumes 20MB). |

Management operations (`POST {cgEndpoint}/manage`, JSON):

```json
{ "op": "reorder", "id": "...", "direction": "up" }
{ "op": "edit", "id": "...", "name": "...", "desc": "..." }
{ "op": "delete", "id": "..." }
{ "op": "set_opening", "id": "..." }
```

`edit` sends `name` and `desc` back in the shape they arrived: a plain string comes back as a plain string; per-language names come back as the same object with the language in use updated, and a language the card did not carry is added only when the text was actually changed.

`set_opening` must act as a mutually exclusive selection (radio behavior) within the item's `target` group: setting one opening scene unsets the group's previous one. Keep exactly one opening scene per group. If the current opening scene gets deleted, promote another item before you return `2xx`; the shell tolerates a group with no flag by falling back to the group's first item, but the album then looks arbitrary.

### modelEndpoint (+ models)

`GET` → `{ "model": "<id>" }` (the currently active model). `POST { "model": "<id>" }` → `200` to switch. The selectable list comes from the `models` config key, not from the endpoint.

### sandboxEndpoint

- `GET` → `200` with `{ "on": <bool> }` when the feature exists; **any non-2xx response, or no answer within 8 seconds, means the feature is off** and the whole sandbox UI stays hidden (two gates: config key present, and this probe succeeding).
- `POST { "on": <bool> }` → `2xx` with `{ "on": <bool> }` in the body; the shell takes the returned value as the new state, so a `200` with no JSON body rolls the toggle back. Cross-device sync happens via the `sandbox_state` WS broadcast.
- `POST {sandboxEndpoint}/forget` → `2xx`. Sent by the MENU item "Clear sandbox": discard the sandbox's temporary memory while leaving the mode on, then broadcast `sandbox_state` with `forgot: true`.

### roseEndpoint + roseFlagsEndpoint

Both keys must be set, and a startup `GET` on `roseFlagsEndpoint` must succeed, or the heart button never appears.

- `roseFlagsEndpoint`: `GET` → `{ "flags": [ { "id": <number>, "text": "<string>" }, ... ] }`. Used once at startup to restore the highlighted state of previously favorited lines (matched by normalized text).
- `roseEndpoint`: `POST { "op": "add", "text": "..." }` → `{ "saved": true, "id": <number> }`, or `{ "saved": false }` to decline the save (not an error; the shell rolls the button back silently). `POST { "op": "remove", "id": <number> }` → `200`.

### ttsUsageEndpoint

`GET` → `{ "today_chars": n, "daily_cap": n, "month_ntd": n, "total_ntd": n, "total_usd": n }`, shown as a usage meter in settings. Note: the current display string is hardcoded to NT$/US$ formatting.

If set, the engine also probes this endpoint once at startup and hides the per-sentence synth play button (see `ttsEndpoint` above) unless the probe returns `2xx`. If unset while `ttsEndpoint` is set, the button is enabled without probing, since a `GET` against a POST-only synthesis endpoint cannot reliably tell "off" from "does not support GET".

### themeEndpoint

`POST { "theme": "<theme id>" }` each time a theme is applied, so a backend can know what the room looks like right now. Fire and forget: the response is never read, and a failure never affects the color change itself.

It fires when the user picks a theme card, and once at startup, restoring the saved theme or reporting the default on a first visit. That startup report is skipped when `roomEndpoint` is configured, because there the shared value belongs to the room read below rather than to whichever device opened last. A theme that arrived in a `room_state` frame is never reported back.

### roomEndpoint

One endpoint, two methods, holding the room state shared across devices: which interface theme is on, which outfit the character wears, and which furniture is out. Theme travels one way here: `GET` may return it so a fresh device applies it, but the shell never writes theme through this endpoint. To keep a user-picked theme in sync across devices, implement `themeEndpoint` as well and store what it reports into the same record.

`GET` at startup:

```json
{ "theme": "crystal-swan", "outfit": "default", "furniture": { "side-table": true, "lamp": false } }
```

The answer goes through the same path as a `room_state` frame, with the same track-by-track rules. Any key may be missing. Anything other than a `2xx` (`404` included), and any network failure, is silent: the interface keeps what the device had stored locally, which is also what it drew before the request went out.

`POST` reports what the user did, one small object at a time. The response is never read.

```json
{ "outfit": "<id>" }
{ "furniture": { "<id>": true } }
{ "outfit": "<id>", "furniture": { "<id>": true, "<id2>": false } }
```

- The first is sent when the user picks a different outfit in the panel, and only when the switch actually succeeded and actually changed something.
- The second is sent when a furniture card is tapped, carrying that one piece and its state after the tap.
- The third is the migration report described below.
- **Theme is never in this body.** Theme reporting goes to `themeEndpoint` above, and a POST here never carries one.

**Migration report.** If the startup GET answers with `"outfit": null`, the key present and exactly null, the shell reads it as "this backend has never been told what is being worn" and posts its own current outfit plus a full furniture snapshot, once. A missing `outfit` key does not trigger it. The snapshot covers every declared piece, including ones the user never touched, which take the state from `defaultOn`.

**Furniture entries** live in `config.furniture`, and each is:

```json
{ "id": "side-table", "label": "Side table", "file": "assets/furniture/side-table.webp",
  "left": "3%", "height": "56dvh", "bottom": "-16dvh", "z": 1, "defaultOn": true }
```

`id` and `file` are required; an entry missing either is dropped without a word. `label` falls back to the id in the panel, and is a string, or one per language: `{ "zh-Hant": "…", "en": "…" }`. `left`, `height`, `bottom` and `z` are CSS values passed through untouched, and are read as "set" only when they are non-empty and non-zero: write `"0%"` rather than `0` to pin a piece to the left edge, and give `z` a non-zero level or leave it out. A piece whose image fails to load removes itself and leaves the rest of the room alone. The layer draws in the desktop layout; the panel tab lists the pieces on every width. Placement is remembered per device, and a remembered choice outranks `defaultOn`.

### thoughtsToggleEndpoint

Lets the user hide the character's Thinking content, and tells your backend, so it can stop producing what nobody is reading.

- `GET` → `{ "on": <bool> }`. Two gates guard the settings row: the config key must be set, and this probe must answer `2xx`. A `404`, a network error or a timeout (8 seconds) means the row never renders and nothing else changes, with Thinking left visible.
- `POST { "on": <bool> }` → `2xx` with the new state as JSON. The shell takes the state from your response rather than from the switch. Anything else, a non-JSON body included, counts as a failure and the switch rolls back to where it was.
- `on` counts as off only for exactly `false`; any other value is on.
- Cross-device sync rides on the `thoughts_visible_state` frame above.

Hiding is a display state, and a partial one: it takes away the dialogue box's Thinking button, the THINKING tab and the pane behind it. The Chat Log's inline thought rows sit outside this switch. On desktop they stay visible with Thinking off; on mobile widths the Chat Log never shows them anyway, since thoughts live in the THINKING tab there. Replies may still carry `thoughts` and the shell still keeps them either way. Pair the switch with a backend that also stops producing them, and the saving is real rather than cosmetic.

## Fixed-path endpoints

These use fixed paths rather than config keys in this version. Implement them at these exact routes (or front them with a reverse proxy).

### Phone calls (`/api/call/*`)

| Route | Method | Body | Returns |
|---|---|---|---|
| `/api/call/start` | POST | none | `{ "call_id": "..." }` |
| `/api/call/accept` | POST | `{ "call_id" }` | `200` (answer an incoming call) |
| `/api/call/decline` | POST | `{ "call_id" }` | `200` |
| `/api/call/end` | POST | `{ "call_id" }` | `200` |
| `/api/call/utterance` | POST | multipart: `audio` (webm segment), `mime` | `{ "text": "<transcript>" }`; empty text = "didn't catch that" |
| `/api/call/log` | GET | none | JSON including `{ "config": { "silence_sec": <number> } }`, the VAD pause length the shell uses to segment mic audio |
| `/api/call/voicemail/played` | POST | `{ "call_id" }` | `200`; the shell reports this when a voicemail audio URL (`/api/call/voicemail/audio/...?cid=<call_id>`) starts playing |

Outgoing call flow:

1. The user dials. The shell sends `POST /api/call/start` and receives a `call_id`.
2. Your backend sends `role:"call"` frames over the **existing chat WebSocket**. There is no separate call socket.
3. The shell records microphone audio, segments it using VAD, and posts each segment to `/api/call/utterance`.
4. Your STT returns `text`. The shell sends that text over the WebSocket as `{ "call": true, "text": "..." }`.
5. Your backend responds with more `call` frames and ends the speaking turn with `final: true`.
6. When the user hangs up, the shell sends `POST /api/call/end`.

Incoming call flow:

1. Push a `role:"incoming_call"` frame with a `call_id`.
2. The user accepts (the shell posts `/api/call/accept`) or declines (`/api/call/decline`).
3. To cancel the ringing from the backend side, send a `role:"incoming_call_end"` frame.

### Chat-clear sync (`/api/v4/chat-clear`)

Optional cross-device "clear screen" line. `GET` → `{ "cleared_at": "<ts>" }` (the current line); `POST` → the server takes its own ledger-tail timestamp as the new line and returns `{ "cleared_at": "<ts>" }`. On `404` or failure the shell falls back to a per-device localStorage line, so not implementing this is fine.

## Development

The engine test suite (vanilla JS, vitest + jsdom):

```bash
cd engine
npm install
npx vitest run
```
