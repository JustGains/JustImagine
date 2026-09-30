import { afterAll, beforeAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  buildOpenLuxVideoRequest,
  generateOpenLuxVideo,
  loadOpenLuxCatalogue,
  mapOpenLuxCatalogue,
  mergeOpenLuxCatalogue,
  taskIdOf,
  taskState,
  videoUrlOf
} from './openlux.js';
import { enrichMediaFacts, catalogueIndex, formatCents, mediaModelFacts, sortMediaModels } from './model-info.js';
import { createServer, listenOnFreePort } from './justimagine-server.js';

// A slice of the real /api/pricing_new, trimmed to one of each kind that matters.
const CATALOGUE = {
  success: true,
  group_ratio: { 'Gpt-Image-1': 0.07353, 'Gpt-Image-2': 0.09192, 'Azure-Gpt-1': 0.044, 'Discounted-Gemini-1': 0.07353, 'Xai-Grok-1': 0.44118, 'Seedance-1': 0.65, 'MJ-3': 0.147, 'Kling-2': 0.85, 'Aistudio-Gemini-1': 0.17647 },
  supported_endpoint: {
    'openai-绘图': { path: '/v1/images/generations', method: 'POST' },
    'image-generation': { path: '/v1/images/generations', method: 'POST' },
    openai: { path: '/v1/chat/completions', method: 'POST' },
    gemini: { path: '/v1beta/models/{model}:generateContent', method: 'POST' },
    'MJ imagine': { path: '/mj/submit/imagine', method: 'POST' },
    'OpenAI video format': { path: '/v1/videos', method: 'POST' },
    官方格式: { path: '/v1/videos/generations', method: 'POST' },
    'Doubao video': { path: '/api/v3/contents/generations/tasks', method: 'POST' },
    'Text to video': { path: '/kling/v1/videos/text2video', method: 'POST' }
  },
  data: [
    { model_name: 'gpt-image-2-c', model_type: '图像', quota_type: 1, model_price: 0.12, enable_groups: ['Gpt-Image-1', 'Gpt-Image-2'], supported_endpoint_types: ['openai-绘图'], created_time: 300 },
    { model_name: 'gpt-image-1', model_type: '图像', quota_type: 0, model_ratio: 2.5, completion_ratio: 8, enable_groups: ['Azure-Gpt-1'], supported_endpoint_types: ['image-generation'], created_time: 100 },
    { model_name: 'gemini-3-pro-image', model_type: '图像', quota_type: 1, model_price: 0.33, enable_groups: ['Aistudio-Gemini-1'], supported_endpoint_types: ['gemini', 'openai'], description: 'Google image model.', created_time: 200 },
    { model_name: 'mj_imagine', model_type: '图像', quota_type: 1, model_price: 0.3, enable_groups: ['MJ-3'], supported_endpoint_types: ['MJ imagine'] },
    { model_name: 'veo_3_1', model_type: '音视频', quota_type: 1, model_price: 0.768, enable_groups: ['Discounted-Gemini-1'], supported_endpoint_types: ['OpenAI video format'], created_time: 500 },
    { model_name: 'grok-imagine-video', model_type: '音视频', quota_type: 1, model_price: 0.01, enable_groups: ['Xai-Grok-1'], supported_endpoint_types: ['官方格式'], created_time: 400 },
    { model_name: 'doubao-seedance-2-0-260128', model_type: '音视频', quota_type: 1, model_price: 0.01, enable_groups: ['Seedance-1'], supported_endpoint_types: ['Doubao video'], created_time: 450 },
    { model_name: 'kling-video', model_type: '音视频', quota_type: 1, model_price: 0.0014706, enable_groups: ['Kling-2'], supported_endpoint_types: ['Text to video'] },
    { model_name: 'tts-1', model_type: '音视频', quota_type: 0, model_ratio: 0.25, completion_ratio: 30, enable_groups: ['Azure-Gpt-1'], supported_endpoint_types: ['openai'] },
    { model_name: 'retired-image', model_type: '图像', quota_type: 1, model_price: 1, enable_groups: ['Gpt-Image-1'], supported_endpoint_types: ['openai-绘图'], available: false }
  ]
};

// ---------- catalogue ----------

