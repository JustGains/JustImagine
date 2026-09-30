# JustImagine HTTP API

`justimagine` starts the standalone gallery; `bro imagine` starts it with Bro's configuration and paths. The UI has no private browser-only path: it calls the JSON routes documented here on that same server, so scripts can drive it exactly the way the page does.

Bro's local server binds to `127.0.0.1` without account authentication. Standalone JustImagine uses token authentication; the hosted TekPrepperAI suite requires a shared-account session and bundle access. Upstream provider keys stay server-side and are isolated by account in the hosted suite.

## Start the server

From the standalone repository, run `node bin/justimagine.js -p openrouter --port 8790`. Read the bearer token from `~/.justimagine/auth.token` (or the configured JustImagine home), and send `Authorization: Bearer <token>` with API requests. Standalone galleries default to `<cwd>/.justimagine`; the standalone service defaults to port 8793. The examples below use the Bro adapter, whose local loopback API does not require this token and whose service uses port 8791.

```sh
bro imagine -p openrouter              # foreground, prints its URL, opens a browser
bro imagine --root D:/Art --port 9000  # a different gallery, on a fixed port
bro imagine service install            # background, this directory's gallery, port 8791
sudo bro imagine service install       # …and starting with the machine, not just at login
```

A foreground run prints the base URL and the gallery root:

```text
Gallery:  http://127.0.0.1:8790
Folder:   <cwd>/.bro/justimagine
```

Use that URL as `BASE` below. The service defaults to `http://127.0.0.1:8791`; `bro imagine open --no-open` prints it without launching a browser.

> Driving this from an agent? `bro imagine skill` installs a skill —
> `generate-images-videos` — that carries everything below in the form an agent
> needs it: which routes to call in what order, the caps, and what to do about
> failures. It ships in the package under `skills/`.

## Layout on disk

Everything lives under one root, so the whole gallery is a single movable tree:

```text
<root>/                    folder "" — generations made at the top level
  history.jsonl            metadata for the media beside it
  <name>/                  a folder you made; nests arbitrarily
    history.jsonl
  .context/                reference images, named by content hash
  .thumbs/                 derived posters/thumbnails (safe to delete)
  .settings.json           the composer's last choices (see "Reuse the last settings")
```

Metadata is per-folder rather than one central index. That is what makes deleting a folder a plain recursive remove with nothing left dangling, and what lets a folder survive being moved by hand in Explorer or Finder.


## Authentication

Standalone JustImagine servers require a bearer token. The CLI creates it at `~/.justimagine/auth.token` with restrictive file permissions and opens the browser with a `?token=` bootstrap URL that exchanges the reusable token for a cookie and redirects to a clean URL. API clients can read that local token and send it as `Authorization: Bearer <token>`:

```sh
TOKEN=$(cat ~/.justimagine/auth.token)
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/state"
```

