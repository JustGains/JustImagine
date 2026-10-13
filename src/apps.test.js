import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { APPS, chooseImageAppModel, imageAppPrompt } from './apps-workflows.js';
import { hasFfmpeg, probeMedia, processAppMedia, restoreSceneAudio, silentSceneReference, vectorJsonToSvg } from './apps-processing.js';
import { buildVideoBody } from './justimagine-gen.js';
import { createServer, listenOnFreePort } from './justimagine-server.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('the catalog has a unique, usable route for every app', () => {
  expect(APPS).toHaveLength(15);
  expect(new Set(APPS.map((app) => app.id)).size).toBe(APPS.length);
  expect(APPS.every((app) => app.title && app.summary && app.engine && app.input)).toBe(true);
  expect(APPS.every((app) => app.icon && app.gradient?.length === 2 && app.gradient.every((stop) => /^#[0-9a-f]{6}$/i.test(stop)))).toBe(true);
});

test('the fictional remix demo is bundled and cacheable by version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-remix-demo-'));
  const server = createServer({ root, charactersRoot: path.join(root, 'characters'), auth: false, apis: [], videoModels: [] });
  const port = await listenOnFreePort(server, 0);
  try {
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/api/apps/scene-remix/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"clip":"fictional"}' });
    expect(response.status).toBe(200);
    const demo = await response.json();
    expect(demo.video).toContain('/assets/demo/fictional-studio.mp4?v=');
    expect(demo.faces.every((face) => face.includes('illustrated'))).toBe(true);
    const video = await fetch(`${base}${demo.video}`, { method: 'HEAD' });
    expect(video.status).toBe(200);
    expect(video.headers.get('cache-control')).toContain('immutable');
    for (const name of ['left-face-illustrated.png', 'right-face-illustrated.png', 'elon-musk.jpg', 'will-smith.jpg']) {
      const image = await fetch(`${base}/assets/demo/${name}`);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toContain(name.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
    }
  } finally {
    server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Video Remix shows Seedance 2.5 while blocking edits its OpenRouter route cannot accept', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-remix-models-'));
  const models = ['bytedance/seedance-2.0-mini', 'bytedance/seedance-2.0', 'bytedance/seedance-2.5']
    .map((id) => ({ id, name: id, durations: id.endsWith('2.5') ? Array.from({ length: 27 }, (_, i) => i + 4) : [4, 8, 15], resolutions: ['480p'] }));
  const server = createServer({ root, charactersRoot: path.join(root, 'characters'), auth: false,
    apis: [], videoModels: models, resolveKey: () => 'fixture-key' });
  const port = await listenOnFreePort(server, 0);
  const uploadIds = [];
  try {
    const catalog = await (await fetch(`http://127.0.0.1:${port}/api/apps`)).json();
    expect(catalog.sceneRemix.maxSeconds).toBe(15);
    expect(catalog.sceneRemix.models.map((model) => model.id)).toEqual([
      'bytedance/seedance-2.0-mini', 'bytedance/seedance-2.0', 'bytedance/seedance-2.5'
    ]);
    expect(catalog.sceneRemix.models.find((model) => model.id === 'bytedance/seedance-2.5').editReady).toBe(false);
    if (hasFfmpeg()) {
      const source = path.join(root, 'guide.mp4');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=24:d=20',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source], { windowsHide: true, timeout: 30_000 });
      const bytes = fs.readFileSync(source);
      const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const uploadId = (await (await post('/api/media', { name: 'guide.mp4', size: bytes.length, temporary: true })).json()).id;
      uploadIds.push(uploadId);
      expect((await fetch(`http://127.0.0.1:${port}/api/media/chunk?id=${uploadId}&offset=0`, { method: 'POST', body: bytes })).status).toBe(200);
      await post('/api/media/done', { id: uploadId });
      const tooLongForMini = await post('/api/apps/scene-remix', { source: uploadId, reviewed: true, model: 'bytedance/seedance-2.0-mini' });
      expect(tooLongForMini.status).toBe(400);
      expect((await tooLongForMini.json()).error).toContain('does not support that clip length');
      const blockedBy25 = await post('/api/apps/scene-remix', { source: uploadId, reviewed: true, model: 'bytedance/seedance-2.5' });
      expect(blockedBy25.status).toBe(400);
      expect((await blockedBy25.json()).error).toContain('unavailable through OpenRouter');
    }
  } finally {
    server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
    for (const uploadId of uploadIds) fs.rmSync(path.join(os.tmpdir(), 'justimagine-uploads', `${uploadId}.part`), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('image workflows turn the selected controls into bounded edit instructions', () => {
  expect(imageAppPrompt('change-age', { age: 65 })).toContain('about age 65');
  expect(imageAppPrompt('remove-object', { prompt: 'the blue chair' })).toContain('Remove the blue chair');
  expect(imageAppPrompt('expand-image', { ratio: '9:16' })).toContain('9:16');
  expect(() => imageAppPrompt('retouch-portrait', { changes: [] })).toThrow('Pick at least one');
  expect(() => imageAppPrompt('change-age', { age: 300 })).toThrow('5 to 90');
  const apis = [{ id: 'openrouter', models: [{ id: 'google/gemini-3.1-flash-image' }, { id: 'dall-e-3' }] }];
  expect(chooseImageAppModel(apis, () => true).model.id).toBe('google/gemini-3.1-flash-image');
  expect(() => chooseImageAppModel(apis, () => true, { api: 'openrouter', model: 'dall-e-3' })).toThrow('cannot edit');
});

test('vector output accepts shapes and escapes model-supplied markup', () => {
  const svg = vectorJsonToSvg({ title: 'A <fox>', shapes: [
    { type: 'circle', cx: 200, cy: 300, r: 100, fill: '#c17239' },
    { type: 'text', text: '<script>alert(1)</script>', x: 10, y: 800, fill: '#171717' },
    { type: 'path', d: 'M 0 0" onload="alert(1)', fill: '#171717' }
  ] });
  expect(svg).toContain('width="1024" height="1024"');
  expect(svg).toContain('&lt;script&gt;');
  expect(svg).not.toContain('<script>');
  expect(svg).not.toContain('onload=');
  expect(svg).not.toContain('A <fox>');
});

test('a temporary image upload runs a guided edit and saves only its result in the gallery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-app-test-'));
  const chars = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-app-chars-'));
  let upstreamPrompt = '';
  const upstream = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    upstreamPrompt = JSON.parse(Buffer.concat(parts).toString()).messages[0].content[0].text;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const server = createServer({
    root, charactersRoot: chars, auth: false,
    apis: [{ id: 'openrouter', name: 'OpenRouter', chatUrl: `http://127.0.0.1:${upstream.address().port}/chat`, models: [{ id: 'google/gemini-3.1-flash-image', via: 'chat' }] }],
    videoModels: [], defaultApi: 'openrouter', resolveKey: () => 'fixture-key'
  });
  const port = await listenOnFreePort(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const post = async (url, body) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    expect((await fetch(base + '/apps/change-age')).status).toBe(200);
    const appList = await (await fetch(base + '/api/apps')).json();
    expect(appList.apps).toHaveLength(15);
    const started = await post('/api/media', { name: 'portrait.png', size: PNG.length, temporary: true });
    const chunk = await fetch(`${base}/api/media/chunk?id=${started.data.id}&offset=0`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: PNG });
    expect(chunk.status).toBe(200);
    const done = await post('/api/media/done', { id: started.data.id });
    expect(done.data.input.type).toBe('image/png');
    expect((await (await fetch(base + '/api/items?deep=1')).json()).items).toHaveLength(0);
    const launched = await post('/api/apps/run', { app: 'change-age', input: done.data.input.id, values: { age: 65 } });
    expect(launched.status).toBe(200);
    const report = await (await fetch(`${base}/api/jobs?ids=${launched.data.jobs[0]}&wait=5`)).json();
    expect(report.results[0].status).toBe('done');
    expect(report.items[0].prompt).toBe('Change Age · age 65');
    expect(upstreamPrompt).toContain('about age 65');
    expect((await (await fetch(base + '/api/items?folder=Apps%2FChange%20Age')).json()).items).toHaveLength(1);
    const media = await fetch(`${base}/media/${report.items[0].file}?f=Apps%2FChange%20Age`);
    expect(media.status).toBe(200);
  } finally {
    server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
    upstream.closeAllConnections?.(); await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(chars, { recursive: true, force: true });
  }
});