test('image models are priced per picture at the cheapest group they are sold in', () => {
  const { images } = mapOpenLuxCatalogue(CATALOGUE);
  const byId = Object.fromEntries(images.map((m) => [m.id, m]));
  // Midjourney has a task route of its own; an unavailable model is not offered.
  expect(Object.keys(byId).sort()).toEqual(['gemini-3-pro-image', 'gpt-image-1', 'gpt-image-2-c']);
  expect(byId['gpt-image-2-c']).toMatchObject({ via: 'images', pricing: { perImage: 0.00882, source: 'OpenLux list price' } });
  expect(byId['gpt-image-2-c'].pricing.basis).toMatch(/Gpt-Image-1/);
  // Per token: 2 × 2.5 × 8 × 0.044 = $1.76/M output, × 1056 tokens a picture.
  expect(byId['gpt-image-1'].pricing).toMatchObject({ imageOutput: 1.76, perImage: 0.00186 });
  // Only reachable over chat, so it is routed there.
  expect(byId['gemini-3-pro-image']).toMatchObject({ via: 'chat', description: 'Google image model.', pricing: { perImage: 0.05824 } });
  // Newest first, like the OpenRouter lists.
  expect(images.map((m) => m.id)).toEqual(['gpt-image-2-c', 'gemini-3-pro-image', 'gpt-image-1']);
});

test('video models are offered only where there is an adapter, each priced its own way', () => {
  const { videos } = mapOpenLuxCatalogue(CATALOGUE);
  const byId = Object.fromEntries(videos.map((m) => [m.id, m]));
  expect(Object.keys(byId).sort()).toEqual(['doubao-seedance-2-0-260128', 'grok-imagine-video', 'veo_3_1']);
  for (const m of videos) expect(m.api).toBe('openlux');
  expect(byId.veo_3_1).toMatchObject({ adapter: 'openai-videos', durations: [8], pricing: { perClip: 0.05647, clipSeconds: 8 } });
  // 0.01 × 0.44118 × 7 per second.
  expect(byId['grok-imagine-video']).toMatchObject({ adapter: 'grok', pricing: { perSecond: 0.03088 } });
  // $4.55 per million tokens (0.01 × 0.65 × 700), at 21,600 tokens a second of 720p.
  expect(byId['doubao-seedance-2-0-260128']).toMatchObject({ adapter: 'seedance', audio: true, seed: true, pricing: { perSecond: 0.09828 } });
  expect(byId['doubao-seedance-2-0-260128'].pricing.basis).toMatch(/^720p, cheapest key group \(Seedance-1\)/);
});

test('an unusable catalogue maps to nothing rather than throwing', () => {
  expect(mapOpenLuxCatalogue(null)).toEqual({ images: [], videos: [] });
  expect(mapOpenLuxCatalogue({ data: 'nope' })).toEqual({ images: [], videos: [] });
});

test('merging keeps declared models the live list does not name, and a declared route', () => {
  const api = { id: 'openlux', models: [{ id: 'gpt-image-2-c', via: 'images', name: 'mine' }, { id: 'old-model', via: 'images' }] };
  const lux = { images: [{ id: 'gpt-image-2-c', name: 'gpt-image-2-c', via: 'chat', pricing: { perImage: 0.01 } }], videos: [{ id: 'veo_3_1', api: 'openlux' }] };
  const videos = mergeOpenLuxCatalogue(api, lux, [{ id: 'google/veo-3.1' }]);
  expect(api.models.map((m) => m.id)).toEqual(['gpt-image-2-c', 'old-model']);
  expect(api.models[0]).toMatchObject({ via: 'images', pricing: { perImage: 0.01 } });
  expect(videos.map((m) => m.id)).toEqual(['google/veo-3.1', 'veo_3_1']);
  // Nothing loaded: nothing changes.
  expect(mergeOpenLuxCatalogue(api, null, videos)).toBe(videos);
});

// ---------- display ----------