The `/health` endpoint is intentionally unauthenticated so service managers can check liveness. Embedding hosts may pass `auth: false` when they already own access control; Bro-CLI does this for its loopback gallery.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /api/state` | Everything the UI needs to boot: gallery root, image APIs, live video, song and voice model catalogues, folder tree, reference library, in-flight jobs, last settings |
| `GET /api/settings` | The composer's last choices: provider, model per provider, knobs, folder |
| `POST /api/settings` | A patch of them; merged, unknown keys dropped |
| `GET /api/models` | The catalogue on its own — every knob a generation may set. `?kind=image\|video\|song\|voice`, `?api=`, `?q=`, `?detail=1`, `?limit=`, `?sort=speed\|quality\|cost\|new` |
| `GET /api/items?folder=<rel>` | The media in one folder, newest first; `&deep=1` includes every subfolder (each item keeps its own `folder`); paged with `offset` and `limit` |
| `GET /api/folders` | Just the folder tree |
| `POST /api/folder` | `{parent, name}` → create |
| `POST /api/folder/rename` | `{path, name}` → rename |
| `POST /api/folder/delete` | `{path}` → delete the folder and every generation inside it |
| `POST /api/move` | `{from, to, files[]}` → move media between folders, metadata and thumbnails included |
| `POST /api/delete` | `{folder, file}` → delete one generation |
| `POST /api/generate` | Queue one spec (`count` copies of it); returns job ids. `wait: <seconds>` blocks until they finish |
| `POST /api/batch` | `{defaults, items[], wait}` → queue many different specs, images and video mixed, in one request |
| `GET /api/jobs` | Poll jobs instead of subscribing. `?ids=a,b,c`, `?wait=<seconds>` to block until they finish, `?active=1` |
| `POST /api/cancel` | `{id}`, `{ids[]}` or `{all: true}` → cancel queued or in-flight jobs |
| `POST /api/enhance` | `{prompt, kind, model?, characters?, images?, context?}` → rewrite the prompt, lyrics, script or voice description |
| `GET /api/events` | Server-sent events: a snapshot of live jobs on connect, then every state change |
| `POST /api/context` | `{dataUrl}` or `{path}` → save a reference image (deduped by content hash) |
| `POST /api/context/delete` | `{file}` → remove one reference image |
| `GET /api/characters` | The cast |
| `POST /api/characters` | `{name, description}` → create |
| `POST /api/characters/update` | `{id, name?, description?, cover?, voice?}` → edit (renaming changes the id); `voice: {id, name}` gives them a voice, `voice: null` removes it |
| `POST /api/characters/delete` | `{id}` → delete the character and its references |
| `POST /api/characters/refs` | `{id, dataUrl}` or `{id, path}` to upload, or `{id, folder, file}` to promote a generation |
| `POST /api/characters/refs/delete` | `{id, file}` → drop one reference |
| `POST /api/characters/refs/generate` | `{id, count}` → draw a reference sheet; returns a job id |
| `POST /api/characters/refs/keep` | `{id, files[]}` → promote generated shots into references |
| `POST /api/characters/candidates/clear` | `{id, files?}` → discard generated shots |
| `GET /api/characters/export` | The whole cast as one file — references and voices included. `?ids=a,b` for just those |
| `POST /api/characters/import` | `{cast}` (or the exported file as the body) → add those characters; returns `{imported[], characters}` |
| `GET /charref/<file>?c=<id>` | One of a character's reference images |
| `GET /api/voices` | The ElevenLabs account's voices, its speech models, and which cast member speaks with which. `?refresh=1` re-reads them |
| `POST /api/voices/design` | `{description, text?}` → three candidate voices to audition, as `data:` URLs |
| `POST /api/voices/save` | `{generatedVoiceId, name?, description?, characterId?}` → keep a designed voice, optionally giving it to a character |
| `POST /api/voices/clone` | `{samples: [dataUrl…], name?, characterId?, removeNoise?}` → an instant clone from recordings |
| `POST /api/voices/say` | `{voice, text?, settings?, model?}` → hear a voice say a line; nothing is filed |
| `POST /api/transcribe` | `{folder, file}` for a song in the gallery, or `{dataUrl}` for a short audio clip → when each word is sung (OpenRouter Whisper, on the `openrouter` key); songs up to 24 MB |
| `POST /api/media` | `{folder, name, size, meta?, kind?}` → start a chunked upload of a finished file (a stitched music video, a song or voice line made elsewhere); returns `{id}`. `kind: "voice"` files audio as a voice line rather than a song |
| `POST /api/media/chunk?id=<id>&offset=<n>` | The next raw bytes of that upload (up to 32 MB each, in order) → `{received}`; a wrong `offset` is a `409` |
| `POST /api/media/done` | `{id}` → file it in the folder, typed by its bytes (image, video or audio); returns `{item}` |
| `POST /api/thumb` | `{folder, file, dataUrl}` → cache a JPEG thumbnail |
| `GET /media/<file>?f=<folder>` | The media itself. Supports byte ranges, so `<video>` can seek. Add `&dl=1` for a download disposition |
| `GET /thumb/<file>?f=<folder>` | The cached thumbnail, or 404 if none has been made yet |
| `GET /context/<file>` | A reference image |
| `GET /api/config` | Providers and whether each has a key, for the settings panel. Keys are masked (`sk-o…b185`), never returned in full |
| `POST /api/config/key` | `{id, key}` → save that provider's key (`elevenlabs` included); an empty `key` removes it |

Folder ids are `/`-joined relative paths; `""` is the top level. Anything that tries to escape the root is refused with `Invalid folder path`.

Every mutating route must come from the gallery's own origin. The server binds
loopback, but any page in the browser can still reach `127.0.0.1`, so a request
carrying another site's `Origin` (or a cross-site `Sec-Fetch-Site`) is refused
with `403 Cross-site request refused.` Reads are unaffected, and a non-browser
client that sends no `Origin` at all — curl, a script — is allowed through as
before.

## Which model, and what it accepts

`GET /api/state` carries the catalogue, but so does `GET /api/models`, without the
folder tree, the cast and the reference library:

```sh
curl -s "$BASE/api/models?kind=video"          # every video model and its real options
curl -s "$BASE/api/models?kind=image&api=yunwu"
curl -s "$BASE/api/models?q=veo&detail=1"      # search; detail adds the blurb and the picker facts
```

```json
{ "models": [ { "id": "google/veo-3.1", "name": "Google: Veo 3.1", "kind": "video",
                "api": "openrouter", "ready": true, "created": 1774224000,
                "pricing": { "perSecond": 0.2, "basis": "720p" },
                "durations": [4, 6, 8], "resolutions": ["720p", "1080p"],
                "aspectRatios": ["16:9", "9:16"], "frames": ["first_frame"],
                "audio": true, "seed": true } ],
  "total": 1, "defaultApi": "openrouter", "videoApi": "openrouter" }
