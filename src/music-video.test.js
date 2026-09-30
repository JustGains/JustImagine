import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { musicVideoSpec, buildMusicVideoPrompt, isMusicVideoModel } from './music-video.js';
import { createServer, listenOnFreePort } from './justimagine-server.js';
import { listItems } from './justimagine-store.js';

const model = { id: 'doubao-seedance-2-0-fast-260128', api: 'openlux', adapter: 'seedance', audio: true, durations: [5, 10], resolutions: ['720p'], aspectRatios: ['16:9'], frames: ['first_frame'] };
test('music videos require a known singing model and validate before billing', () => {
  expect(isMusicVideoModel(model)).toBe(true);
  expect(isMusicVideoModel({ ...model, id: 'kwaivgi/kling-v3.0-pro' })).toBe(true);
  for (const id of ['kwaivgi/kling-video-o1', 'seedance-1.0', 'unknown']) expect(isMusicVideoModel({ ...model, id })).toBe(false);
  expect(() => musicVideoSpec({ lyrics: 'Hello' }, { ...model, audio: false })).toThrow('native audio');
  expect(() => musicVideoSpec({}, model)).toThrow('lyrics');
  for (const invalid of [{ duration: 6 }, { audio: false }, { bpm: 999 }, { resolution: '4K' }, { lyrics: 'a'.repeat(1201) }]) {
    expect(() => musicVideoSpec({ lyrics: 'We light the night', ...invalid }, model)).toThrow();
  }
  const spec = musicVideoSpec({ lyrics: 'We light the night\nWe own the dawn', musicStyle: 'synth pop', bpm: 100 }, model);
  expect(spec).toMatchObject({ duration: 10, audio: true, workflow: 'music-video' });
  const prompt = buildMusicVideoPrompt('A singer on a rooftop', spec);
  expect(prompt).toContain('Lyrics:\nWe light the night\nWe own the dawn');
  expect(prompt).toContain('100 BPM'); expect(prompt).toContain('Sing them, do not speak');
});

test('music-video API preserves reference, lyrics, native audio and saved history through the video queue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-music-video-'));
  const previous = process.env.JUSTIMAGINE_OPENLUX_URL;
  let sent, posts = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'POST') { const chunks = []; for await (const c of req) chunks.push(c); sent = JSON.parse(Buffer.concat(chunks)); posts++; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'music-task', status: 'succeeded', content: { video_url: 'data:video/mp4;base64,AAAAHGZ0eXBtcDQy' } }));
  });
  const close = async s => { s.closeAllConnections?.(); await new Promise(r => s.close(r)); };
  let server;
  try {
    process.env.JUSTIMAGINE_OPENLUX_URL = `http://127.0.0.1:${await listenOnFreePort(upstream, 0)}`;
    server = createServer({ root, charactersRoot: path.join(root, 'cast'), auth: false, apis: [{ id: 'openlux', name: 'OpenLux', video: true, models: [] }], videoModels: [model], resolveKey: () => 'fixture-key' });
    const base = `http://127.0.0.1:${await listenOnFreePort(server, 0)}`;
    const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const refResponse = await post('/api/context', { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' });
    expect(refResponse.status).toBe(200); const ref = await refResponse.json();
    const spec = { kind: 'video', workflow: 'music-video', model: model.id, api: 'openlux', folder: 'Music Tests', prompt: 'A singer on a neon rooftop', lyrics: 'We light the night', musicStyle: 'synth pop', images: [ref.file], duration: 10, resolution: '720p' };
    expect((await post('/api/generate', { ...spec, lyrics: '' })).status).toBe(400);
    expect(posts).toBe(0);
    const queued = await post('/api/generate', spec); expect(queued.status).toBe(200);
    const { jobs } = await queued.json();
    const result = await (await fetch(base + `/api/jobs?ids=${jobs.join(',')}&wait=5`)).json();
    expect(result.results[0].status).toBe('done');
    expect(posts).toBe(1); expect(sent.generate_audio).toBe(true);
    expect(sent.content[0].text).toContain(spec.lyrics);
    expect(sent.content.find(c => c.role === 'first_frame').image_url.url).toStartWith('data:image/png');
    const items = listItems(path.join(root, 'Music Tests'));
    expect(items[0]).toMatchObject({ kind: 'video', workflow: 'music-video', lyrics: spec.lyrics, musicStyle: 'synth pop', audio: true });
    expect(fs.statSync(path.join(root, 'Music Tests', items[0].file)).size).toBeGreaterThan(0);
  } finally {
    if (server) await close(server); await close(upstream);
    if (previous === undefined) delete process.env.JUSTIMAGINE_OPENLUX_URL; else process.env.JUSTIMAGINE_OPENLUX_URL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