test('a per-clip price shows as one, and sorts by what a second of it costs', () => {
  const veo = { id: 'veo_3_1', pricing: { perClip: 0.05647, clipSeconds: 8, basis: 'cheapest key group (X)', source: 'OpenLux list price' } };
  const facts = mediaModelFacts(veo, { kind: 'video' });
  expect(facts.cost.label).toBe('5.6¢/clip');
  expect(facts.cost.title).toMatch(/per 8-second clip at cheapest key group \(X\) \(OpenLux list price\)/);
  const grok = { id: 'g', pricing: { perSecond: 0.03 } };
  const pricey = { id: 'p', pricing: { perSecond: 0.5 } };
  expect(sortMediaModels([pricey, veo, grok], 'cost').map((m) => m.id)).toEqual(['veo_3_1', 'g', 'p']);
});

test('a per-token image price names its own source, and a fraction of a cent is not "0¢"', () => {
  const { images } = mapOpenLuxCatalogue(CATALOGUE);
  const title = mediaModelFacts(images.find((m) => m.id === 'gpt-image-1'), { kind: 'image' }).cost.title;
  expect(title).toMatch(/output tokens \(OpenLux list price\)/);
  expect(formatCents(0.00037)).toBe('<0.1¢');
  expect(formatCents(0.0012)).toBe('0.1¢');
});

test('a provider with its own price is not described as quoting OpenRouter', () => {
  const index = catalogueIndex([{ id: 'google/veo-3.1', description: 'From OpenRouter.', pricing: { perSecond: 0.4 } }]);
  const own = enrichMediaFacts({ id: 'veo-3.1', pricing: { perSecond: 0.1, source: 'OpenLux list price' } }, index);
  expect(own.description).toBe('From OpenRouter.');
  expect(mediaModelFacts(own, { kind: 'video' }).cost.title).not.toMatch(/OpenRouter's list price/);
  const borrowed = enrichMediaFacts({ id: 'veo-3.1' }, index);
  expect(mediaModelFacts(borrowed, { kind: 'video' }).cost.title).toMatch(/OpenRouter's list price for google\/veo-3\.1/);
});

// ---------- requests and responses ----------

const frame = { dataUrl: 'data:image/png;base64,AAAA' };

test('each adapter builds the body its route documents', () => {
  const veo = buildOpenLuxVideoRequest('openai-videos', { model: 'veo_3_1', prompt: 'a wave', duration: 8, aspectRatio: '9:16', firstFrame: frame });
  expect(veo.url).toMatch(/\/v1\/videos$/);
  expect(Object.fromEntries(veo.form)).toEqual({ model: 'veo_3_1', prompt: 'a wave', seconds: '8', size: '9:16', input_reference: frame.dataUrl });

  // Grok requires all three knobs, so "auto" falls back to defaults.
  const grok = buildOpenLuxVideoRequest('grok', { model: 'grok-imagine-video', prompt: 'p', resolution: 'auto', aspectRatio: 'auto', refs: [frame] });
  expect(grok.url).toMatch(/\/v1\/videos\/generations$/);
  expect(grok.body).toEqual({ model: 'grok-imagine-video', prompt: 'p', duration: 6, resolution: '720p', aspect_ratio: '16:9', reference_images: [{ url: frame.dataUrl }] });

  const sd = buildOpenLuxVideoRequest('seedance', {
    model: 'doubao-seedance-2-0-260128', prompt: 'p', duration: 5, resolution: '1080p', aspectRatio: '21:9', generateAudio: false, seed: '7',
    firstFrame: frame, lastFrame: { url: 'https://x/last.png' }, refs: [frame]
  });
  expect(sd.url).toMatch(/\/api\/v3\/contents\/generations\/tasks$/);
  expect(sd.body).toEqual({
    model: 'doubao-seedance-2-0-260128',
    content: [
      { type: 'text', text: 'p' },
      { type: 'image_url', image_url: { url: frame.dataUrl }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: 'https://x/last.png' }, role: 'last_frame' }
    ],
    duration: 5, resolution: '1080p', ratio: '21:9', generate_audio: false, seed: 7
  });
  expect(() => buildOpenLuxVideoRequest('kling', { model: 'kling-video', prompt: 'p' })).toThrow(/no video route/);
});

test('task fields are found bare or inside the { code, data } envelope', () => {
  expect(taskIdOf({ id: 'video_1' })).toBe('video_1');
  expect(taskIdOf({ code: 0, data: { task_id: 't-2' } })).toBe('t-2');
  expect(taskState({ data: { status: 'SUCCEED' } })).toMatchObject({ done: true, failed: false });
  expect(taskState({ status: 'failed' })).toMatchObject({ done: false, failed: true });
  expect(taskState({ status: 'video_generating' })).toMatchObject({ done: false, failed: false });
  expect(videoUrlOf({ data: { content: { video_url: 'https://cdn/v.mp4' } } })).toBe('https://cdn/v.mp4');
  expect(videoUrlOf({ status: 'completed', video_url: 'https://cdn/w.mp4' })).toBe('https://cdn/w.mp4');
});

// ---------- against a fake OpenLux ----------

let upstream;
let origin;
const seen = [];
let script = {};

beforeAll(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    seen.push({ method: req.method, path: req.url, auth: req.headers.authorization || '', type: req.headers['content-type'] || '', body });
    const handler = script[`${req.method} ${req.url}`];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no route ${req.url}`, type: 'new_api_error' } }));
      return;
    }
    const out = typeof handler === 'function' ? handler() : handler;
    if (Buffer.isBuffer(out)) {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(out);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${upstream.address().port}`;
  process.env.JUSTIMAGINE_OPENLUX_URL = origin;
});