```

`?sort=` orders the list the way the picker's pills do:

| `sort` | First | Ordered on |
| --- | --- | --- |
| `speed` | fastest | measured wall-clock time: OpenRouter's p50 over the last 30 minutes, else this gallery's own median (`speedMs`) |
| `quality` | best | Design Arena rank (`rank`); scored-but-unranked models follow, by win rate |
| `cost` | cheapest | `pricing.perImage`, `pricing.perSecond`, or `pricing.perClip` spread over `clipSeconds` (8 when unstated) |
| `new` | newest | publish date (`created`) |

A model with nothing known for that key sorts last — unmeasured is not fast,
unpriced is not cheap. Ties go to the newer release. Every row carries
`speedMs` and `rank` when known, so a sorted list shows why it is in that order.
Anything else is a `400` naming the valid keys.

```sh
curl -s "$BASE/api/models?kind=video&sort=speed&limit=5"
```

`ready: false` means that provider has no key, so a generation on it will fail —
check it before queueing fifty. `pricing` is what a batch will cost: multiply
`perImage` by the count, `perSecond` by the duration and the count, or
`perClip` by the count. `pricing.source` says whose list price it is.

Video models come from two providers, told apart by `api`. `openrouter` rows
are OpenRouter's video catalogue. `openlux` rows (`veo_3_1`, `grok-imagine-video`,
`doubao-seedance-2-0-260128`, …) come from OpenLux's public price list at
`https://api.openlux.ai/api/pricing_new`, run on the OpenLux key, and are
priced at the cheapest key group that model is sold in. A key in a pricier
group pays more, and `pricing.basis` names the group. OpenLux image models are
listed under `api=openlux` the same way.

## Generate an image

```sh
curl -s "$BASE/api/generate" \
  -H "content-type: application/json" \
  -d '{
    "kind": "image",
    "folder": "Product/Bottles",
    "api": "openrouter",
    "model": "google/gemini-3.1-flash-image",
    "prompt": "a clean product photo of a steel water bottle",
    "size": "1024x1024",
    "quality": "high",
    "count": 2
  }'
```

```json
{ "jobs": ["mtiy3mis-0-99d1", "mtiy3mis-1-4c02"], "batch": "mtiy3mis-3f9a2c" }
```

`batch` is shared by every copy one request queued. It is on each job and on
each finished item, so the gallery shows a prompt's results as one group
however their finishing order interleaves — and a script can do the same.

`size` and `quality` are ignored by chat-routed models (Gemini and friends) — steer those with the prompt. `api` picks which configured image API to use and defaults to the one the server started with.

## Reuse the last settings

The composer's choices are stored with the gallery (`<root>/.settings.json`),
not only in one browser, so they follow you to another browser. Every queued
generation updates them too, from the gallery or over the API — except the
folder and cast, which only the composer sets.

Add `"reuse": true` to a spec and anything it leaves out is filled from them:
the kind, the provider, the model, that kind's knobs (size and quality; or
duration, resolution, aspect ratio and audio) and the folder. The prompt, count
and cast are never borrowed. The response lists what was filled in, under
`reused`:

```sh
curl -s "$BASE/api/generate" -H "content-type: application/json" \
  -d '{ "reuse": true, "prompt": "the same bottle, overhead" }'
```

```json
{ "jobs": ["mtiy3mis-0-99d1"], "kind": "image", "model": "openai/gpt-image-2.5-sunburst", "folder": "Product",
  "reused": { "kind": "image", "api": "openrouter", "model": "openai/gpt-image-2.5-sunburst", "size": "1024x1536", "folder": "Product" } }
```

Name a different provider (`"api": "openlux"`) and the model you last used on
*that* provider is filled in instead. In a batch, put `"reuse": true` in
`defaults`. `GET /api/settings` shows what would be reused.

