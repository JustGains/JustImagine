import fs from 'node:fs';
import path from 'node:path';
import { BRO_DIR } from './config.js';
import { cleanDescription, imageTokensPerImage } from './model-info.js';
import { download, pollDelay, readApiResponse } from './justimagine-gen.js';

// OpenLux (openlux.ai) is a new-api relay — the same gateway software as Yunwu —
// so images are the familiar OpenAI shapes. Two things are OpenLux-specific:
//
//   pricing — a public, keyless catalogue at /api/pricing_new. Its numbers are
//             multipliers, not dollars: price = model_price × the key group's
//             ratio (× a per-model multiplier the website hard-codes for a few
//             video families). We quote the cheapest group a model is sold in,
//             which is what openlux.ai's own pricing page shows; a key in a
//             pricier group pays more, and the basis says so.
//   video   — no single route. Each family keeps its upstream's own API, so a
//             model is only offered here when we have an adapter for its route
//             (VIDEO_FAMILIES below). Kling, Wan, Vidu, Pixverse and friends
//             each need their own and are left out rather than half-working.

export const OPENLUX_ORIGIN = () => process.env.JUSTIMAGINE_OPENLUX_URL || 'https://api.openlux.ai';
export const OPENLUX_API_ID = 'openlux';
export const OPENLUX_CACHE = path.join(BRO_DIR, 'openlux.cache.json');

// Which catalogue endpoint types land on a route we can call for pictures.
const IMAGE_ROUTES = new Set(['/v1/images/generations', '/v1/images/edits']);
const CHAT_ROUTE = '/v1/chat/completions';

// Every video family we can drive, with the knobs its route documents. `price`
// turns a catalogue record and its group ratio into our pricing shape.
export const VIDEO_FAMILIES = [
  {
    // Veo 3.1 through the OpenAI video format: multipart, a single
    // input_reference, fixed 8-second clips, billed per clip.
    match: /^veo_3_1(-fast)?$/,
    adapter: 'openai-videos',
    spec: { durations: [8], aspectRatios: ['16:9', '9:16'], frames: ['first_frame'] },
    price: (m, g) => ({ perClip: m.model_price * g, clipSeconds: 8 })
  },
  {
    // The "components" variant is reference-to-video: the image steers, it is
    // not a frame.
    match: /^veo_3_1-components$/,
    adapter: 'openai-videos',
    spec: { durations: [8], aspectRatios: ['16:9', '9:16'], frames: null },
    price: (m, g) => ({ perClip: m.model_price * g, clipSeconds: 8 })
  },
  {
    match: /^grok-1\.5-video$/,
    adapter: 'openai-videos',
    spec: { durations: [6, 10], aspectRatios: ['16:9', '9:16'], frames: null },
    price: (m, g) => ({ perClip: m.model_price * g })
  },
  {
    // xAI's own JSON shape; openlux.ai bills it per second at 7× model_price.
    match: /^grok-imagine-video/,
    adapter: 'grok',
    spec: {
      durations: Array.from({ length: 15 }, (_, i) => i + 1),
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      frames: ['first_frame']
    },
    price: (m, g) => ({ perSecond: m.model_price * g * (m.model_ratio || 7) })
  },
  {
    // Volcengine Ark's task API. Priced per million video tokens, with a
    // per-variant multiplier from openlux.ai's pricing page; quoted per second
    // at 720p using ByteDance's token formula.
    match: /^doubao-seedance-2-/,
    adapter: 'seedance',
    spec: {
      durations: Array.from({ length: 12 }, (_, i) => i + 4),
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      frames: ['first_frame', 'last_frame'],
      audio: true,
      seed: true
    },
    price: (m, g) => ({ perSecond: ((m.model_price * g * seedanceMultiplier(m.model_name)) / 1e6) * SEEDANCE_TOKENS_720P, basis: '720p' })
  }
];

const SEEDANCE_TOKENS_720P = (1280 * 720 * 24) / 1024;
function seedanceMultiplier(id) {
  if (/-2-5/.test(id)) return 1070;
  if (/-fast/.test(id)) return 560;
  if (/-mini/.test(id)) return 350;
  return 700;
}

