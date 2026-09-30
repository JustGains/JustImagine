import { afterAll, beforeAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { generateImage, usesChatApi } from './justimagine-gen.js';
import { imagesApiPricing, loadOpenRouterImagesApiModels, mergeImageCatalogues } from './models.js';

// OpenRouter serves GPT Image 2.x, Flux, Recraft and friends only through its
// Images API; sending one to chat completions is a 404. These pin the routing
// and the catalogue that tells the two apart.

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
let upstream;
let base;
const seen = [];

beforeAll(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    seen.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/chat/completions') {
      const { model } = JSON.parse(body);
      if (/gpt-image/.test(model)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: { message: `${model} is an image generation model and cannot be used with the chat completions API. Use /api/v1/images instead.` } }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG.toString('base64') } }] } }] }));
      return;
    }
    if (req.url === '/api/v1/images') {
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }], usage: { cost: 0.03 } }));
      return;
    }
    if (req.url === '/api/v1/images/models') {
      res.end(JSON.stringify({
        data: [
          { id: 'openai/gpt-image-2.5-sunburst', name: 'OpenAI: GPT Image 2.5 Sunburst', created: 300, architecture: { output_modalities: ['image'] } },
          { id: 'recraft/recraft-v4', name: 'Recraft V4', created: 200, architecture: { output_modalities: ['image'] } },
          { id: 'google/gemini-3-pro-image', name: 'Gemini 3 Pro Image', created: 100, architecture: { output_modalities: ['image', 'text'] } }
        ]
      }));
      return;
    }
    const prices = {
      '/api/v1/images/models/openai/gpt-image-2.5-sunburst/endpoints': [{ billable: 'output_image', unit: 'token', cost_usd: 0.00003 }],
      '/api/v1/images/models/recraft/recraft-v4/endpoints': [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }]
    };
    if (prices[req.url]) {
      res.end(JSON.stringify({ id: 'x', endpoints: [{ pricing: prices[req.url] }] }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: 'no route' } }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${upstream.address().port}`;
});

afterAll(async () => {
  upstream.closeAllConnections?.();
  await new Promise((r) => upstream.close(r));
});

const openrouter = (models = []) => ({
  id: 'openrouter',
  chatUrl: `${base}/api/v1/chat/completions`,
  unifiedImagesUrl: `${base}/api/v1/images`,
  models
});

test('a typed-in GPT Image id on OpenRouter goes to the Images API, a Gemini one to chat', () => {
  const api = openrouter();
  expect(usesChatApi(api, 'openai/gpt-image-2.5-sunburst')).toBe(false);
  expect(usesChatApi(api, 'black-forest-labs/flux.2-pro')).toBe(false);
  expect(usesChatApi(api, 'google/gemini-3.1-flash-image')).toBe(true);
  expect(usesChatApi(api, 'openai/gpt-5.4-image-2')).toBe(true);
  // What the catalogue says wins over the guess, either way.
  expect(usesChatApi(openrouter([{ id: 'openai/gpt-5-image', via: 'images' }]), 'openai/gpt-5-image')).toBe(false);
  expect(usesChatApi(openrouter([{ id: 'odd/model', via: 'chat' }]), 'odd/model')).toBe(true);
  // Non-OpenRouter APIs keep their old rules.
  expect(usesChatApi({ id: 'yunwu', imagesUrl: 'https://x/v1/images/generations', models: [] }, 'gpt-image-2')).toBe(false);
});

test('GPT Image 2.5 Sunburst on OpenRouter is generated through the Images API', async () => {
  seen.length = 0;
  const r = await generateImage({ api: openrouter(), apiKey: 'k', prompt: 'a bottle', model: 'openai/gpt-image-2.5-sunburst' });
  expect(r.buf.equals(PNG)).toBe(true);
  expect(r.cost).toBe(0.03);
  expect(seen.map((s) => s.path)).toEqual(['/api/v1/images']);
});

test('a model wrongly marked chat is retried once on the Images API when chat refuses it', async () => {
  seen.length = 0;
  const api = openrouter([{ id: 'openai/gpt-image-2.5-sunburst', via: 'chat' }]);
  const r = await generateImage({ api, apiKey: 'k', prompt: 'a bottle', model: 'openai/gpt-image-2.5-sunburst' });
  expect(r.buf.equals(PNG)).toBe(true);
  expect(seen.map((s) => s.path)).toEqual(['/api/v1/chat/completions', '/api/v1/images']);
});

test('Images API prices are read per image, per megapixel or per output token', () => {
  expect(imagesApiPricing([{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }])).toMatchObject({ perImage: 0.04 });
  expect(imagesApiPricing([{ billable: 'output_image', unit: 'megapixel', cost_usd: 0.03 }])).toMatchObject({ perImage: 0.03, basis: '1 megapixel (about 1024×1024)' });
  // $30/M output tokens × 1056 tokens for a medium 1024² GPT image.
  expect(imagesApiPricing([{ billable: 'input_text', unit: 'token', cost_usd: 0.000005 }, { billable: 'output_image', unit: 'token', cost_usd: 0.00003 }], 'openai/gpt-image-2.5-sunburst')).toMatchObject({ perImage: 0.03168, imageOutput: 30 });
  // The pricier variant is not the default price.
  expect(imagesApiPricing([{ billable: 'output_image', unit: 'image', cost_usd: 0.09, variant: 'high_resolution' }, { billable: 'output_image', unit: 'image', cost_usd: 0.045 }])).toMatchObject({ perImage: 0.045 });
  // Priced only by tier: the cheapest tier, named.
  expect(imagesApiPricing([{ billable: 'output_image', unit: 'image', cost_usd: 0.075, variant: '2k' }, { billable: 'output_image', unit: 'image', cost_usd: 0.04, variant: '1k' }])).toMatchObject({ perImage: 0.04, basis: 'the 1k tier' });
  expect(imagesApiPricing(null)).toBeUndefined();
  expect(imagesApiPricing([])).toBeUndefined();
});

test('the Images API catalogue loads with prices and merges without re-routing chat models', async () => {
  const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'or-images-')), 'cache.json');
  process.env.JUSTIMAGINE_IMAGES_MODELS_URL = `${base}/api/v1/images/models`;
  try {
    const models = await loadOpenRouterImagesApiModels({ cache });
    expect(models.map((m) => m.id)).toEqual(['openai/gpt-image-2.5-sunburst', 'recraft/recraft-v4', 'google/gemini-3-pro-image']);
    for (const m of models) expect(m.via).toBe('images');
    expect(models[0].pricing.perImage).toBe(0.03168);
    expect(models[1].pricing.perImage).toBe(0.04);

    const chat = [{ id: 'google/gemini-3-pro-image', via: 'chat', created: 100 }];
    const merged = mergeImageCatalogues(chat, models);
    expect(merged.map((m) => [m.id, m.via])).toEqual([
      ['openai/gpt-image-2.5-sunburst', 'images'],
      ['recraft/recraft-v4', 'images'],
      ['google/gemini-3-pro-image', 'chat']
    ]);
    // An outage keeps the last catalogue, prices included.
    process.env.JUSTIMAGINE_IMAGES_MODELS_URL = `${base}/gone`;
    expect(await loadOpenRouterImagesApiModels({ cache })).toEqual(models);
  } finally {
    delete process.env.JUSTIMAGINE_IMAGES_MODELS_URL;
    fs.rmSync(path.dirname(cache), { recursive: true, force: true });
  }
});