## Generate a video

```sh
curl -s "$BASE/api/generate" \
  -H "content-type: application/json" \
  -d '{
    "kind": "video",
    "folder": "Campaign",
    "model": "google/veo-3.1",
    "prompt": "a slow dolly across a rain-streaked window at night",
    "duration": 8,
    "resolution": "1080p",
    "aspectRatio": "16:9",
    "audio": true,
    "seed": 42
  }'
```

Video always runs on OpenRouter's `/api/v1/videos` and needs `keys.openrouter` (or `OPENROUTER_API_KEY`). JustImagine submits the job, polls it on a ramping interval, downloads the finished clip and files it in the folder you named — the HTTP request returns as soon as the job is queued.

Only send knobs the model supports; `GET /api/state` returns each model's real capabilities:

```json
{
  "id": "google/veo-3.1",
  "name": "Google: Veo 3.1",
  "durations": [4, 6, 8],
  "resolutions": ["720p", "1080p", "4K"],
  "aspectRatios": ["16:9", "9:16"],
  "sizes": ["1280x720", "1920x1080", "3840x2160", "…"],
  "frames": ["first_frame", "last_frame"],
  "audio": true,
  "seed": true
}
```

`size` (`"1920x1080"`) is interchangeable with `resolution` + `aspectRatio`; sending `size` wins and the other two are dropped, so the upstream never receives a contradiction.

## Generate a song

Songs run on OpenRouter's music models — Google's Lyria 3 Pro (full songs, 8¢
each) and Lyria 3 Clip (30-second clips, 4¢) — on the same `keys.openrouter` key
as video. The model streams the track back over chat completions; JustImagine
collects it, files the MP3 and records what was sung.

```sh
curl -s "$BASE/api/generate" -H "content-type: application/json" -d '{
    "kind": "song",
    "folder": "Album",
    "model": "google/lyria-3-pro-preview",
    "prompt": "dreamy synth-pop about a night drive, warm analog pads",
    "lyrics": "[Verse 1]\nNeon on the windscreen, city in the rain\n[Chorus]\nDrive, drive, till the morning comes",
    "vocals": "breathy female lead",
    "bpm": 104,
    "length": "medium",
    "count": 2
  }'
```

| Field | Meaning |
| --- | --- |
| `prompt` | The style: genre, mood, instruments, production |
| `lyrics` | Words to sing, with `[Verse]`/`[Chorus]` markers. Leave it out and the model writes its own |
| `instrumental` | `true` for no vocals; `lyrics` and `vocals` are then ignored |
| `vocals` | Who sings, in words: `"a male and female duet"`, `"a choir"` |
| `bpm` | Tempo, 30–300 |
| `length` | `short`, `medium` or `full` — honoured by full-song models only; a clip is always a clip |
| `images` | Reference images set the mood (Lyria reads pictures) |
| `seed` | Reproduce a take |

Lyria has no separate parameters for these: they are composed into the one
prompt it takes. The history entry keeps the parts you gave, plus `sung` — the
words the model actually sang, when they differ — `duration` in seconds, and
`cost`. At most 4 copies per request.

## Generate a voice line

Voices run on ElevenLabs, with `keys.elevenlabs` or `ELEVENLABS_API_KEY`
(`ELEVEN_LABS_API_KEY` works too). A variable set after the gallery started is
only seen once it restarts. Name any voice on the account by id:

```sh
curl -s "$BASE/api/voices" | jq '.voices[] | {id, name, labels}'
curl -s "$BASE/api/generate" -H "content-type: application/json" -d '{
    "kind": "voice", "model": "eleven_v3",
    "voice": "21m00Tcm4TlvDq8ikWAM",
    "prompt": "[warmly] Welcome back to the show."
  }'
```

**Cast members speak in their own voice.** Give a character a voice once
(`POST /api/characters/update` with `voice: {id, name}`, or design or clone one
for them), then either pick them — `"characters": ["nora"]` — or write a scene.
A line that begins with a cast name is theirs:

```sh
curl -s "$BASE/api/generate" -H "content-type: application/json" -d '{
    "kind": "voice",
    "prompt": "The door creaked open.\nNora: [whispers] Where were you?\nSam: Out.\nNora: All night?",
    "voice": "21m00Tcm4TlvDq8ikWAM"
  }'
```