export const videoFamilyOf = (id) => VIDEO_FAMILIES.find((f) => f.match.test(String(id || ''))) || null;

// The cheapest ratio among the groups a model is sold in, and which group.
function cheapestGroup(model, ratios) {
  let best = null;
  for (const g of model.enable_groups || []) {
    const r = Number(ratios?.[g]);
    if (Number.isFinite(r) && r > 0 && (!best || r < best.ratio)) best = { name: g, ratio: r };
  }
  return best;
}

const round = (usd) => Math.round(usd * 1e5) / 1e5;
const routesOf = (m, endpoints) => (m.supported_endpoint_types || []).map((t) => endpoints?.[t]?.path).filter(Boolean);

function imagePricing(m, group) {
  const g = group.ratio;
  const basis = `cheapest key group (${group.name})`;
  // Per call: the picture has a fixed price.
  if (m.quota_type === 1 && m.model_price > 0) {
    return { perImage: round(m.model_price * g), basis, source: 'OpenLux list price' };
  }
  // Per token (the gpt-image family): new-api's $/M output = 2 × ratio ×
  // completion ratio × group, times a typical picture's token count.
  if (m.quota_type === 0 && m.model_ratio > 0 && m.completion_ratio > 0) {
    const imageOutput = round(2 * m.model_ratio * m.completion_ratio * g);
    return { perImage: round((imageOutput * imageTokensPerImage(m.model_name)) / 1e6), imageOutput, basis, source: 'OpenLux list price' };
  }
  return undefined;
}