afterAll(async () => {
  delete process.env.JUSTIMAGINE_OPENLUX_URL;
  upstream.closeAllConnections?.();
  await new Promise((r) => upstream.close(r));
});

const noWait = () => Promise.resolve();

test('a Seedance task is submitted, polled in the envelope, and fetched without leaking the key', async () => {
  seen.length = 0;
  let polls = 0;
  // The finished URL is a third-party host — the fake again, under a different
  // origin spelling — so the key must not travel with the download.
  script = {
    'POST /api/v3/contents/generations/tasks': { code: 0, message: 'success', data: { task_id: 'sd-1' } },
    'GET /api/v3/contents/generations/tasks/sd-1': () =>
      ++polls < 2
        ? { code: 0, data: { status: 'running' } }
        : { code: 0, data: { status: 'succeeded', content: { video_url: `${origin.replace('127.0.0.1', 'localhost')}/cdn/clip.mp4` } } },
    'GET /cdn/clip.mp4': Buffer.from('mp4-bytes')
  };
  const phases = [];
  const r = await generateOpenLuxVideo({
    apiKey: 'lux',
    adapter: 'seedance',
    params: { model: 'doubao-seedance-2-0-260128', prompt: 'a wave', duration: 5 },
    sleep: noWait,
    onProgress: (p) => phases.push(p.phase)
  });
  expect(r.buf.toString()).toBe('mp4-bytes');
  expect(r.ext).toBe('mp4');
  expect(r.generationId).toBe('sd-1');
  expect(phases).toEqual(['submitting', 'queued', 'generating', 'generating', 'downloading']);
  const submit = seen.find((s) => s.method === 'POST');
  expect(submit.auth).toBe('Bearer lux');
  expect(JSON.parse(submit.body)).toMatchObject({ model: 'doubao-seedance-2-0-260128', duration: 5 });
  expect(seen.find((s) => s.path === '/cdn/clip.mp4').auth).toBe('');
});

test('an OpenAI-format job with no URL is downloaded from /content with the key', async () => {
  seen.length = 0;
  script = {
    'POST /v1/videos': { id: 'video_9', status: 'queued' },
    'GET /v1/videos/video_9': { id: 'video_9', status: 'completed' },
    'GET /v1/videos/video_9/content': Buffer.from('veo-bytes')
  };
  const r = await generateOpenLuxVideo({ apiKey: 'lux', adapter: 'openai-videos', params: { model: 'veo_3_1', prompt: 'p', duration: 8 }, sleep: noWait });
  expect(r.buf.toString()).toBe('veo-bytes');
  const submit = seen.find((s) => s.method === 'POST');
  expect(submit.type).toMatch(/^multipart\/form-data/);
  expect(submit.body).toContain('name="seconds"');
  expect(seen.find((s) => s.path === '/v1/videos/video_9/content').auth).toBe('Bearer lux');
});