That is performed as one take by Eleven v3's dialogue endpoint, each line in its
speaker's voice; lines before the first speaker go to `voice`, the narrator.
Only cast names count as speakers — "Note: bring coffee" stays text. A scene
between several voices always runs on Eleven v3, and the response carries a
`warning` when another model was asked for. A script with only one speaker is a
plain read, on any model. The file is named for who speaks.

ElevenLabs limits how many requests an account may have open at once (3 on
Starter). Going over that is not a failure: the request waits for a free slot
and retries on its own, the job's `phase` reading `waiting for a free
ElevenLabs slot` meanwhile. The cap the error states is remembered, and from
then on voice generations run that many at a time (`limits.voice` in
`GET /api/jobs`) until the server restarts. Only a slot that stays busy for ten
minutes fails the job.

What fails does so before a credit is spent, with a `400`: a speaker with no
voice (`"Mo has no voice yet — give them one in the Cast tab."`), unassigned
lines with no narrator, no voice at all, or text longer than the model takes.

Delivery: `stability`, `similarity` and `style` (0–1), `speed` (0.7–1.2),
`language` (`"en"`, `"ja"`…), `format` (`mp3_44100_128`, `mp3_44100_192`,
`mp3_44100_64`) and `seed`. Unset sliders use the voice's own settings — or the
cast member's, when their voice carries some. Eleven v3 reads stability in three
steps: Creative (0), Natural (0.5), Robust (1). Its audio tags — `[whispers]`,
`[laughs]`, `[sighs]` — are direction, not words; ✨ adds them for you.

### Designing and cloning a character's voice

```sh
# three candidates from a description, each a playable data: URL
curl -s "$BASE/api/voices/design" -H "content-type: application/json" \
  -d '{"description":"a warm, husky alto in her thirties, soft Dublin accent, unhurried"}'
# keep one, and give it to Nora
curl -s "$BASE/api/voices/save" -H "content-type: application/json" \
  -d '{"generatedVoiceId":"<from the design>","characterId":"nora"}'
# or clone from recordings of the voice (only voices you have the right to use)
curl -s "$BASE/api/voices/clone" -H "content-type: application/json" \
  -d '{"characterId":"sam","samples":["data:audio/mpeg;base64,…"],"removeNoise":true}'
```

Both save the voice on the ElevenLabs account and store it in the character's
`character.json` as `voice: {id, name, source}`. ✨ with `kind: "voice-design"`
turns a character's appearance description into a voice description.

## Many at once

`/api/generate` takes one spec and makes `count` copies of it. `/api/batch` takes
as many *different* specs as you like, in one request:

```sh
curl -s "$BASE/api/batch" -H "content-type: application/json" -d '{
  "defaults": { "kind": "image", "folder": "Campaign/Boards",
                "model": "google/gemini-3.1-flash-image", "size": "1024x1024" },
  "items": [
    "a cyclist at dawn on a wet city street, shot from behind",
    { "prompt": "the same cyclist locking up outside a cafe", "count": 3 },
    { "prompt": "a slow push-in on the cafe window, rain on the glass",
      "kind": "video", "model": "google/veo-3.1", "duration": 8, "audio": true }
  ]
}'
```

```json
{ "jobs": ["mtiy3mis-0-99d1", "…", "…", "…", "…"], "count": 5, "images": 4, "videos": 1 }
```

`defaults` is merged *under* every item, so the folder, the model and the knobs
are stated once and an item overrides only what it needs. Images, video, songs and
voice lines mix freely — each item's `kind` decides which queue it joins. A bare JSON array of
prompt strings is a valid body too.

The batch is planned in full before anything is queued, so a mistake costs a
rejection rather than a part-spent batch:

```json
{ "error": "items[7]: Prompt is required." }
```

Caps: 50 items and 100 jobs per batch, 12 copies per image item, 4 per video
item. Beyond that, send successive batches.

## Wait for the results

Both generate routes accept `wait: <seconds>`, which holds the response open
until every job it queued has finished. For images — seconds each, eight at a
time — that is usually all you need:

```sh
curl -s "$BASE/api/batch" -H "content-type: application/json" \
  -d '{"items":["a red door","a blue door"],"defaults":{"folder":"Set"},"wait":120}'
```

```json
{ "jobs": ["…", "…"], "count": 2, "settled": true,
  "items":  [ { "file": "20260901-…-a-red-door-b62a.png", "folder": "Set", "bytes": 1512094, "ms": 4210 } ],
  "failed": [ { "id": "…", "prompt": "a blue door", "model": "…", "error": "402 out of credit" } ],
  "cancelled": [], "pending": [], "results": [ …the full job rows… ] }