// The public catalogue → { images, videos } in the gallery's model shape.
export function mapOpenLuxCatalogue(json) {
  const data = Array.isArray(json?.data) ? json.data : [];
  const ratios = json?.group_ratio || {};
  const endpoints = json?.supported_endpoint || {};
  const images = [];
  const videos = [];
  const newestFirst = [...data]
    .filter((m) => m?.model_name && m.available !== false)
    .sort((a, b) => (b.created_time || 0) - (a.created_time || 0) || String(a.model_name).localeCompare(String(b.model_name)));
  for (const m of newestFirst) {
    const group = cheapestGroup(m, ratios);
    const description = cleanDescription(m.description) || undefined;
    const created = m.created_time || undefined;
    const routes = routesOf(m, endpoints);
    if (m.model_type === '图像') {
      // An image model we can reach: the Images API first, chat as the fallback
      // (the Gemini / Nano Banana family). Midjourney, Kling and the rest use
      // task routes of their own and are skipped.
      const images_ = routes.some((r) => IMAGE_ROUTES.has(r));
      const chat = routes.includes(CHAT_ROUTE);
      if (!images_ && !chat) continue;
      images.push({
        id: m.model_name,
        name: m.model_name,
        via: images_ ? 'images' : 'chat',
        kind: 'image',
        created,
        description,
        pricing: group ? imagePricing(m, group) : undefined
      });
      continue;
    }
    const family = videoFamilyOf(m.model_name);
    if (!family) continue;
    const priced = group ? family.price(m, group.ratio) : null;
    const pricing = priced
      ? {
          ...Object.fromEntries(Object.entries(priced).map(([k, v]) => [k, typeof v === 'number' && k !== 'clipSeconds' ? round(v) : v])),
          basis: [priced.basis, `cheapest key group (${group.name})`].filter(Boolean).join(', '),
          source: 'OpenLux list price'
        }
      : undefined;
    videos.push({
      id: m.model_name,
      name: m.model_name,
      kind: 'video',
      api: OPENLUX_API_ID,
      adapter: family.adapter,
      created,
      description,
      pricing,
      resolutions: family.spec.resolutions || null,
      aspectRatios: family.spec.aspectRatios || null,
      sizes: null,
      durations: family.spec.durations || null,
      frames: family.spec.frames || null,
      audio: !!family.spec.audio,
      seed: !!family.spec.seed
    });
  }
  return { images, videos };
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Fresh each start, falling back to the last good copy so an outage never
// empties the menu. Resolves null when there has never been one.
export async function loadOpenLuxCatalogue({ cache = OPENLUX_CACHE } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${OPENLUX_ORIGIN()}/api/pricing_new`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', connection: 'close' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const mapped = mapOpenLuxCatalogue(await res.json());
    if (!mapped.images.length && !mapped.videos.length) throw new Error('no media models');
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(mapped, null, 2));
    return mapped;
  } catch {
    const cached = readJson(cache);
    return cached && Array.isArray(cached.images) && Array.isArray(cached.videos) ? cached : null;
  } finally {
    clearTimeout(timer);
  }
}

// Fold a loaded catalogue into the gallery: the live image models replace the
// OpenLux API's list (declared models it no longer names stay selectable, and a
// declared `via` still wins), and its video models join the video list.
// Returns the combined video list; `api.models` is updated in place.
export function mergeOpenLuxCatalogue(api, catalogue, videoModels = []) {
  if (!api || !catalogue) return videoModels;
  if (catalogue.images?.length) {
    const declared = new Map((api.models || []).map((m) => [m.id, m]));
    const live = new Set(catalogue.images.map((m) => m.id));
    api.models = [
      ...catalogue.images.map((m) => {
        const own = declared.get(m.id);
        return { ...own, ...m, via: own?.via || m.via };
      }),
      ...(api.models || []).filter((m) => !live.has(m.id))
    ];
  }
  return [...videoModels, ...(catalogue.videos || [])];
}

// ---------- video ----------

// A reference goes up as a URL; a local one travels inline as a data URL.
const urlOf = (ref) => ref?.url || ref?.dataUrl || '';
const set = (v) => v && v !== 'auto';

export function buildOpenLuxVideoRequest(adapter, { model, prompt, duration, resolution, aspectRatio, generateAudio, seed, firstFrame, lastFrame, refs = [], audioRefs = [] }) {
  const origin = OPENLUX_ORIGIN();
  if (adapter === 'openai-videos') {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    if (duration) form.append('seconds', String(duration));
    if (set(aspectRatio)) form.append('size', aspectRatio);
    const reference = firstFrame || refs[0];
    if (reference) form.append('input_reference', urlOf(reference));
    return { url: `${origin}/v1/videos`, form };
  }
  if (adapter === 'grok') {
    // All three are required on this route, so "auto" becomes the defaults.
    const body = {
      model,
      prompt,
      duration: Number(duration) || 6,
      resolution: set(resolution) ? resolution : '720p',
      aspect_ratio: set(aspectRatio) ? aspectRatio : '16:9'
    };
    if (firstFrame) body.image = { url: urlOf(firstFrame) };
    else if (refs.length) body.reference_images = refs.map((r) => ({ url: urlOf(r) }));
    return { url: `${origin}/v1/videos/generations`, body };
  }
  if (adapter === 'seedance') {
    const content = [{ type: 'text', text: prompt }];
    if (firstFrame) content.push({ type: 'image_url', image_url: { url: urlOf(firstFrame) }, role: 'first_frame' });
    if (lastFrame) content.push({ type: 'image_url', image_url: { url: urlOf(lastFrame) }, role: 'last_frame' });
    if (!firstFrame) for (const r of refs) content.push({ type: 'image_url', image_url: { url: urlOf(r) }, role: 'reference_image' });
    // A reference song for lip sync. Ark takes it inline, beside a first frame,
    // and keeps it as the clip's own sound.
    for (const a of audioRefs) content.push({ type: 'audio_url', audio_url: { url: urlOf(a) }, role: 'reference_audio' });
    const body = { model, content };
    if (duration) body.duration = Number(duration);
    if (set(resolution)) body.resolution = resolution;
    if (set(aspectRatio)) body.ratio = aspectRatio;
    if (typeof generateAudio === 'boolean') body.generate_audio = generateAudio;
    if (Number.isFinite(Number(seed)) && String(seed ?? '').trim() !== '') body.seed = Number(seed);
    return { url: `${origin}/api/v3/contents/generations/tasks`, body };
  }
  throw new Error(`OpenLux has no video route for "${model}".`);
}

export function pollUrlOf(adapter, id) {
  const origin = OPENLUX_ORIGIN();
  return adapter === 'seedance'
    ? `${origin}/api/v3/contents/generations/tasks/${encodeURIComponent(id)}`
    : `${origin}/v1/videos/${encodeURIComponent(id)}`;
}

// The relay answers in whichever envelope the upstream uses — bare, or wrapped
// as { code, message, data } — so every read looks in both.
const layers = (json) => [json, json?.data, json?.data?.data].filter((x) => x && typeof x === 'object');
const first = (json, pick) => layers(json).map(pick).find((v) => v != null && v !== '');

export function taskIdOf(json) {
  return first(json, (x) => x.task_id ?? x.id);
}

const DONE = new Set(['completed', 'succeeded', 'succeed', 'success', 'video_generation_completed']);
const FAILED = new Set(['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled', 'expired']);

export function taskState(json) {
  const status = String(first(json, (x) => x.status ?? x.task_status) || '').toLowerCase();
  return { status, done: DONE.has(status), failed: FAILED.has(status) };
}

export function videoUrlOf(json) {
  return first(json, (x) => x.video_url ?? x.content?.video_url ?? x.result_url ?? (typeof x.url === 'string' ? x.url : null));
}

function failureOf(json) {
  const msg = first(json, (x) => x.fail_reason ?? x.error?.message ?? (typeof x.error === 'string' ? x.error : null));
  return msg || (typeof json?.message === 'string' && json.message !== 'success' ? json.message : '');
}

// new-api reports some failures as HTTP 200 with a non-zero `code`.
function assertOk(json) {
  if (json && json.code != null && json.code !== 0 && json.code !== '0' && json.code !== 'success') {
    throw new Error(failureOf(json) || `OpenLux error ${json.code}`);
  }
  return json;
}

export async function generateOpenLuxVideo({
  apiKey,
  adapter,
  params,
  signal,
  onProgress = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxMs = 20 * 60 * 1000
}) {
  const auth = { authorization: `Bearer ${apiKey}` };
  const req = buildOpenLuxVideoRequest(adapter, params);
  onProgress({ phase: 'submitting' });
  const submitted = assertOk(
    await readApiResponse(
      await fetch(req.url, {
        method: 'POST',
        signal,
        headers: req.form ? auth : { ...auth, 'content-type': 'application/json' },
        body: req.form || JSON.stringify(req.body)
      })
    )
  );
  const id = taskIdOf(submitted);
  if (!id) throw new Error('OpenLux did not return a task id.');
  onProgress({ phase: 'queued', jobId: id });

  let job = submitted;
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const state = taskState(job);
    if (state.done) break;
    if (state.failed) throw new Error(failureOf(job) || `Video generation ${state.status}.`);
    if (Date.now() - started > maxMs) throw new Error('Video generation timed out.');
    await sleep(pollDelay(attempt));
    if (signal?.aborted) throw new Error('Cancelled.');
    job = assertOk(await readApiResponse(await fetch(pollUrlOf(adapter, id), { signal, headers: auth })));
    onProgress({ phase: 'generating', jobId: id, status: taskState(job).status || 'pending', attempt, elapsed: Date.now() - started });
  }

  // The OpenAI video format may finish without a URL and serve the bytes from
  // /content instead, which needs the key; a third-party CDN URL must not get it.
  let url = videoUrlOf(job);
  if (!url && adapter !== 'seedance') url = `${pollUrlOf(adapter, id)}/content`;
  if (!url) throw new Error('Completed task had no video URL.');
  onProgress({ phase: 'downloading', jobId: id });
  const ours = String(url).startsWith(OPENLUX_ORIGIN());
  const { buf, ext } = await download(String(url), signal, ours ? auth : {});
  return { buf, ext: ext === 'bin' ? 'mp4' : ext, cost: first(job, (x) => x.usage?.cost) ?? undefined, generationId: id };
}