test('a failed task reports the upstream reason; an HTTP 200 error is still an error', async () => {
  script = {
    'POST /v1/videos/generations': { id: 'g-1', status: 'pending' },
    'GET /v1/videos/g-1': { id: 'g-1', status: 'failed', fail_reason: 'prompt rejected by moderation' }
  };
  await expect(
    generateOpenLuxVideo({ apiKey: 'lux', adapter: 'grok', params: { model: 'grok-imagine-video', prompt: 'p' }, sleep: noWait })
  ).rejects.toThrow(/prompt rejected by moderation/);

  script = { 'POST /api/v3/contents/generations/tasks': { code: 1003, message: 'insufficient quota' } };
  await expect(
    generateOpenLuxVideo({ apiKey: 'lux', adapter: 'seedance', params: { model: 'doubao-seedance-2-0-260128', prompt: 'p' }, sleep: noWait })
  ).rejects.toThrow(/insufficient quota/);
});

test('the catalogue is fetched from the public endpoint and cached for an outage', async () => {
  const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openlux-')), 'openlux.cache.json');
  script = { 'GET /api/pricing_new': CATALOGUE };
  const live = await loadOpenLuxCatalogue({ cache });
  expect(live.images.length).toBe(3);
  expect(live.videos.length).toBe(3);
  script = {};
  const fallback = await loadOpenLuxCatalogue({ cache });
  expect(fallback).toEqual(live);
  fs.rmSync(path.dirname(cache), { recursive: true, force: true });
});

// ---------- through the gallery server ----------

test('an OpenLux video model runs on the OpenLux key and route, and says which key it lacks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openlux-gallery-'));
  const charRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openlux-cast-'));
  const keys = {};
  const { videos } = mapOpenLuxCatalogue(CATALOGUE);
  const server = createServer({
    root,
    apis: [
      { id: 'openrouter', name: 'OpenRouter', chatUrl: `${origin}/v1/chat/completions`, video: true, models: [] },
      { id: 'openlux', name: 'OpenLux', imagesUrl: `${origin}/v1/images/generations`, video: true, models: [] }
    ],
    videoModels: [{ id: 'google/veo-3.1', name: 'Veo 3.1', pricing: { perSecond: 0.4 } }, ...videos],
    resolveKey: (id) => keys[id] || '',
    defaultApi: 'openlux',
    charactersRoot: charRoot
  });
  const port = await listenOnFreePort(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const settle = async (ids) => (await (await fetch(`${base}/api/jobs?ids=${ids.join(',')}&wait=10`)).json()).results;
  try {
    const listed = await (await fetch(`${base}/api/models?kind=video&api=openlux`)).json();
    expect(listed.models.map((m) => m.id).sort()).toEqual(['doubao-seedance-2-0-260128', 'grok-imagine-video', 'veo_3_1']);
    expect(listed.models.find((m) => m.id === 'veo_3_1')).toMatchObject({ api: 'openlux', ready: false, pricing: { perClip: 0.05647 } });

    const missing = await post('/api/generate', { kind: 'video', prompt: 'a wave', model: 'veo_3_1', api: 'openlux' });
    const [failed] = await settle(missing.jobs);
    expect(failed.error).toMatch(/needs an OpenLux key/);

    keys.openlux = 'lux-key';
    seen.length = 0;
    script = {
      'POST /v1/videos': { id: 'video_s', status: 'queued' },
      'GET /v1/videos/video_s': { id: 'video_s', status: 'completed', video_url: `${origin}/v1/videos/video_s/content` },
      'GET /v1/videos/video_s/content': Buffer.from('clip')
    };
    const ok = await post('/api/generate', { kind: 'video', prompt: 'a wave', model: 'veo_3_1', duration: 8 });
    const [done] = await settle(ok.jobs);
    expect(done.status).toBe('done');
    expect(done.item).toMatchObject({ api: 'openlux', model: 'veo_3_1', kind: 'video' });
    expect(seen.find((s) => s.method === 'POST' && s.path === '/v1/videos').auth).toBe('Bearer lux-key');

    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.videoReady).toBe(true);
    expect(state.videoModels.find((m) => m.id === 'google/veo-3.1')).toMatchObject({ api: 'openrouter', hasKey: false });

    // A typed-in id on OpenLux has no adapter, so it is refused before it costs anything.
    const typed = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'video', prompt: 'p', model: 'kling-video', api: 'openlux' }) });
    expect(typed.status).toBe(400);
  } finally {
    server.jobs.closeAll();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(charRoot, { recursive: true, force: true });
  }
});