```

A failed generation lands in `failed`, not in the HTTP status: the request
succeeded, the generation did not. `settled: false` means the clock ran out, and
`pending` names what is still running.

For video — minutes each — poll instead. `GET /api/jobs` reports whatever ids you
name, and `?wait=` makes each poll block until they are all done, so the loop
costs one request per minute rather than one per second:

```sh
IDS=$(curl -s "$BASE/api/batch" -d @batch.json -H "content-type: application/json" | jq -r '.jobs|join(",")')

until curl -s "$BASE/api/jobs?ids=$IDS&wait=60" | jq -e '.settled' >/dev/null; do
  curl -s "$BASE/api/jobs?ids=$IDS" | jq -r '.results[] | "\(.status)\t\(.phase)"'
done
curl -s "$BASE/api/jobs?ids=$IDS" | jq '.items'
```

`wait` is capped at 600 seconds per request. Called with no `ids`, `/api/jobs`
returns the whole registry — every job still retained, newest first — plus
`active`, the queue `limits` and `retainMs`; `?active=1` narrows it to what is
still queued or running. Ids the registry no longer holds come back in `missing`,
which is how "not finished yet" stays distinguishable from "waited too long".

Finished jobs are readable for **30 minutes** (up to 500 of them), so a poller
can be minutes late and still collect everything.

## Reference images

Upload once, then refer to the returned file name. The same picture is never stored twice.

```sh
curl -s "$BASE/api/context" -H "content-type: application/json" \
  -d '{"dataUrl":"data:image/png;base64,iVBORw0KGgo…"}'
# → {"file":"9f1c2b7a4e5d6081.png","existed":false}

curl -s "$BASE/api/context" -H "content-type: application/json" \
  -d '{"path":"/photos/bottle.png"}'
# → {"file":"a930c2bb4e61c068.png","existed":false,"path":"/photos/bottle.png"}
```

`{path}` reads the file off the server's own disk, which is the same machine —
base64-ing a PNG through a shell is nobody's idea of an API. Images only (png,
jpg, webp, gif), 32 MB apiece. An output you just generated is a valid input:
take `folder` and `file` from a finished job and register `<root>/<folder>/<file>`.

You can also skip the round trip entirely and put paths straight into `images`.
Anything with a path separator is registered as it goes by, so these are the same
picture and the same stored bytes:

```json
{ "prompt": "on a canvas tote", "images": ["/photos/logo.png"] }
{ "prompt": "on a canvas tote", "images": ["9f1c2b7a4e5d6081.png"] }
```

Then pass those names as `images`:

- **Image models** — an images API routes through `/images/edits`; a chat-routed model receives them as vision input.
- **Video models** — with `firstFrame: true` (the default) and a model whose `frames` include `first_frame`, the first reference becomes the opening frame, i.e. image-to-video. Otherwise every reference is sent as `input_references` for style guidance.

```sh
curl -s "$BASE/api/generate" -H "content-type: application/json" \
  -d '{"kind":"video","folder":"Campaign","model":"bytedance/seedance-2.0",
       "prompt":"the camera pushes in slowly","images":["9f1c2b7a4e5d6081.png"],"firstFrame":true}'
```

> OpenRouter documents frame images as directly downloadable URLs. JustImagine inlines local references as `data:` URLs, which most upstreams accept; if one rejects it, use a model that takes `input_references`, or host the frame at an `https://` URL.

## Improve a prompt

The ✨ button beside either text field, and the same thing over HTTP. It runs server-side on `google/gemini-3.7-flash` using the OpenRouter key, so nothing extra is configured.

```sh
curl -s "$BASE/api/enhance" -H "content-type: application/json" \
  -d '{"kind":"video","model":"google/veo-3.1","prompt":"rain on a window"}'
```

```json
{ "prompt": "A slow push-in macro shot frames a clear glass window pane during a steady rainstorm…",
  "model": "google/gemini-3.7-flash" }
```

`kind` picks the job, and each gets a different instruction:

| `kind` | Written for | Asks for |
| --- | --- | --- |
| `image` | the model in `model` | subject, composition and framing, light, colour, material detail — under ~80 words |
| `video` | the model in `model` | one continuous shot with a named camera move, and what changes across it — under ~110 words |
| `character` | a saved character's description | the permanent look only — age, build, face, hair, skin, signature clothing; no pose, place or lighting |
| `song` | the music model in `model` | genre, instruments, tempo feel, production and who sings — under ~70 words; one hook for a clip model |
| `lyrics` | an idea, or a draft | singable lyrics with `[Verse]`/`[Chorus]` markers; pass the style as `context` so the words fit the music |
| `voice` | the speech model in `model` | the same words, directed: punctuation for pacing, and audio tags only for a model that performs them; speaker labels kept |
| `voice-design` | a character's description | how they sound — age, accent, pitch, timbre, pace — for `/api/voices/design` |

