# Music video mode

Choose **Music video** in the composer, select an audio-capable Kling or
Seedance model, attach a performer image (or pick a cast member), and enter a
visual direction, musical style and a short lyric excerpt. Vocals and BPM are
optional. Duration, aspect ratio and resolution follow the chosen model.

This mode creates a short singing performance with a new generated voice.
It does not clone a voice from a photograph. Use one or two lyric lines per
clip; the provider may change pronunciation, timing or words. Check the audio.
For a whole song, lip synced shot by shot, see
[Full-song music videos](music-video-full-song.md).

Both local-server generation and the hosted browser BYOK studio use the same
prompt builder and validation. Seedance can use the OpenLux adapter; Kling uses
the configured BYOK video route. Account-funded requests still pass through the
host's model allowlist, authentication and credit reservation policy. Unsupported
models, disabled audio and invalid durations are refused before submission.

The result is a normal video in the gallery. Its history also records
`workflow: "music-video"`, `lyrics`, `musicStyle`, `vocals` and `bpm`. Running the
result again retains these fields. The default duration is 10 seconds where
supported, otherwise the first supported duration of at least 8 seconds.

API example (use a model available on your provider):

```json
{
  "kind": "video",
  "workflow": "music-video",
  "api": "openlux",
  "model": "doubao-seedance-2-0-fast-260128",
  "prompt": "A performer on a softly lit stage, one slow camera pullback",
  "lyrics": "We light the night, we chase the dawn\nOne little spark, and we carry on",
  "musicStyle": "Acoustic pop, bright guitar and soft drums",
  "vocals": "Warm expressive male singing voice",
  "bpm": 96,
  "duration": 10,
  "resolution": "720p",
  "aspectRatio": "9:16",
  "audio": true,
  "images": ["reference-file-from-context.jpg"],
  "firstFrame": true,
  "folder": "Music videos"
}
```

`kind: "music-video"` is also accepted by the server and browser engine; they
normalize it to the existing video queue. Use the `kind: "video"` example with
older command-line helpers. Reference images use the usual context/cast flow.

Validation covers model eligibility, required/oversized lyrics, duration,
resolution, aspect ratio, tempo, forced audio, delivery of the reference image,
and saved history. The browser check also verifies device persistence, reload,
mobile layout and that no BYOK key or lyrics reach the hosted backend.