test('local upscaling changes pixel size without changing the source file', async () => {
  if (!hasFfmpeg()) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-app-process-'));
  const source = path.join(import.meta.dir, '..', 'screenshots', 'cast.png');
  const output = path.join(root, 'upscaled.png');
  try {
    const original = await probeMedia(source);
    await processAppMedia({ app: 'upscaler', input: source, output, values: { factor: 2, detail: 'crisp' } });
    const result = await probeMedia(output);
    expect(result.streams[0].width).toBe(original.streams[0].width * 2);
    expect(result.streams[0].height).toBe(original.streams[0].height * 2);
    expect(fs.existsSync(source)).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('video trim and audio cleanup produce playable clips with the requested span', async () => {
  if (!hasFfmpeg()) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-app-video-'));
  const source = path.join(root, 'source.mp4');
  const trimmed = path.join(root, 'trimmed.mp4');
  const cleaned = path.join(root, 'cleaned.mp4');
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-shortest', source], { windowsHide: true, timeout: 30_000 });
    await processAppMedia({ app: 'video-trim', input: source, output: trimmed, values: { start: 0.5, end: 1.5 } });
    const trimInfo = await probeMedia(trimmed);
    expect(Number(trimInfo.format.duration)).toBeGreaterThan(0.9);
    expect(Number(trimInfo.format.duration)).toBeLessThan(1.2);
    expect(trimInfo.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
    await processAppMedia({ app: 'ugc-audio-fixer', input: source, output: cleaned, values: { preset: 'speech' } });
    const cleanInfo = await probeMedia(cleaned);
    expect(Number(cleanInfo.format.duration)).toBeGreaterThan(2.9);
    expect(cleanInfo.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('video references and character images are sent together to the video model', () => {
  const body = buildVideoBody({
    model: 'bytedance/seedance-2.5', prompt: 'Replace both people', duration: 8, resolution: '480p',
    videoRefs: [{ url: 'https://example.com/guide.mp4' }],
    refs: [{ url: 'https://example.com/left.png' }, { url: 'https://example.com/right.png' }]
  });
  expect(body.frame_images).toBeUndefined();
  expect(body.input_references.map((ref) => ref.type)).toEqual(['video_url', 'image_url', 'image_url']);
  expect(body.input_references[0].video_url.url).toBe('https://example.com/guide.mp4');
  expect(body.input_references[1].image_url.url).toBe('https://example.com/left.png');
  expect(body.input_references[2].image_url.url).toBe('https://example.com/right.png');
});

test('Video Remix offers OpenLux Seedance 2.5 when only its key is connected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-remix-openlux-'));
  const server = createServer({ root, charactersRoot: path.join(root, 'characters'), auth: false,
    apis: [{ id: 'openlux', name: 'OpenLux', video: true, models: [] }],
    videoModels: [{ id: 'doubao-seedance-2-5-260628', api: 'openlux', adapter: 'seedance',
      durations: Array.from({ length: 27 }, (_, i) => i + 4), resolutions: ['480p', '720p', '1080p'] }],
    resolveKey: (id) => id === 'openlux' ? 'fixture-key' : '' });
  const port = await listenOnFreePort(server, 0);
  try {
    const { sceneRemix } = await (await fetch(`http://127.0.0.1:${port}/api/apps`)).json();
    expect(sceneRemix.ready).toBe(hasFfmpeg());
    expect(sceneRemix.maxSeconds).toBe(30);
    expect(sceneRemix.models).toMatchObject([{ id: 'doubao-seedance-2-5-260628', api: 'openlux', editReady: true, draftFinishReady: false }]);
    const unsupported = await fetch(`http://127.0.0.1:${port}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'video', prompt: 'Finish draft', model: 'doubao-seedance-2-5-260628', api: 'openlux', draftTaskId: 'task_demo' }) });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error).toContain('cannot finish');
  } finally {
    server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scene export restores the exact original audio stream', async () => {
  if (!hasFfmpeg()) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-remix-audio-'));
  const source = path.join(root, 'source.mp4'), generated = path.join(root, 'generated.mp4'), output = path.join(root, 'output.mp4');
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=64x64:r=24:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source], { windowsHide: true, timeout: 30_000 });
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24:d=3',
      '-an', '-c:v', 'libx264', generated], { windowsHide: true, timeout: 30_000 });
    await restoreSceneAudio({ generated, source, output });
    const aac = (file) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'adts', '-'], { windowsHide: true, timeout: 30_000 });
    expect(aac(output).equals(aac(source))).toBe(true);
    const info = await probeMedia(output);
    expect(info.streams.some((stream) => stream.codec_type === 'video')).toBe(true);
    expect(Number(info.format.duration)).toBeGreaterThan(2.9);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the model reference is silent while the local guide keeps its audio', async () => {
  if (!hasFfmpeg()) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-remix-silent-'));
  const source = path.join(root, 'guide.mp4'), silent = path.join(root, 'reference.mp4');
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=24:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source], { windowsHide: true, timeout: 30_000 });
    await silentSceneReference({ source, output: silent });
    const original = await probeMedia(source), reference = await probeMedia(silent);
    expect(original.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
    expect(reference.streams.map((stream) => stream.codec_type)).toEqual(['video']);
    expect(Math.abs(Number(original.format.duration) - Number(reference.format.duration))).toBeLessThan(0.1);
    const h264 = (file) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'h264', '-'], { windowsHide: true, timeout: 30_000 });
    expect(h264(silent).equals(h264(source))).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the share route gives the relay a silent video and keeps the soundtrack for export', async () => {
  if (!hasFfmpeg()) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-remix-share-'));
  const source = path.join(root, 'guide.mp4'), downloaded = path.join(root, 'downloaded.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=24:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source], { windowsHide: true, timeout: 30_000 });
  let relayHadAudio = true;
  const server = createServer({ root, charactersRoot: path.join(root, 'characters'), auth: false, apis: [], videoModels: [],
    resolveKey: () => '', videoRelay: async (file) => { relayHadAudio = (await probeMedia(file)).streams.some((stream) => stream.codec_type === 'audio'); return 'https://example.com/silent.mp4'; } });
  const port = await listenOnFreePort(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body) => (await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  let uploadId = '';
  try {
    const bytes = fs.readFileSync(source);
    const upload = await post('/api/media', { name: 'guide.mp4', size: bytes.length, temporary: true });
    uploadId = upload.id;
    expect((await fetch(`${base}/api/media/chunk?id=${upload.id}&offset=0`, { method: 'POST', body: bytes })).status).toBe(200);
    await post('/api/media/done', { id: upload.id });
    const shared = await post('/api/apps/scene-remix/share', { source: upload.id });
    expect(shared.url).toBe('https://example.com/silent.mp4');
    expect(relayHadAudio).toBe(false);
    const response = await fetch(`${base}/api/apps/scene-remix/reference?source=${upload.id}`);
    expect(response.status).toBe(200);
    fs.writeFileSync(downloaded, Buffer.from(await response.arrayBuffer()));
    expect((await probeMedia(downloaded)).streams.map((stream) => stream.codec_type)).toEqual(['video']);
  } finally {
    server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
    if (uploadId) {
      fs.rmSync(path.join(os.tmpdir(), 'justimagine-uploads', `${uploadId}.part`), { force: true });
      fs.rmSync(path.join(os.tmpdir(), 'justimagine-uploads', `${uploadId}.silent.mp4`), { force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