The rewrite is shaped by what the composer actually has:

- **The model's own capabilities.** A video model's supported durations become "the clip is short (4–8 seconds), so describe one beat"; a model that produces no audio is told not to describe sound.
- **The picked cast.** Their names are kept verbatim and the enhancer is told *not* to restate their face or clothing — the reference images already carry that.
- **Attached references**, by count, so the rewrite describes the scene instead of the picture you already handed it.

Pass `characters` and `images` exactly as you would to `/api/generate`.

> `gemini-3.7-flash` is a reasoning model: it spends ~350 tokens thinking before writing, which is why the budget is 1200. If a reply still runs out of room, the answer is trimmed back to its last complete sentence and returned with `truncated: true` rather than handing you a dangling clause.

Set `JUSTIMAGINE_CHAT_URL` to point the enhancer at a proxy; it is read per call, so a running service picks it up without a restart.

## Characters

A repeatable cast: a name, a description and up to 8 reference images, saved once and picked per generation. The library is global — `~/.bro/justimagine/characters` — so it is the same in every gallery and in the background service, and a character owns its reference images rather than pointing into a gallery that might be deleted.

```text
~/.bro/justimagine/characters/
  nora/
    character.json      { name, description, cover, voice, ts }
    refs/<sha>.png      its own reference images, deduped by content hash
```

```sh
curl -s "$BASE/api/characters" -H "content-type: application/json" \
  -d '{"name":"Nora","description":"early 30s, short dark curly hair, freckles, green field jacket"}'
# → {"character":{"id":"nora","name":"Nora","refs":[],"cover":"","description":"…"}}

# add a reference, either by upload…
curl -s "$BASE/api/characters/refs" -H "content-type: application/json" \
  -d '{"id":"nora","dataUrl":"data:image/png;base64,iVBORw0KGgo…"}'

# …or by promoting a generation you liked
curl -s "$BASE/api/characters/refs" -H "content-type: application/json" \
  -d '{"id":"nora","folder":"Campaign","file":"20260901-133258-….png"}'
```

### Drawing a reference sheet

With no photos to start from, JustImagine can draw the character its own references on `google/gemini-3.1-flash-image` (Nano Banana 2):

```sh
curl -s "$BASE/api/characters/refs/generate" -H "content-type: application/json" \
  -d '{"id":"nora","count":5}'
# → {"job":"mtj38lp9-0-7f83","model":"google/gemini-3.1-flash-image","count":5}
```

**The seed matters.** Five independent generations from one description produce five different people, which is useless as an identity reference. So the first shot is drawn from the description and *every other shot is drawn from that first shot* — front, three-quarter, profile, smiling, full-length, each on a plain mid-grey studio background because these are identity references, not finished pictures. A character that already has a reference skips the seed and draws five more angles off what it has.

Watch it on `/api/events` like any other job; its events carry `characterId`, which is how the editor follows it and the gallery ignores it. Shots are written to disk as they land, so a reload picks the set back up.

They arrive as **candidates**, not references — nothing is kept without asking:

```sh
curl -s "$BASE/api/characters/refs/keep" -H "content-type: application/json" \
  -d '{"id":"nora","files":["0c602ae540170a78.png","a51e226811acb282.png"]}'
curl -s "$BASE/api/characters/candidates/clear" -H "content-type: application/json" -d '{"id":"nora"}'
```

A kept shot keeps its filename, so `GET /charref/<file>?c=<id>` serves it either way. Keeping stops at the 8-reference cap rather than silently dropping the overflow, and a shot whose bytes the character already holds is dropped as a duplicate. At five shots this costs roughly 25–30¢.

Then name the cast in a generation:

```sh
curl -s "$BASE/api/generate" -H "content-type: application/json" \
  -d '{"kind":"image","folder":"Campaign","model":"google/gemini-3-pro-image",
       "prompt":"@Nora reading a paperback on a train, window light",
       "characters":["nora"]}'
```

What that does:

