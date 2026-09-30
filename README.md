# JustImagine

An independent image, video, song and voice generation app, with a gallery, reusable characters (who can each have a voice), provider settings and a JSON API. Images and video run on the image APIs and OpenRouter; songs on OpenRouter (Lyria 3); voices on ElevenLabs. This repository owns the shared server, UI, generation pipeline, storage, CLI and tests. TekPrepperAI and Bro-CLI consume this package.

Requires Node.js 18+; tests use Bun. There are no runtime dependencies.

## Run

```sh
npm start -- --help
npm start -- -p openrouter --root ./gallery --port 8790
```

Standalone configuration, provider keys and the bearer token live in `~/.justimagine`. Keys can also come from the environment: `OPENROUTER_API_KEY` for images, video and songs, `ELEVENLABS_API_KEY` (or `ELEVEN_LABS_API_KEY`) for voices. A variable set while the gallery is running is picked up after a restart. Set `JUSTIMAGINE_HOME` to use a different home, or `JUSTIMAGINE_CONFIG_PATH` to choose the configuration file. The CLI opens a bootstrap URL that exchanges the token for a cookie. API clients send `Authorization: Bearer <token>` from `~/.justimagine/auth.token`. A gallery defaults to `.justimagine` in the working directory; characters live in `~/.justimagine/characters`.

```sh
node bin/justimagine.js service install
node bin/justimagine.js service status
node bin/justimagine.js service stop
```

The standalone background service defaults to port 8793. Its existing `TekPrepper-JustImagine` task names are retained for compatibility with earlier installations. Bro's service remains separate on port 8791 and keeps its existing data paths.

## Shared development

Use sibling checkouts:

```text
F:/JustImagine
F:/TekPrepperAI
F:/bro-cli
```

Both hosts declare `"@justsuperhuman/justimagine": "file:../JustImagine"`. Run `npm install` in each host to link this checkout into its `node_modules`. Changes here then take effect in either host after restarting its process. Use npm for these local dependency links; `bun test` remains the test runner. Bro no longer needs the TekPrepperAI Git submodule.

On the migration machine, Bro's old `vendor/justimagine` path is an ignored local junction to this checkout. It lets an already-running server continue reading its UI and assets until it restarts. New launches import the package directly; fresh checkouts do not need that junction. Original working copies and migration checks are retained locally under `.artifacts/`, outside Git and release packages.

The package exports `@justsuperhuman/justimagine` and the subpaths `/cli`, `/server`, `/auth`, `/generation`, `/audio`, `/music-video`, `/music-video-plan`, `/store`, `/characters`, `/models`, `/openlux` and `/ui`. Consumers use these exports instead of paths into `src`.

- Bro's adapter supplies its configuration, catalogues, terminal UI, `.bro/justimagine` gallery, global cast and OS service integration. Its loopback server stays auth-free.
- TekPrepperAI owns accounts, roles, sessions, Website Studio and per-account app dispatch. Its account guard wraps the shared app, disables local filesystem imports and supplies isolated provider keys and data paths.
- Standalone JustImagine uses token authentication.

Both hosts bundle this dependency when packed with npm, so an installed tarball works without the sibling checkout. To build the TekPrepperAI container, run `docker build --build-context justimagine=../JustImagine -t tekprepper-ai .` from its directory.

## Validate

```sh
npm test
npm run check
npm pack --dry-run
```

Host integration checks run in their own repositories. See [the API reference](docs/justimagine-api.md) for routes, batch generation, characters and storage.

Use [Music video mode](docs/music-video.md) to turn a portrait, short lyrics and a musical style into a clip with generated singing and video. [Full-song music videos](docs/music-video-full-song.md) take a whole song, new or your own, and lip sync every shot to it.

The initial extraction includes the newer provider/settings implementation and pending concurrency changes from Bro's former vendor checkout. The suite and Website Studio are owned by TekPrepperAI and are not part of this package. Original MIT attribution is retained in `LICENSE`.
