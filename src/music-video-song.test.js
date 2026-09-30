import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer, listenOnFreePort, sniffMedia } from './justimagine-server.js';
import { listItems } from './justimagine-store.js';
import { buildVideoBody } from './justimagine-gen.js';
import { buildOpenLuxVideoRequest } from './openlux.js';

// A tiny valid WAV: 44-byte header and a little silence.
function wav(seconds = 2, rate = 8000) {
  const samples = Math.round(seconds * rate), buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  return buf;
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)]);

test('song pieces ride along as audio references on both routes', () => {
  const a = { url: 'https://relay.example/piece.wav' };
  const body = buildVideoBody({ model: 'bytedance/seedance-2.0-fast', prompt: 'p', firstFrame: { dataUrl: PNG }, audioRefs: [a] });
  // OpenRouter drops references once a frame is pinned, so the frame becomes a reference image.
  expect(body.frame_images).toBeUndefined();
  expect(body.input_references).toEqual([{ type: 'image_url', image_url: { url: PNG } }, { type: 'audio_url', audio_url: { url: a.url } }]);
  expect(buildVideoBody({ model: 'm', prompt: 'p', firstFrame: { dataUrl: PNG } }).frame_images).toHaveLength(1);

  const req = buildOpenLuxVideoRequest('seedance', { model: 'doubao-seedance-2-0-fast-260128', prompt: 'p', firstFrame: { dataUrl: PNG }, audioRefs: [{ dataUrl: 'data:audio/wav;base64,UklGRg==' }] });
  expect(req.body.content.map((c) => c.role || c.type)).toEqual(['text', 'first_frame', 'reference_audio']);
  expect(req.body.content[2]).toEqual({ type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,UklGRg==' }, role: 'reference_audio' });
});

test('uploads are recognised by their bytes', () => {
  expect(sniffMedia(MP4.subarray(0, 16))).toBe('video/mp4');
  expect(sniffMedia(wav(0.1).subarray(0, 16))).toBe('audio/wav');
  expect(sniffMedia(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'))).toBe('audio/mpeg');
  expect(sniffMedia(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe('video/webm');
  expect(sniffMedia(Buffer.from('hello world, not media'))).toBe('');
});

async function withServer(options, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-mv-song-'));
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    seen.push({ method: req.method, url: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/chat')) {
      const shots = JSON.parse(body.messages[1].content).shots;
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'Test', look: 'Warm light', shots: shots.map((s) => ({ n: s.n, cast: ['Mal'], singer: s.lyrics ? 'Mal' : null, image: `Shot ${s.n}`, motion: 'Push in.' })) }) } }], usage: { cost: 0.002 } }));
    }
    if (req.url.startsWith('/videos') && req.method === 'POST') return res.end(JSON.stringify({ id: 'v1', status: 'completed', unsigned_urls: [`http://127.0.0.1:${upstream.address().port}/clip.mp4`] }));
    if (req.url.startsWith('/clip.mp4')) { res.setHeader('content-type', 'video/mp4'); return res.end(MP4); }
    // OpenLux Seedance
    res.end(JSON.stringify({ id: 'task', status: 'succeeded', content: { video_url: 'data:video/mp4;base64,' + MP4.toString('base64') } }));
  });
  const close = async (s) => { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); };
  const saved = { lux: process.env.JUSTIMAGINE_OPENLUX_URL, video: process.env.JUSTIMAGINE_VIDEO_URL };
  let server;
  try {
    const up = `http://127.0.0.1:${await listenOnFreePort(upstream, 0)}`;
    process.env.JUSTIMAGINE_OPENLUX_URL = up;
    process.env.JUSTIMAGINE_VIDEO_URL = `${up}/videos`;
    const models = [
      { id: 'doubao-seedance-2-0-fast-260128', api: 'openlux', adapter: 'seedance', audio: true, durations: [4, 5, 6, 7, 8], resolutions: ['480p', '720p'], aspectRatios: ['16:9'], frames: ['first_frame'] },
      { id: 'bytedance/seedance-2.0-fast', api: 'openrouter', audio: true, durations: [4, 5, 6, 7, 8], resolutions: ['480p'], aspectRatios: ['16:9'], frames: ['first_frame'] },
      { id: 'google/veo-3.1', api: 'openrouter', audio: true, durations: [8], frames: ['first_frame'] }
    ];
    server = createServer({
      root, charactersRoot: path.join(root, 'cast'), auth: false,
      apis: [{ id: 'openlux', name: 'OpenLux', video: true, models: [] }, { id: 'openrouter', name: 'OpenRouter', video: true, chatUrl: `${up}/chat`, models: [] }],
      videoModels: models, resolveKey: () => 'fixture-key', ...options
    });
    const base = `http://127.0.0.1:${await listenOnFreePort(server, 0)}`;
    const post = (url, body, headers = { 'content-type': 'application/json' }) => fetch(base + url, { method: 'POST', headers, body: Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    await fn({ base, post, root, seen });
  } finally {
    if (server) await close(server);
    await close(upstream);
    for (const [k, env] of [['lux', 'JUSTIMAGINE_OPENLUX_URL'], ['video', 'JUSTIMAGINE_VIDEO_URL']]) if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const wait = async (base, jobs) => (await (await fetch(`${base}/api/jobs?ids=${jobs.join(',')}&wait=10`)).json()).results;

test('a lip-synced shot sends its song piece, checked before anything is paid for', async () => {
  let relayed = 0;
  await withServer({ audioRelay: null }, async ({ base, post, root, seen }) => {
    const piece = await (await post('/api/context', { dataUrl: `data:audio/wav;base64,${wav().toString('base64')}` })).json();
    expect(piece.file).toMatch(/^[0-9a-f]{16}\.wav$/);
    const frame = await (await post('/api/context', { dataUrl: PNG })).json();
    // Pieces of song never show up among the reference images.
    const state = await (await fetch(base + '/api/state')).json();
    expect(state.context.map((c) => c.file)).toEqual([frame.file]);
    expect(state.audioRelay).toBe(false);

    const shot = { kind: 'video', prompt: 'Mal sings', images: [frame.file], firstFrame: true, audioRef: piece.file, duration: 5, resolution: '480p', aspectRatio: '16:9', folder: 'MV' };
    // OpenRouter needs a public link, and there is no relay here.
    const refused = await post('/api/generate', { ...shot, model: 'bytedance/seedance-2.0-fast', api: 'openrouter' });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain('OpenLux');
    // A model that cannot lip sync is refused too.
    expect((await post('/api/generate', { ...shot, model: 'google/veo-3.1', api: 'openrouter', duration: 8 })).status).toBe(400);
    expect((await post('/api/generate', { ...shot, audioRef: 'missing.wav', model: 'doubao-seedance-2-0-fast-260128', api: 'openlux' })).status).toBe(400);
    expect(seen).toHaveLength(0);

    const queued = await (await post('/api/generate', { ...shot, model: 'doubao-seedance-2-0-fast-260128', api: 'openlux' })).json();
    const [result] = await wait(base, queued.jobs);
    expect(result.status).toBe('done');
    const sent = seen.find((r) => r.method === 'POST').body;
    expect(sent.generate_audio).toBe(true);
    expect(sent.content.map((c) => c.role || c.type)).toEqual(['text', 'first_frame', 'reference_audio']);
    expect(sent.content[2].audio_url.url).toStartWith('data:audio/wav;base64,');
    const [item] = listItems(path.join(root, 'MV'));
    expect(item).toMatchObject({ kind: 'video', audioRef: piece.file, audio: true });
  });

  await withServer({ audioRelay: async (ref) => { relayed++; expect(ref.type).toBe('audio/wav'); return 'https://relay.example/p.wav'; } }, async ({ base, post, seen }) => {
    const piece = await (await post('/api/context', { dataUrl: `data:audio/wav;base64,${wav().toString('base64')}` })).json();
    const frame = await (await post('/api/context', { dataUrl: PNG })).json();
    const queued = await (await post('/api/generate', { kind: 'video', prompt: 'Mal sings', model: 'bytedance/seedance-2.0-fast', api: 'openrouter', images: [frame.file], firstFrame: true, audioRef: piece.file, duration: 5, folder: 'MV' })).json();
    const [result] = await wait(base, queued.jobs);
    expect(result.status).toBe('done');
    expect(relayed).toBe(1);
    const sent = seen.find((r) => r.method === 'POST' && r.url.startsWith('/videos')).body;
    expect(sent.frame_images).toBeUndefined();
    expect(sent.input_references.map((r) => r.type)).toEqual(['image_url', 'audio_url']);
    expect(sent.input_references[1].audio_url.url).toBe('https://relay.example/p.wav');
  });
});

test('the storyboard is written by the prompt model and checked against the cast', async () => {
  await withServer({}, async ({ post, seen }) => {
    const mal = await (await post('/api/characters', { name: 'Mal', description: 'A white marshmallow in a yellow headband' })).json();
    const shots = [{ n: 1, start: 0, end: 4, clip: 4, lines: [], vocal: false }, { n: 2, start: 4, end: 12, clip: 8, lines: ['Headbands on'], vocal: true }];
    const res = await post('/api/enhance', { kind: 'storyboard', song: { title: 'Just Gains', style: 'pop funk' }, shots, characters: [mal.character.id], idea: 'A sunny gym', aspect: '9:16' });
    expect(res.status).toBe(200);
    const { board } = await res.json();
    expect(board.written).toBe(true);
    expect(board.shots.map((s) => s.singer)).toEqual([null, 'Mal']);
    const chat = seen.find((r) => r.url.startsWith('/chat')).body;
    const user = JSON.parse(chat.messages[1].content);
    expect(user.cast).toEqual([{ name: 'Mal', description: 'A white marshmallow in a yellow headband' }]);
    expect(user.frame).toBe('9:16');
    expect((await post('/api/enhance', { kind: 'storyboard', shots: [] })).status).toBe(400);
  });
});

test('a finished video is uploaded in pieces into the gallery', async () => {
  await withServer({}, async ({ base, post, root }) => {
    const bytes = Buffer.concat([MP4, Buffer.alloc(5000, 3)]);
    const meta = { prompt: 'Just Gains music video', workflow: 'music-video-song', duration: 30.8, shots: [{ n: 1, start: 0, end: 4, clip: 'a.mp4', offset: 0.05 }], secret: 'dropped' };
    const { id } = await (await post('/api/media', { folder: 'Music videos/Just Gains', name: 'just-gains.mp4', size: bytes.length, meta })).json();
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    const chunk = (offset, part) => post(`/api/media/chunk?id=${id}&offset=${offset}`, part, { 'content-type': 'application/octet-stream' });
    expect((await chunk(0, bytes.subarray(0, 3000))).status).toBe(200);
    expect((await chunk(0, bytes.subarray(0, 3000))).status).toBe(409); // out of order
    const early = await post('/api/media/done', { id });
    expect(early.status).toBe(400);
  });
  await withServer({}, async ({ post, root }) => {
    const bytes = Buffer.concat([MP4, Buffer.alloc(5000, 3)]);
    const { id } = await (await post('/api/media', { folder: 'Music videos', name: 'x.mp4', size: bytes.length, meta: { prompt: 'Just Gains', workflow: 'music-video-song', shots: [{ n: 1, start: 0, end: 4 }], secret: 1 } })).json();
    await post(`/api/media/chunk?id=${id}&offset=0`, bytes.subarray(0, 3000), { 'content-type': 'application/octet-stream' });
    await post(`/api/media/chunk?id=${id}&offset=3000`, bytes.subarray(3000), { 'content-type': 'application/octet-stream' });
    const done = await (await post('/api/media/done', { id })).json();
    expect(done.item).toMatchObject({ kind: 'video', folder: 'Music videos', workflow: 'music-video-song', prompt: 'Just Gains', bytes: bytes.length });
    expect(done.item.secret).toBeUndefined();
    expect(done.item.file).toEndWith('.mp4');
    expect(fs.readFileSync(path.join(root, 'Music videos', done.item.file))).toEqual(bytes);
    expect(listItems(path.join(root, 'Music videos'))[0].file).toBe(done.item.file);
    // A song from elsewhere becomes a song.
    const song = wav(1);
    const up = await (await post('/api/media', { folder: 'Music videos', name: 'my-song.wav', size: song.length, meta: { lyrics: 'la la' } })).json();
    await post(`/api/media/chunk?id=${up.id}&offset=0`, song, { 'content-type': 'application/octet-stream' });
    expect((await (await post('/api/media/done', { id: up.id })).json()).item).toMatchObject({ kind: 'song', lyrics: 'la la', prompt: 'my-song.wav' });
    // Anything else is refused.
    const junk = Buffer.from('this is not a media file at all');
    const bad = await (await post('/api/media', { folder: '', name: 'x.txt', size: junk.length })).json();
    await post(`/api/media/chunk?id=${bad.id}&offset=0`, junk, { 'content-type': 'application/octet-stream' });
    expect((await post('/api/media/done', { id: bad.id })).status).toBe(400);
  });
});

test('a song in the gallery is timed by ear', async () => {
  const stt = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: 'hello there', words: [{ word: 'hello', start: 1.2, end: 1.5 }, { word: 'there', start: 1.6, end: 2 }], usage: { cost: 0.001 }, got: { model: body.model, format: body.input_audio.format, granular: body.timestamp_granularities, verbose: body.response_format, bytes: Buffer.from(body.input_audio.data, 'base64').length } }));
  });
  const url = `http://127.0.0.1:${await listenOnFreePort(stt, 0)}`;
  const previous = process.env.JUSTIMAGINE_TRANSCRIBE_URL;
  process.env.JUSTIMAGINE_TRANSCRIBE_URL = url;
  try {
    await withServer({}, async ({ base, post, root }) => {
      fs.mkdirSync(path.join(root, 'Songs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'Songs', 'tune.wav'), wav(1));
      const state = await (await fetch(base + '/api/state')).json();
      expect(state.transcribeReady).toBe(true);
      const r = await (await post('/api/transcribe', { folder: 'Songs', file: 'tune.wav' })).json();
      expect(r.words).toEqual([{ word: 'hello', start: 1.2, end: 1.5 }, { word: 'there', start: 1.6, end: 2 }]);
      expect(r.model).toBe('openai/whisper-large-v3');
      expect((await post('/api/transcribe', { folder: 'Songs', file: 'missing.wav' })).status).toBe(404);
      fs.writeFileSync(path.join(root, 'Songs', 'pic.png'), Buffer.from('x'));
      expect((await post('/api/transcribe', { folder: 'Songs', file: 'pic.png' })).status).toBe(400);
    });
  } finally {
    if (previous === undefined) delete process.env.JUSTIMAGINE_TRANSCRIBE_URL; else process.env.JUSTIMAGINE_TRANSCRIBE_URL = previous;
    stt.closeAllConnections?.();
    await new Promise((r) => stt.close(r));
  }
});
