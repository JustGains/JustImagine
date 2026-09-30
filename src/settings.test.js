import { afterAll, beforeAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { applyLastSettings, cleanSettings, createServer, listenOnFreePort, readSettings, SETTINGS_FILE } from './justimagine-server.js';
import { listFolders, listItems } from './justimagine-store.js';

// The composer's last choices live beside the gallery, not only in a browser,
// so another browser — and a script sending `reuse: true` — gets the same ones.

test('only known keys of the right type are kept', () => {
  expect(
    cleanSettings({
      mode: 'video', api: 'openlux', imageModels: { openlux: 'gpt-image-2-c', bad: 7 }, duration: 8, audio: 'yes',
      theme: 'purple', count: '3', cast: ['nora'], evil: '<script>', open: 'not-a-list'
    })
  ).toEqual({ mode: 'video', api: 'openlux', imageModels: { openlux: 'gpt-image-2-c' }, duration: '8', count: 3, cast: ['nora'] });
  expect(cleanSettings(null)).toEqual({});
  expect(cleanSettings([1, 2])).toEqual({});
});

test('reuse fills only what the request leaves out, and says what it borrowed', () => {
  const last = {
    mode: 'image', api: 'openrouter', imageModel: 'openai/gpt-image-2.5-sunburst', imageModels: { openrouter: 'openai/gpt-image-2.5-sunburst', openlux: 'gpt-image-2-c' },
    size: '1024x1536', quality: 'high', folder: 'Campaign', videoModel: 'veo_3_1', videoApi: 'openlux', duration: '8', resolution: 'auto', aspect: '9:16', audio: true
  };
  expect(applyLastSettings({ prompt: 'p' }, last)).toEqual({
    spec: { prompt: 'p', kind: 'image', api: 'openrouter', model: 'openai/gpt-image-2.5-sunburst', size: '1024x1536', quality: 'high', folder: 'Campaign' },
    reused: { kind: 'image', api: 'openrouter', model: 'openai/gpt-image-2.5-sunburst', size: '1024x1536', quality: 'high', folder: 'Campaign' }
  });
  // Naming a provider brings back the model last used *there*.
  expect(applyLastSettings({ prompt: 'p', api: 'openlux' }, last).spec.model).toBe('gpt-image-2-c');
  // ...and a provider never used leaves the model to the server's default.
  expect(applyLastSettings({ prompt: 'p', api: 'openai' }, last).spec.model).toBeUndefined();
  // Stated values win; "auto" is not a choice worth copying.
  const video = applyLastSettings({ prompt: 'p', kind: 'video', duration: 4 }, last);
  expect(video.spec).toMatchObject({ kind: 'video', api: 'openlux', model: 'veo_3_1', duration: 4, aspectRatio: '9:16', audio: true });
  expect(video.spec.resolution).toBeUndefined();
  expect(video.reused.duration).toBeUndefined();
  // A video model named outright does not inherit last time's provider.
  expect(applyLastSettings({ prompt: 'p', kind: 'video', model: 'google/veo-3.1' }, last).spec.api).toBeUndefined();
});

// ---------- through the server ----------

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
let upstream;
let upstreamBase;
const asked = [];
let root;
let charRoot;
let server;
let base;

beforeAll(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    asked.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-gallery-'));
  charRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-cast-'));
  server = createServer({
    root,
    apis: [
      { id: 'alpha', name: 'Alpha', imagesUrl: `${upstreamBase}/alpha/v1/images/generations`, models: [{ id: 'a-1' }, { id: 'a-2' }] },
      { id: 'beta', name: 'Beta', imagesUrl: `${upstreamBase}/beta/v1/images/generations`, models: [{ id: 'b-1' }] }
    ],
    videoModels: [],
    resolveKey: () => 'k',
    defaultApi: 'alpha',
    charactersRoot: charRoot
  });
  base = `http://127.0.0.1:${await listenOnFreePort(server, 0)}`;
});

afterAll(async () => {
  server.jobs.closeAll();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  upstream.closeAllConnections?.();
  await new Promise((r) => upstream.close(r));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(charRoot, { recursive: true, force: true });
});

const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const getJson = async (p) => (await fetch(base + p)).json();
const settle = async (ids) => (await getJson(`/api/jobs?ids=${ids.join(',')}&wait=10`)).results;

test('the composer saves its choices on the server, and the page boots from them', async () => {
  const saved = await post('/api/settings', { api: 'beta', imageModel: 'b-1', size: '1024x1024', folder: 'Shots', junk: 1 });
  expect(saved.body.settings).toEqual({ api: 'beta', imageModel: 'b-1', size: '1024x1024', folder: 'Shots' });
  // Patches merge rather than replace.
  await post('/api/settings', { quality: 'high' });
  expect((await getJson('/api/settings')).settings).toMatchObject({ api: 'beta', quality: 'high' });
  expect((await getJson('/api/state')).settings).toMatchObject({ api: 'beta', imageModel: 'b-1' });
  // The file is a reserved dotfile: never a folder, never a gallery item.
  expect(fs.existsSync(path.join(root, SETTINGS_FILE))).toBe(true);
  expect(listFolders(root).children.map((f) => f.name)).not.toContain(SETTINGS_FILE);
  expect(listItems(root, '').map((i) => i.file)).not.toContain(SETTINGS_FILE);
});

test('a generation over the API becomes the last choice, per provider', async () => {
  const { body } = await post('/api/generate', { kind: 'image', api: 'alpha', model: 'a-2', prompt: 'a cat', size: '512x512' });
  await settle(body.jobs);
  const s = readSettings(root);
  expect(s).toMatchObject({ mode: 'image', api: 'alpha', imageModel: 'a-2', size: '512x512', imageModels: { alpha: 'a-2' } });
  // The composer's folder is not moved by a script's generation.
  expect(s.folder).toBe('Shots');
});

test('reuse: true repeats the last choices and reports them', async () => {
  asked.length = 0;
  const { status, body } = await post('/api/generate', { reuse: true, prompt: 'a dog' });
  expect(status).toBe(200);
  expect(body.reused).toMatchObject({ kind: 'image', api: 'alpha', model: 'a-2', size: '512x512', folder: 'Shots' });
  expect(body.folder).toBe('Shots');
  await settle(body.jobs);
  expect(asked[0].path).toBe('/alpha/v1/images/generations');
  expect(asked[0].body).toMatchObject({ model: 'a-2', prompt: 'a dog', size: '512x512' });
});

test('reuse works as a batch default, and without it nothing is borrowed', async () => {
  asked.length = 0;
  const { body } = await post('/api/batch', { defaults: { reuse: true, api: 'beta' }, items: ['one', 'two'] });
  await settle(body.jobs);
  expect(asked.map((a) => [a.path, a.body.model])).toEqual([
    ['/beta/v1/images/generations', 'b-1'],
    ['/beta/v1/images/generations', 'b-1']
  ]);
  const plain = await post('/api/generate', { prompt: 'plain' });
  expect(plain.body.reused).toBeUndefined();
  expect(plain.body.folder).toBe('');
  await settle(plain.body.jobs);
});
