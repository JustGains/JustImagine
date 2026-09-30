# Full-song music videos

Music video mode makes one short clip. A full-song music video uses the whole
song: every shot is lip synced to its own part of the song, and the shots are
put together into one video in your browser.

Open it with **Make a full music video** in Music video mode, or with **Music
video** on any song in the gallery.

## What happens

1. **The song.** Write a new one (Lyria 3 on OpenRouter), pick one from your
   library, or upload your own. Lyria's timed lyrics say when each line is sung.
   An uploaded song can have lyrics with `[mm:ss]` times (LRC). Without times,
   the lines are spread evenly over the song.
2. **The shot list.** The song is cut into shots at the start of lyric lines,
   so each shot fits a clip length the lip sync model can make (4 to 15 seconds
   for Seedance 2). "Quick cuts", "Balanced" and "Long takes" set the pace. The
   ✨ model then writes each shot: who is in it, who sings, the opening picture
   and the movement. With no text model, a simple template plans the shots.
3. **The pictures.** One opening picture per shot, drawn with the cast members
   in it, cropped to the video's shape.
4. **Lip sync.** Each picture is animated by Seedance 2. The model hears only
   its own piece of the song and moves the singer's mouth to it.
5. **Your video.** Seedance keeps the piece it heard as the clip's sound, so each
   clip's exact delay is measured against the song and removed. The clips are
   trimmed to their shots on one steady 24 fps timeline, the original song is
   the soundtrack, and the result is encoded to MP4 (H.264 and AAC) with
   WebCodecs. It is saved in the gallery beside everything it was made from.

Progress is saved in the browser. If the tab closes, open the maker again and
choose **Keep going**: only the missing parts are made. A shot can be made
again with **Redo**, and the video is put back together.

## Where it runs

Every step is an ordinary studio request (`/api/batch`, `/api/jobs`,
`/api/context`, `/api/enhance` with `kind: "storyboard"`, `/api/media`), so the
same maker works with the local server and with the hosted studio's own-key
mode, where the engine in the page does the work.

- **OpenLux** Seedance takes each piece of song inline, beside the first frame.
- **OpenRouter** Seedance only fetches audio from an https link and ignores
  references once a first frame is pinned, so the picture goes as a reference
  image and the piece goes to a relay first. The hosted studio runs one that
  keeps each piece for about an hour. A local server uses one when
  `JUSTIMAGINE_AUDIO_RELAY` names an endpoint that takes the bytes and answers
  `{ "url": "https://…" }`. Without it, pick the OpenLux model.

Putting the video together needs WebCodecs (Chrome or Edge on a computer) on a
secure page (https or localhost).

## Requests

A lip-synced shot is a video request with `audioRef`, a WAV or MP3 piece saved
with `POST /api/context` (`{ dataUrl: "data:audio/wav;base64,…" }`). Pieces of
song are kept beside the reference images but are never listed with them.

```json
{
  "kind": "video",
  "model": "doubao-seedance-2-0-fast-260128",
  "api": "openlux",
  "prompt": "The video opens on the reference image… Mal sings the song in the reference audio, lip syncing every word exactly in time with it.",
  "images": ["<picture from /api/context>"],
  "firstFrame": true,
  "audioRef": "<piece from /api/context>",
  "duration": 8,
  "resolution": "720p",
  "aspectRatio": "16:9",
  "audio": true
}
```

The finished file goes up in pieces:

```
POST /api/media                       { folder, name, size, meta }  -> { id }
POST /api/media/chunk?id=…&offset=…   the next bytes                -> { received }
POST /api/media/done                  { id }                        -> { item }
```

`meta` may carry `prompt`, `title`, `workflow` (`"music-video-song"`), `lyrics`,
`duration`, `aspectRatio`, `resolution`, `model`, `characters`, `song` and
`shots` (each shot's times, clip, picture, singer and measured offset). The
planning code is `src/music-video-plan.js`; the maker and the stitcher are
`src/music-video-maker.js`.