- **The references are attached.** For images they join whatever you attached by hand, capped at 8 between them. For video they go to `input_references` — a character portrait is never pinned as frame one, because that would force every clip to open on that exact photo. If you *did* attach a frame by hand it wins, and the response carries a `warning` saying the cast was not sent.
- **The prompt is composed.** `@Nora` becomes plain `Nora` so the sentence reads naturally, and the descriptions are appended after it:

  ```text
  Nora reading a paperback on a train, window light

  The reference images are this character. Keep their face, hair, build and clothing
  consistent with the references:
  - Nora — early 30s, short dark curly hair, freckles, green field jacket
  ```

- **History records both.** The entry keeps the prompt you typed, plus `characters: ["Nora"]`.

An id that names no character is ignored rather than failing the generation. Renaming a character changes its id (the folder moves with it), so re-read `/api/characters` after an update.

> This is reference-driven consistency, not a trained identity. It is the same mechanism as Higgsfield's avatars, not its Soul Characters — good, and better the more references a character has, but not a guarantee.

## Watch jobs live

Polling covers a script; the event stream is what the page uses, and it is there
if you are building one. Generation is asynchronous for both kinds either way, so
a five-minute video survives a page reload and no client has to hold a socket open.

```sh
curl -sN "$BASE/api/events"
```

```text
data: {"type":"snapshot","jobs":[…]}

data: {"type":"job","job":{"id":"mtiy3mis-0-99d1","kind":"video","folder":"Campaign",
  "prompt":"…","model":"google/veo-3.1","status":"running","phase":"generating","startedAt":1788284032612}}

data: {"type":"job","job":{"id":"mtiy3mis-0-99d1","status":"done","phase":"","item":{…}}}
```

`status` is `queued`, `running`, `done`, `error` or `cancelled`. `phase` narrates a running job (`submitting`, `queued`, `generating`, `downloading`). A finished job carries the full `item` — the same shape `GET /api/items` returns:

```json
{
  "file": "20260901-133431-a-single-droplet-falling-into-still-water-b62a.mp4",
  "kind": "video",
  "folder": "Campaign",
  "prompt": "a single droplet falling into still water, macro, slow motion",
  "api": "openrouter",
  "model": "x-ai/grok-imagine-video",
  "duration": 1,
  "resolution": "480p",
  "aspectRatio": "16:9",
  "cost": 0.05,
  "generationId": "gen-vid-1788284033-4qzXJP15r4pM5q8VNyJf",
  "batch": "mtiy3mis-3f9a2c",
  "bytes": 175171,
  "ms": 38462,
  "ts": 1788284071074
}
```

Jobs are held for half an hour after they finish — 500 of them at most, oldest
dropped first — so a reconnecting page sees the result and a script that polls
every few minutes never misses one.

At most 32 image, 12 video, 8 song and 6 voice generations run at once; the rest wait in a queue and report `status: "queued"`. That is the concurrency, so there is nothing to gain by fanning out requests yourself: send one batch and let the server pace it. Change it with `limits` in the config file — `{ "limits": { "image": 64, "video": 20, "song": 4, "voice": 10 } }` — up to 128 images, 48 videos, 32 songs and 32 voice lines; `GET /api/jobs` reports the caps in force.

Cancel one, some, or everything still in flight:

```sh
curl -s "$BASE/api/cancel" -H "content-type: application/json" -d '{"id":"mtiy3mis-0-99d1"}'
curl -s "$BASE/api/cancel" -H "content-type: application/json" -d '{"ids":["…","…"]}'
curl -s "$BASE/api/cancel" -H "content-type: application/json" -d '{"all":true,"kind":"video"}'
# → {"ok":true,"cancelled":["…"]}
```

## Fetch the media

```sh
curl -s "$BASE/media/<file>?f=<folder>" -o out.png       # whole file
curl -s "$BASE/media/<file>?f=<folder>&dl=1" -O          # with a download disposition
curl -s -H "range: bytes=0-1023" "$BASE/media/<file>?f=" # first KB, 206 Partial Content
```

Generated files never change under their name, so they are served `immutable` with a one-year max-age.

Thumbnails are produced by the browser — one canvas draw of media it has already decoded — and posted back to `/api/thumb`, which keeps the grid fast without pulling an image codec into the CLI. A script can seed them the same way; `GET /thumb/…` simply 404s until one exists.

## Errors

Every route answers with `{"error":"…"}` and a non-200 status. A generation that fails upstream is reported through the job feed rather than the HTTP response, since the request returns before the work starts:

```json
{"type":"job","job":{"id":"…","status":"error","error":"402 out of credit"}}
```
