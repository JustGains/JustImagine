import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AUDIO_ENHANCE_KINDS, ENHANCE_MODEL, enhancePrompt, generateImage, generateVideo, transcribeWords, VIDEO_KEY_API, writeStoryboard } from './justimagine-gen.js';
import { musicVideoSpec, buildMusicVideoPrompt } from './music-video.js';
import { isLipSyncModel, sniffMedia, uploadMeta } from './music-video-plan.js';
export { sniffMedia } from './music-video-plan.js';
import {
  AUDIO_APIS,
  DEFAULT_VOICE_FORMAT,
  DEFAULT_VOICE_MODEL,
  DIALOGUE_MODEL,
  ELEVENLABS_API_ID,
  SONG_MODELS,
  VOICE_FORMATS,
  VOICE_MODELS,
  audioDuration,
  buildSongPrompt,
  envKeyOf,
  cloneVoice,
  designVoice,
  generateSong,
  listVoiceModels,
  listVoices,
  parseScript,
  plainRead,
  saveDesignedVoice,
  textToDialogue,
  textToSpeech,
  voiceSettings
} from './justimagine-audio.js';
import { generateOpenLuxVideo } from './openlux.js';
import { authCookie } from './auth.js';
import {
  arenaIndex,
  arenaQuality,
  catalogueIndex,
  enrichMediaFacts,
  mediaModelDetail,
  mediaModelFacts,
  MODEL_SORTS,
  sortMediaModels
} from './model-info.js';
import { readMediaStats, refreshMediaStats } from './models.js';
import {
  CHARACTERS_DIR,
  addCandidate,
  addRefFromDataUrl,
  characterDir,
  characterShots,
  clearCandidates,
  composePrompt,
  createCharacter,
  deleteCharacter,
  deleteRef,
  ensureLibrary,
  exportCast,
  importCast,
  getCharacter,
  keepCandidates,
  listCharacters,
  resolveCandidate,
  resolveCharacters,
  updateCharacter
} from './justimagine-characters.js';
import {
  contextDir,
  deleteContext,
  deleteFolder,
  deleteItem,
  createFolder,
  ensureRoot,
  listContext,
  listFolders,
  listItems,
  listItemsDeep,
  kindOf,
  modelTimings,
  mediaTypeOf,
  moveItems,
  renameFolder,
  resolveFile,
  resolveFolder,
  resolveRefs,
  tooSmallRefs,
  appendHistory,
  saveContext,
  saveAudioRef,
  resolveAudioRef,
  isAudioDataUrl,
  EXT_BY_TYPE,
  saveThumb,
  thumbPath
} from './justimagine-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UI_HTML = path.join(__dirname, 'justimagine.html');
export const ASSETS_DIR = path.join(__dirname, 'assets');
// Modules the studio page loads, shared with the hosted studio, which serves
// them at the same paths.
export const PAGE_MODULES = {
  '/assets/music-video.js': 'music-video.js',
  '/assets/music-video-plan.js': 'music-video-plan.js',
  '/assets/music-video-maker.js': 'music-video-maker.js',
  '/assets/vendor/mediabunny.js': 'vendor/mediabunny.js'
};

// How many upstream calls may be in flight at once, per kind; the rest wait in
// this server's own queue. A generation spends almost all of its time waiting
// on the provider, so a low cap mostly adds queueing: at 8, a busy gallery's
// images waited ~40s here for ~20s of actual generation. Video stays lower —
// each one is a metered, minutes-long job. Songs and voice lines sit between:
// a song is a minute or two of one upstream call, and ElevenLabs caps how many
// requests an account may have open at once. `limits` in the config overrides
// all four, within LIMIT_MAX.
export const LIMITS = { image: 32, video: 12, song: 8, voice: 6 };
export const LIMIT_MAX = { image: 128, video: 48, song: 32, voice: 32 };
// Copies per spec, per kind. A song or a voice line is judged by listening, and
// four takes of one is plenty to choose between.
export const COUNT_MAX = { image: 12, video: 4, song: 4, voice: 4 };
export const MEDIA_KINDS = Object.keys(LIMITS);

// A configured cap, made safe: whole numbers from 1 to the ceiling, anything
// missing or nonsensical falling back to the default.
export function resolveLimits(given = {}) {
  const out = {};
  for (const kind of Object.keys(LIMITS)) {
    const n = Math.floor(Number(given?.[kind]));
    out[kind] = Number.isFinite(n) && n >= 1 ? Math.min(n, LIMIT_MAX[kind]) : LIMITS[kind];
  }
  return out;
}

// How long a finished job stays readable, and how many are kept. The browser
// only needs the last few seconds — it is watching the event stream — but a
// script that submits fifty generations and polls for them must be able to
// collect every result, including ones that landed while it was asleep.
export const JOB_RETAIN_MS = 30 * 60 * 1000;
export const JOB_RETAIN_MAX = 500;

// One `POST /api/batch` may not become an unbounded queue: a typo in a loop
// should cost a rejection, not a hundred paid generations.
export const BATCH_MAX_ITEMS = 50;
export const BATCH_MAX_JOBS = 100;
// Longest a long-poll may hold a request open. Beyond this the caller gets what
// has finished so far and polls again, which survives proxies and Ctrl-C alike.
export const WAIT_MAX_SEC = 600;

export const isTerminal = (job) => job.status === 'done' || job.status === 'error' || job.status === 'cancelled';

// Nano Banana 2 — the strongest reference-driven image model on OpenRouter, and
// the reason a generated cast holds its likeness across angles.
export const CHARACTER_REF_MODEL = 'google/gemini-3.1-flash-image';
// How many of a reference set to have in flight at once. One job fans out
// rather than queueing five, so this is its own small gate.
const REF_FANOUT = 3;

// Run `work` over `items`, at most `limit` at a time, keeping the results in
// order and never rejecting — a failed shot is a gap in the set, not a dead job.
export async function mapLimit(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        out[i] = { ok: true, value: await work(items[i], i) };
      } catch (e) {
        out[i] = { ok: false, error: e?.message || String(e) };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

// Upstreams reject an undersized reference with a message about pixels that
// says nothing about *which* picture is at fault. Name it, and say how to fix
// it — re-adding runs the file back through the browser's resize, which now
// scales small images up as well as large ones down.
export function explainRefFailure(message, refs) {
  const text = String(message || '');
  if (!/\b(\d+)\s*px|width|height|dimension|resolution|too small/i.test(text)) return text;
  const small = tooSmallRefs(refs);
  if (!small.length) return text;
  const named = small.map((s) => `${s.file} (${s.width}×${s.height})`).join(', ');
  return `${text}\n\nToo small to use as a reference: ${named}. Remove it and add it again. It will be scaled up on the way in.`;
}

// Which references become frames, and which stay subject/style guidance.
//
// Attachment order is the interface: the first reference opens the clip, the
// second can close it — but only for a model that accepts those, and only when
// the user left frame conditioning on.
//
// `characterRefs` are the pictures of who is in the shot; `refs` are what the
// user attached by hand for this one generation. Only hand-attached references
// ever become frames — pinning a character portrait as frame one would force
// every clip to open on that exact photo. Character references go to
// input_references instead, which is the slot meant for "who/what this is".
// Upstream ignores input_references the moment a frame is present, so the two
// are kept mutually exclusive here rather than silently dropped there.
// ---------- last settings ----------

// What the composer was last set to, kept beside the gallery rather than only
// in one browser's storage, so a second browser — or a script asking to
// `reuse` them — picks up the same choices. In the hosted suite every account
// has its own gallery root, so this is per account too.
export const SETTINGS_FILE = '.settings.json';

const text = (max = 300) => (v) => (typeof v === 'string' && v.length <= max ? v : undefined);
const num = (v) => (v !== '' && v !== null && typeof v !== 'boolean' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const strings = (v) => (Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && x.length <= 300) ? v : undefined);
const choice = (...allowed) => (v) => (allowed.includes(v) ? v : undefined);
// The last model per image API, so switching provider and back returns you to
// the model you were using there.
const modelMap = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = {};
  for (const [k, id] of Object.entries(v).slice(0, 50)) if (typeof id === 'string' && id.length <= 300 && k.length <= 100) out[k] = id;
  return out;
};

// Every key the gallery keeps, with how to validate it. Anything else sent is
// dropped rather than stored.
const SETTING_KEYS = {
  // generation choices
  mode: choice('image', 'video', 'music-video', 'song', 'voice'),
  api: text(100),
  imageModel: text(),
  imageModels: modelMap,
  videoModel: text(),
  musicVideoModel: text(),
  musicStyle: text(),
  videoApi: text(100),
  size: text(40),
  quality: text(40),
  duration: text(20),
  resolution: text(40),
  aspect: text(40),
  audio: bool,
  // songs
  songModel: text(),
  instrumental: bool,
  vocals: text(200),
  bpm: num,
  length: choice('auto', 'short', 'medium', 'full'),
  // voice
  voiceModel: text(),
  voiceId: text(100),
  voiceName: text(100),
  // the voice is a cast member's, spoken as them
  voiceCast: text(100),
  stability: num,
  similarity: num,
  style: num,
  speed: num,
  language: text(20),
  format: text(40),
  count: num,
  folder: text(1000),
  cast: strings,
  // layout
  lyricsOpen: bool,
  tile: num,
  lib: bool,
  open: strings,
  sidePinned: bool,
  side: text(40),
  theme: choice('dark', 'light')
};

export function cleanSettings(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const [key, check] of Object.entries(SETTING_KEYS)) {
    if (!(key in patch)) continue;
    // The duration menu's values are strings; a script may send a number.
    const raw = key === 'duration' && typeof patch[key] === 'number' ? String(patch[key]) : patch[key];
    const v = check(raw);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export function readSettings(root) {
  try {
    return cleanSettings(JSON.parse(fs.readFileSync(path.join(root, SETTINGS_FILE), 'utf8')));
  } catch {
    return {};
  }
}

// Merge and write atomically: a crash mid-write must not leave half a file.
export function writeSettings(root, patch) {
  const next = { ...readSettings(root), ...cleanSettings(patch) };
  const file = path.join(root, SETTINGS_FILE);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

// A spec asking to `reuse` the last settings: every choice it leaves out is
// filled from them — kind, provider, model, that kind's knobs, and the folder.
// Never the prompt, the count or the cast: those describe this request.
// Returns the filled spec and exactly what was borrowed, so a caller can see it.
export function applyLastSettings(spec = {}, settings = {}) {
  const out = { ...spec };
  const reused = {};
  const fill = (key, value) => {
    if (out[key] !== undefined && out[key] !== null && out[key] !== '') return;
    if (value === undefined || value === null || value === '' || value === 'auto') return;
    out[key] = value;
    reused[key] = value;
  };
  fill('kind', settings.mode);
  if (out.kind === 'song') {
    fill('model', settings.songModel);
    fill('instrumental', settings.instrumental);
    fill('vocals', settings.vocals);
    fill('bpm', settings.bpm);
    fill('length', settings.length);
  } else if (out.kind === 'voice') {
    fill('model', settings.voiceModel);
    fill('voice', settings.voiceId);
    fill('stability', settings.stability);
    fill('similarity', settings.similarity);
    fill('style', settings.style);
    fill('speed', settings.speed);
    fill('language', settings.language);
    fill('format', settings.format);
  } else if (out.kind === 'video') {
    // The provider follows the model: a model named here may belong to a
    // different provider than last time's.
    if (!out.model) fill('api', settings.videoApi);
    fill('model', settings.videoModel);
    fill('duration', num(settings.duration));
    fill('resolution', settings.resolution);
    fill('aspectRatio', settings.aspect);
    fill('audio', settings.audio);
  } else {
    fill('api', settings.api);
    // The model last used on *that* API, when the caller named another one.
    fill('model', settings.imageModels?.[out.api] || (out.api === settings.api ? settings.imageModel : undefined));
    fill('size', settings.size);
    fill('quality', settings.quality);
  }
  fill('folder', settings.folder);
  return { spec: out, reused };
}

export function frameSelection({ refs = [], characterRefs = [], spec, firstFrame = true, lastFrame = false }) {
  const takes = (which) => !!spec?.frames?.includes(which);
  const first = firstFrame && refs[0] && takes('first_frame') ? refs[0] : null;
  const last = first && lastFrame && refs[1] && takes('last_frame') ? refs[1] : null;
  return {
    firstFrame: first,
    lastFrame: last,
    refs: first ? [] : [...refs, ...characterRefs],
    // Told to the caller so the UI can say why the cast was left out, instead
    // of the user wondering where their character went.
    droppedCharacters: !!(first && characterRefs.length)
  };
}

// ---------- naming ----------

function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'gen'
  );
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const outputName = (prompt, ext) => `${stamp()}-${slug(prompt)}-${crypto.randomBytes(2).toString('hex')}.${ext}`;

// ---------- http plumbing ----------

function readBody(req, max = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const readJsonBody = async (req, max) => JSON.parse((await readBody(req, max)) || '{}');

// The bytes as sent, for uploads.
function readRawBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('That piece is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// A public home for a piece of song, so OpenRouter can fetch it for lip sync
// (it only takes https links). Off unless JUSTIMAGINE_AUDIO_RELAY names an
// endpoint that takes the bytes and answers { url }; the hosted studio runs
// one. OpenLux takes the piece inline and needs none of this.
export function audioRelayFromEnv(env = process.env) {
  const endpoint = env.JUSTIMAGINE_AUDIO_RELAY;
  if (!endpoint) return null;
  return async (ref, signal) => {
    const res = await fetch(endpoint, { method: 'POST', signal, headers: { 'content-type': ref.type }, body: ref.buf });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !/^https:\/\//.test(json.url || '')) throw new Error(json.error || 'The audio relay did not return a link.');
    return json.url;
  };
}


// Enough of a key to tell which one is saved, and never enough to use. Short
// strings give up nothing at all rather than most of themselves.
export function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length < 12) return '•'.repeat(8);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// This server listens on the loopback interface, but any page in the browser can
// still POST to 127.0.0.1. A write must therefore come from this gallery's own
// origin: browsers set `Origin` on cross-origin writes and `Sec-Fetch-Site` on
// every modern request, and neither can be forged by page script. A same-origin
// fetch from our own HTML sends `Origin: http://127.0.0.1:<port>`; a form post
// from evil.example.com sends its own origin and is refused.
export function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  // No Origin at all is a non-browser client (curl, a script) — the loopback
  // bind is the only guard there, and it is the one the CLI itself relies on.
  if (!origin) return true;
  return origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// Generated files never change under their name, so they can be cached hard.
// Range support is what lets a <video> seek instead of refetching the clip.
function sendFile(req, res, full, type, { immutable = true } = {}) {
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const headers = {
    'content-type': type || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'last-modified': stat.mtime.toUTCString(),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && stat.size) {
    let start = range[1] === '' ? null : Number(range[1]);
    let end = range[2] === '' ? null : Number(range[2]);
    if (start === null) {
      // "bytes=-500" — the last N bytes.
      start = Math.max(0, stat.size - (end ?? 0));
      end = stat.size - 1;
    } else if (end === null || end >= stat.size) {
      end = stat.size - 1;
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    sendBody(res, full, { start, end });
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  sendBody(res, full, { end: stat.size - 1 });
}

// Thumbnails, posters and character references are all small; reading one and
// writing it in a single call is both faster than a stream and free of the
// keep-alive race a piped response can lose on Windows, where the next request
// arrives while the pipe is still finishing and the socket resets. Anything
// large enough to be worth streaming (video) goes through pipeline(), which —
// unlike pipe() — sequences the end and destroys the response on a read error
// instead of leaving a half-written body behind.
const SMALL_FILE = 512 * 1024;

function sendBody(res, full, { start = 0, end }) {
  if (end - start + 1 <= SMALL_FILE) {
    let buf;
    try {
      buf = readRange(full, start, end);
    } catch {
      res.destroy();
      return;
    }
    res.end(buf);
    return;
  }
  pipeline(fs.createReadStream(full, { start, end }), res, () => {
    /* the client went away, or the file vanished mid-read */
  });
}

function readRange(full, start, end) {
  const fd = fs.openSync(full, 'r');
  try {
    const buf = Buffer.allocUnsafe(end - start + 1);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (!n) break;
      read += n;
    }
    return read === buf.length ? buf : buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- job registry ----------

// Generations outlive the request that started them: the browser posts a job
// and then watches an event stream. That is what lets a five-minute video
// survive a page reload, and what keeps the UI from holding open sockets.
export function createJobs({ limits = LIMITS, retainMs = JOB_RETAIN_MS, retainMax = JOB_RETAIN_MAX } = {}) {
  const jobs = new Map();
  const clients = new Set();
  const waiters = new Set();
  // One queue per kind, made on first use, so a caller passing only
  // { image, video } limits still gets songs and voices at their defaults.
  const queues = {};
  const running = {};
  const queueOf = (kind) => (queues[kind] ||= []);
  // A cap learned at run time — an upstream saying how many requests the
  // account may have open — only ever lowers the configured one.
  const learned = {};
  const limitOf = (kind) => Math.min(limits[kind] ?? LIMITS[kind] ?? 1, learned[kind] ?? Infinity);
  let seq = 0;

  const publicJob = (j) => ({
    id: j.id,
    kind: j.kind,
    folder: j.folder,
    prompt: j.prompt,
    model: j.model,
    characters: j.characters,
    // Every copy queued by one request shares this, so the gallery can show a
    // prompt's results together however their finishing order interleaves.
    batch: j.batch,
    // Set when the job is drawing a cast member's reference sheet, so the
    // editor can follow it and the gallery can leave it alone.
    characterId: j.characterId,
    status: j.status,
    phase: j.phase,
    refs: j.refs,
    startedAt: j.startedAt,
    queuedAt: j.queuedAt,
    finishedAt: j.finishedAt,
    error: j.error,
    item: j.item
  });

  // Finished jobs are kept so a poller can still collect them, but not forever
  // and not without a ceiling: oldest terminal jobs go first, and anything
  // still queued or running is never dropped.
  function prune(now = Date.now()) {
    const finished = [...jobs.values()].filter(isTerminal);
    for (const j of finished) if (now - (j.finishedAt || 0) > retainMs) jobs.delete(j.id);
    const left = [...jobs.values()].filter(isTerminal).sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    for (let i = 0; i < left.length - retainMax; i++) jobs.delete(left[i].id);
  }

  function emit(type, payload) {
    const frame = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  }

  const update = (job, patch) => {
    Object.assign(job, patch);
    if (isTerminal(job) && !job.finishedAt) job.finishedAt = Date.now();
    emit('job', { job: publicJob(job) });
    // A long-poll is settled by the same transition that feeds the event
    // stream, so `wait` returns the instant the last job lands.
    for (const w of [...waiters]) w();
  };

  function pump(kind) {
    running[kind] ||= 0;
    while (running[kind] < limitOf(kind) && queueOf(kind).length) {
      const job = queueOf(kind).shift();
      if (job.status === 'cancelled') continue;
      running[kind]++;
      update(job, { status: 'running', phase: 'starting', startedAt: Date.now() });
      job
        .run(job)
        .then((item) => {
          if (job.status !== 'cancelled') update(job, { status: 'done', phase: '', item });
        })
        .catch((e) => {
          if (job.status === 'cancelled') return;
          update(job, { status: 'error', phase: '', error: e?.message || String(e) });
        })
        .finally(() => {
          running[kind]--;
          prune();
          pump(kind);
        });
    }
  }

  function cancelOne(id) {
    const job = jobs.get(id);
    if (!job || isTerminal(job)) return false;
    if (job.status === 'queued') job.onCancel?.();
    job.ctrl.abort();
    update(job, { status: 'cancelled', phase: '' });
    return true;
  }

  return {
    add({ kind, folder, prompt, model, refs, characters, characterId, batch, run, onCancel }) {
      const id = `${Date.now().toString(36)}-${(seq++).toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
      const job = {
        id,
        kind,
        folder,
        prompt,
        model,
        refs,
        characters,
        characterId,
        batch,
        run,
        onCancel,
        status: 'queued',
        phase: 'queued',
        queuedAt: Date.now(),
        ctrl: new AbortController()
      };
      jobs.set(id, job);
      prune();
      queueOf(kind).push(job);
      emit('job', { job: publicJob(job) });
      pump(kind);
      return id;
    },
    progress(id, phase) {
      const job = jobs.get(id);
      if (job && job.status === 'running') update(job, { phase });
    },
    signal: (id) => jobs.get(id)?.ctrl.signal,
    cancel: cancelOne,
    // Stop everything still in flight — the "abort the batch I just queued"
    // button, and the same thing over HTTP.
    cancelAll: (kind) =>
      [...jobs.values()]
        .filter((j) => !isTerminal(j) && (!kind || j.kind === kind))
        .map((j) => j.id)
        .filter(cancelOne),
    active: () => [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').map(publicJob),
    snapshot: () => [...jobs.values()].map(publicJob),
    // Read specific jobs back by id. Ids the registry no longer holds come back
    // in `missing` rather than as a silent gap in the list, so a poller can tell
    // "not finished yet" apart from "waited too long and it has aged out".
    read(ids) {
      prune();
      const found = [];
      const missing = [];
      for (const id of ids) {
        const job = jobs.get(id);
        if (job) found.push(publicJob(job));
        else missing.push(id);
      }
      return { jobs: found, missing };
    },
    pendingIds: (kind) => [...jobs.values()].filter((j) => !isTerminal(j) && (!kind || j.kind === kind)).map((j) => j.id),
    // Long-poll until every named job has finished, or until the caller's
    // patience runs out. This is what lets a script submit a batch and collect
    // it with one more request instead of parsing an event stream.
    wait(ids, timeoutMs = 0) {
      const unfinished = () => ids.filter((id) => jobs.has(id) && !isTerminal(jobs.get(id)));
      if (!timeoutMs || !unfinished().length) return Promise.resolve(!unfinished().length);
      return new Promise((resolve) => {
        const settle = (ok) => {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(ok);
        };
        const check = () => {
          if (!unfinished().length) settle(true);
        };
        const timer = setTimeout(() => settle(false), timeoutMs);
        timer.unref?.();
        waiters.add(check);
      });
    },
    prune,
    get limits() {
      return Object.fromEntries(MEDIA_KINDS.map((k) => [k, limitOf(k)]));
    },
    // Lower one kind's concurrency to what the provider allows. Work already
    // running finishes; nothing more starts until the count is under the cap.
    capAt(kind, n) {
      const cap = Math.max(1, Math.floor(Number(n)));
      if (!Number.isFinite(cap) || cap >= limitOf(kind)) return false;
      learned[kind] = cap;
      return true;
    },
    subscribe(res) {
      clients.add(res);
      return () => clients.delete(res);
    },
    emit,
    clientCount: () => clients.size,
    closeAll() {
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
      clients.clear();
    }
  };
}

// ---------- server ----------

// `resolveKey(apiId)` is a function rather than a snapshot so a key saved after
// the server started (or rotated in the config) is picked up on the next call.
export function createServer({
  root,
  apis,
  videoModels = [],
  // Music models, served by OpenRouter over chat completions (Lyria 3).
  songModels = SONG_MODELS,
  songApi = 'openrouter',
  // ElevenLabs' speech models; refreshed from the account once it has a key.
  voiceModels = VOICE_MODELS,
  // Providers that are not image APIs — ElevenLabs — listed in Settings beside them.
  audioApis = AUDIO_APIS,
  // Design Arena's leaderboard, both categories. The one quality scale the
  // picker rates on; absent, models simply have no rank.
  designArena = null,
  resolveKey,
  defaultApi,
  // Concurrency caps per kind ({ image, video }); see LIMITS.
  limits = null,
  jobs = createJobs({ limits: resolveLimits(limits || {}) }),
  title = 'JustImagine',
  // The text model behind the ✨ button. Overridable so a user who prefers a
  // different writer — or a cheaper one — is not stuck with ours.
  enhanceModel = ENHANCE_MODEL,
  enhanceApi = VIDEO_KEY_API,
  characterApi = 'openrouter',
  characterModel = CHARACTER_REF_MODEL,
  // Optional hosted billing boundary. Reserve synchronously and atomically for
  // the complete request before any job starts. Local hosts remain unchanged.
  generationPolicy = null,
  // The cast is global rather than per-gallery, so it is addressed separately
  // from the gallery root and every gallery sees the same characters.
  charactersRoot = CHARACTERS_DIR,
  // Writing a key back to the config file. Injected rather than imported so the
  // server stays testable without touching the real ~/.bro/config.json; when it
  // is absent the settings panel goes read-only rather than failing on save.
  saveKey = null,
  // Shown in the settings panel so the file is findable, and named in the error
  // when there is nothing to write to.
  configPath = '',
  // Collect OpenRouter's speed measurements in the background. Only the real
  // entry point turns this on, so tests never reach the network.
  statsRefresh = false,
  auth = null,
  // Hosted accounts upload bytes; only local hosts may import arbitrary files.
  allowLocalPaths = true,
  suiteNavigation = false,
  preferenceScope = '',
  // How a piece of song reaches OpenRouter for lip sync; see audioRelayFromEnv.
  audioRelay = audioRelayFromEnv()
}) {
  ensureRoot(root);
  ensureLibrary(charactersRoot);

  const apiById = new Map(apis.map((a) => [a.id, a]));
  const audioApiById = new Map(audioApis.map((a) => [a.id, a]));
  const keyOf = (id) => (resolveKey ? resolveKey(id) || '' : '');
  // "an OpenRouter" / "an OpenLux" — for errors that name the missing key.
  const apiLabel = (id) => {
    const name = apiById.get(id)?.name || audioApiById.get(id)?.name || id;
    return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
  };
  // Every video model names the API that serves it; the bare OpenRouter
  // catalogue entries predate that and mean OpenRouter.
  const videoApiOf = (m) => m?.api || VIDEO_KEY_API;
  // A typed-in video id goes to OpenRouter, so its key alone is enough.
  const videoReady = () => !!keyOf(VIDEO_KEY_API) || videoModels.some((m) => !!keyOf(videoApiOf(m)));
  const authGuard = auth === false ? null : auth;

  // `prompt` is what the user typed and what gets recorded; `composed` is that
  // plus the character block, and is what the model actually sees.
  async function runImageJob(job, { api, prompt, composed, model, size, quality, refs, castNames, folderFull, folderRel, batch }) {
    const apiKey = keyOf(api.id);
    if (!apiKey) throw new Error(`No API key for ${api.name || api.id}. Add it in Settings.`);
    const started = Date.now();
    jobs.progress(job.id, 'generating');
    const { buf, ext, revisedPrompt } = await generateImage({
      api,
      apiKey,
      prompt: composed || prompt,
      model,
      size,
      quality,
      refs,
      signal: job.ctrl.signal
    }).catch((e) => {
      throw new Error(explainRefFailure(e.message, refs));
    });
    const file = outputName(prompt, ext);
    fs.mkdirSync(folderFull, { recursive: true });
    fs.writeFileSync(path.join(folderFull, file), buf);
    const entry = {
      file,
      kind: 'image',
      folder: folderRel,
      prompt,
      revisedPrompt: revisedPrompt || undefined,
      characters: castNames?.length ? castNames : undefined,
      api: api.id,
      model,
      size: size || 'auto',
      quality: quality || 'auto',
      images: refs.length ? refs.map((r) => r.file) : undefined,
      refs: refs.length || undefined,
      batch,
      bytes: buf.length,
      ms: Date.now() - started,
      ts: Date.now()
    };
    appendHistory(folderFull, entry);
    return entry;
  }

  async function runVideoJob(job, { prompt, composed, model, videoApi = VIDEO_KEY_API, adapter, params, refs, castNames, folderFull, folderRel, batch, musicVideo }) {
    const apiKey = keyOf(videoApi);
    if (!apiKey) {
      throw new Error(`Video generation with ${model} needs ${apiLabel(videoApi)} key. Add it in Settings.`);
    }
    const started = Date.now();
    const sent = [params.firstFrame, params.lastFrame, ...(params.refs || [])].filter(Boolean);
    // OpenRouter fetches a song piece itself, so it goes to the relay first;
    // OpenLux takes it inline.
    let upstream = params;
    if (params.audioRefs?.length && !adapter) {
      jobs.progress(job.id, 'sharing the song');
      const urls = await Promise.all(params.audioRefs.map((a) => audioRelay(a, job.ctrl.signal)));
      upstream = { ...params, audioRefs: urls.map((url) => ({ url })) };
    }
    const request = {
      apiKey,
      params: { model, prompt: composed || prompt, ...upstream },
      signal: job.ctrl.signal,
      onProgress: (p) => jobs.progress(job.id, p.phase)
    };
    // OpenRouter has one video API; OpenLux keeps each upstream's own, so its
    // models carry the adapter that knows their route.
    const run = adapter ? generateOpenLuxVideo({ ...request, adapter }) : generateVideo(request);
    const { buf, ext, cost, generationId } = await run.catch((e) => {
      throw new Error(explainRefFailure(e.message, sent));
    });
    const file = outputName(prompt, ext);
    fs.mkdirSync(folderFull, { recursive: true });
    fs.writeFileSync(path.join(folderFull, file), buf);
    const entry = {
      file,
      kind: 'video',
      ...(musicVideo || {}),
      folder: folderRel,
      prompt,
      characters: castNames?.length ? castNames : undefined,
      api: videoApi,
      model,
      duration: params.duration || undefined,
      resolution: params.resolution && params.resolution !== 'auto' ? params.resolution : undefined,
      aspectRatio: params.aspectRatio && params.aspectRatio !== 'auto' ? params.aspectRatio : undefined,
      size: params.size && params.size !== 'auto' ? params.size : undefined,
      audio: params.generateAudio || undefined,
      seed: params.seed || undefined,
      audioRef: params.audioRefs?.[0]?.file,
      images: refs.length ? refs.map((r) => r.file) : undefined,
      refs: refs.length || undefined,
      batch,
      cost,
      generationId,
      bytes: buf.length,
      ms: Date.now() - started,
      ts: Date.now()
    };
    appendHistory(folderFull, entry);
    return entry;
  }

  // A song: one streamed call, the whole track back. `prompt` is the idea as
  // typed and what the history keeps; `composed` folds in the lyrics, vocals,
  // tempo and length, and is what the model hears.
  async function runSongJob(job, { prompt, composed, model, lyrics, instrumental, vocals, bpm, length, seed, refs, folderFull, folderRel, batch }) {
    const api = apiById.get(songApi);
    const apiKey = keyOf(songApi);
    if (!apiKey) throw new Error(`Songs need ${apiLabel(songApi)} key. Add it in Settings.`);
    const started = Date.now();
    jobs.progress(job.id, 'composing');
    const song = await generateSong({
      chatUrl: api?.chatUrl || 'https://openrouter.ai/api/v1/chat/completions',
      apiKey,
      model,
      prompt: composed || prompt,
      images: refs,
      seed,
      signal: job.ctrl.signal
    }).catch((e) => {
      throw new Error(explainRefFailure(e.message, refs));
    });
    const file = outputName(prompt, song.ext);
    fs.mkdirSync(folderFull, { recursive: true });
    fs.writeFileSync(path.join(folderFull, file), song.buf);
    const entry = {
      file,
      kind: 'song',
      folder: folderRel,
      prompt,
      lyrics: lyrics || undefined,
      // What the model actually sang, which may differ from — or stand in
      // for — what was written.
      sung: song.lyrics && song.lyrics !== lyrics ? song.lyrics : undefined,
      instrumental: instrumental || undefined,
      vocals: vocals || undefined,
      bpm: bpm || undefined,
      length: length || undefined,
      api: songApi,
      model,
      seed: seed || undefined,
      images: refs.length ? refs.map((r) => r.file) : undefined,
      refs: refs.length || undefined,
      duration: audioDuration(song.buf) || undefined,
      batch,
      cost: song.cost,
      bytes: song.buf.length,
      ms: Date.now() - started,
      ts: Date.now()
    };
    appendHistory(folderFull, entry);
    return entry;
  }

  // ElevenLabs said the account is at its concurrent-request cap. When it
  // names the number, stop queueing more voice work than that at once, so the
  // rest waits in our own queue instead of bouncing off theirs.
  function elevenBusy({ cap } = {}) {
    if (cap) jobs.capAt('voice', cap);
  }

  // A voice line, or a script performed by several cast voices in one take.
  async function runVoiceJob(job, plan) {
    const { prompt, model, voiceMode, voice, lines, settings, language, seed, format, castNames, speakers, chars, folderFull, folderRel, batch } = plan;
    const apiKey = keyOf(ELEVENLABS_API_ID);
    if (!apiKey) throw new Error(`Voice needs ${apiLabel(ELEVENLABS_API_ID)} key. Add it in Settings.`);
    const started = Date.now();
    const phase = voiceMode === 'dialogue' ? 'performing' : 'speaking';
    jobs.progress(job.id, phase);
    const signal = job.ctrl.signal;
    // Over the account's concurrent-request cap: wait for a slot, and say so.
    const onBusy = (busy) => {
      elevenBusy(busy);
      jobs.progress(job.id, 'waiting for a free ElevenLabs slot');
    };
    const out =
      voiceMode === 'dialogue'
        ? await textToDialogue({ apiKey, lines, model, stability: settings?.stability, language, seed, format, signal, onBusy })
        : await textToSpeech({ apiKey, voiceId: voice.id, text: lines[0].text, model, settings, language, seed, format, signal, onBusy });
    // Named for who speaks — the character, not the stock voice they borrow.
    const file = outputName(`${(speakers?.length ? speakers : [voice.name]).join(' ')} ${prompt}`, out.ext);
    fs.mkdirSync(folderFull, { recursive: true });
    fs.writeFileSync(path.join(folderFull, file), out.buf);
    const entry = {
      file,
      kind: 'voice',
      folder: folderRel,
      prompt,
      voice: voiceMode === 'dialogue' ? undefined : { id: voice.id, name: voice.name },
      // Who speaks, in the order they first do.
      speakers: voiceMode === 'dialogue' ? speakers : undefined,
      characters: castNames?.length ? castNames : undefined,
      api: ELEVENLABS_API_ID,
      model,
      dialogue: voiceMode === 'dialogue' || undefined,
      settings: settings || undefined,
      language: language || undefined,
      format: format !== DEFAULT_VOICE_FORMAT ? format : undefined,
      seed: seed || undefined,
      chars: out.characters || chars,
      duration: audioDuration(out.buf) || undefined,
      batch,
      bytes: out.buf.length,
      ms: Date.now() - started,
      ts: Date.now()
    };
    appendHistory(folderFull, entry);
    return entry;
  }

  // Build a character a set of reference shots. The first is the seed — either
  // a reference it already has, or one generated from its description — and
  // every other shot is drawn from that seed, which is what keeps them the same
  // character rather than five people who match the same sentence.
  async function runCharacterRefsJob(job, { id, count }) {
    const api = apiById.get(characterApi);
    const apiKey = api ? keyOf(api.id) : '';
    if (!api || !apiKey) {
      throw new Error(`Generating references needs ${apiLabel(characterApi)} key. Add it in Settings.`);
    }
    const character = getCharacter(charactersRoot, id);
    if (!character) throw new Error(`No character "${id}"`);
    if (!character.description && !character.refs.length) {
      throw new Error('Give the character a description first. There is nothing to draw from yet.');
    }

    const seeded = character.refs.length > 0;
    const shots = characterShots(character, seeded ? Number(count) + 1 : Number(count));
    const shoot = (prompt, refs) =>
      generateImage({ api, apiKey, prompt, model: characterModel, refs, signal: job.ctrl.signal });

    const files = [];
    let seedRef;
    if (seeded) {
      seedRef = resolveCharacters(charactersRoot, [id])[0]?.resolved?.[0];
    } else {
      jobs.progress(job.id, 'drawing the first shot');
      const { buf, ext } = await shoot(shots.seed, []);
      const file = addCandidate(charactersRoot, id, buf, mediaTypeOf(`x.${ext}`) || 'image/png');
      files.push(file);
      seedRef = { file, buf, type: 'image/png', ext, dataUrl: `data:image/png;base64,${buf.toString('base64')}` };
    }
    if (!seedRef) throw new Error('Could not read a reference to build the rest of the set from.');

    let done = files.length;
    const total = files.length + shots.variations.length;
    const results = await mapLimit(shots.variations, REF_FANOUT, async (prompt) => {
      const { buf, ext } = await shoot(prompt, [seedRef]);
      const file = addCandidate(charactersRoot, id, buf, mediaTypeOf(`x.${ext}`) || 'image/png');
      jobs.progress(job.id, `${++done} of ${total}`);
      return file;
    });
    for (const r of results) if (r.ok) files.push(r.value);

    const failed = results.filter((r) => !r.ok);
    // Every shot failing is a real failure; a couple missing is just a smaller
    // set, and the ones that landed are already on disk.
    if (!files.length) throw new Error(failed[0]?.error || 'No reference images were produced.');
    return {
      kind: 'character-refs',
      characterId: id,
      files,
      failed: failed.length || undefined,
      error: failed.length ? failed[0].error : undefined
    };
  }

  // Every model row, with display-ready facts. Built in one place because the
  // boot payload and the live refresh below have to agree exactly.
  function modelsPayload() {
    const timings = modelTimings(root);
    const now = Date.now();
    // Only OpenRouter's catalogue carries prices, publish dates, Design Arena
    // standings and the publisher's blurb. Aggregators and first-party APIs
    // serve the same models under shorter ids, so match them by normalised key
    // and lend them those facts — otherwise picking a Yunwu or OpenAI model
    // means choosing from a bare list of ids.
    const catalogue = catalogueIndex([
      ...(apis.find((a) => a.id === 'openrouter')?.models || []),
      ...videoModels.filter((m) => videoApiOf(m) === VIDEO_KEY_API)
    ]);
    // How long a picture or a clip actually takes, measured by OpenRouter over
    // everyone's traffic — so a fresh gallery shows real speeds rather than
    // waiting for you to have generated something yourself.
    const latencies = readMediaStats();
    // One quality scale for the whole picker, from the board itself. OpenRouter
    // embeds a snapshot ranked among only the models it serves, which put two
    // different models at "#2" in the same list, left the first-party Images API
    // models unranked, and gave video no rating at all.
    const arena = arenaIndex(designArena);
    const withFacts = (raw, kind) => {
      const enriched = enrichMediaFacts(raw, catalogue);
      const ranked = arenaQuality(enriched, arena, kind);
      const m = ranked ? { ...enriched, quality: ranked } : enriched;
      const timing = timings[m.id] || (m.factsFrom ? timings[m.factsFrom] : null);
      const latency = latencies[m.id] || (m.factsFrom ? latencies[m.factsFrom] : null);
      const withLatency = latency?.p50 > 0 ? { ...m, latency } : m;
      return {
        ...withLatency,
        facts: mediaModelFacts(withLatency, { kind, now, timing }),
        detail: mediaModelDetail(withLatency, { kind })
      };
    };
    // Audio has no leaderboard and no catalogue to borrow from; its rows carry
    // their own price, age and the gallery's measured speed.
    const audioFacts = (raw, kind) => {
      const m = { ...raw, kind };
      return { ...m, facts: mediaModelFacts(m, { kind, now, timing: timings[m.id] }), detail: mediaModelDetail(m, { kind }) };
    };
    const songReady = !!keyOf(songApi);
    const voiceReady = !!keyOf(ELEVENLABS_API_ID);
    return {
      apis: apis.map((a) => ({
        id: a.id,
        name: a.name || a.id,
        video: !!a.video,
        models: (a.models || []).map((m) => withFacts(m, 'image')),
        hasKey: !!keyOf(a.id)
      })),
      videoModels: videoModels.map((m) => ({ ...withFacts(m, 'video'), api: videoApiOf(m), hasKey: !!keyOf(videoApiOf(m)) })),
      songModels: songModels.map((m) => ({ ...audioFacts(m, 'song'), api: songApi, hasKey: songReady })),
      voiceModels: voiceLib.models.map((m) => ({ ...audioFacts(m, 'voice'), api: ELEVENLABS_API_ID, hasKey: voiceReady }))
    };
  }

  // ---------- the voice library ----------

  // ElevenLabs' voices and models, read once a key exists and kept for a few
  // minutes: the composer and the cast editor both ask for them, and neither
  // should wait on ElevenLabs every time a menu opens.
  const VOICE_CACHE_MS = 10 * 60 * 1000;
  const voiceLib = { models: voiceModels, voices: null, at: 0, key: '' };

  async function voiceLibrary({ refresh = false } = {}) {
    const apiKey = keyOf(ELEVENLABS_API_ID);
    if (!apiKey) throw Object.assign(new Error(`Voices need ${apiLabel(ELEVENLABS_API_ID)} key. Add it in Settings.`), { status: 400 });
    // A different key is a different account, with different voices.
    const fresh = voiceLib.voices && voiceLib.key === apiKey && Date.now() - voiceLib.at < VOICE_CACHE_MS;
    if (refresh || !fresh) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      try {
        const [voices, models] = await Promise.all([
          listVoices({ apiKey, signal: ctrl.signal, onBusy: elevenBusy }),
          // The model list is a nicety; a failure keeps the bundled one.
          listVoiceModels({ apiKey, signal: ctrl.signal, onBusy: elevenBusy }).catch(() => null)
        ]);
        Object.assign(voiceLib, { voices, at: Date.now(), key: apiKey });
        if (models?.length) voiceLib.models = models;
      } finally {
        clearTimeout(timer);
      }
    }
    return voiceLib.voices;
  }
  const forgetVoices = () => { voiceLib.at = 0; };

  // Collect the speed numbers in the background and push the refreshed rows to
  // every open page, so the picker fills in without anyone reloading. Off by
  // default: only the real entry point turns it on, so tests never reach out.
  async function refreshModelStats() {
    const apiKey = keyOf('openrouter');
    if (!apiKey) return null;
    const wanted = [
      ...(apis.find((a) => a.id === 'openrouter')?.models || []).map((m) => ({ id: m.id, kind: 'image' })),
      ...videoModels.filter((m) => videoApiOf(m) === VIDEO_KEY_API).map((m) => ({ id: m.id, kind: 'video' }))
    ];
    try {
      await refreshMediaStats({ models: wanted, apiKey });
      if (jobs.clientCount()) jobs.emit('models', modelsPayload());
      return true;
    } catch {
      return false; // speeds stay blank; nothing else depends on them
    }
  }
  if (statsRefresh) setTimeout(refreshModelStats, 200).unref?.();

  // ---------- generation ----------

  // A reference is normally a name in the gallery's own `.context`, but a script
  // has files. Anything that looks like a path is registered on the way past and
  // swapped for its content-hash name, so `images: ["/photos/bottle.png"]` works
  // without a separate upload call. Registering is idempotent — the same bytes
  // keep the same name — so passing the same path to fifty items costs one write.
  const looksLikePath = (s) => /[\\/]/.test(s) || /^[a-zA-Z]:/.test(s);

  function registerRefPaths(images) {
    if (!Array.isArray(images)) return images;
    return images.map((entry) => {
      const name = String(entry || '');
      if (!name || !looksLikePath(name)) return name;
      if (!allowLocalPaths) throw Object.assign(new Error('Upload reference images instead of using server file paths.'), { status: 403 });
      const full = path.resolve(name);
      if (kindOf(full) !== 'image') throw Object.assign(new Error(`Not an image file: ${name}`), { status: 400 });
      let buf;
      try {
        buf = fs.readFileSync(full);
      } catch (e) {
        throw Object.assign(new Error(`Cannot read reference ${full}: ${e.code || e.message}`), { status: 400 });
      }
      return saveContext(root, `data:${mediaTypeOf(full)};base64,${buf.toString('base64')}`).file;
    });
  }

  // One generation spec, fully resolved but not yet queued. Splitting "can this
  // run?" from "run it" is what lets a batch reject its fortieth item before its
  // first has cost anything.
  function planGeneration(asked = {}) {
    const { spec, reused } = asked.reuse ? applyLastSettings(asked, readSettings(root)) : { spec: asked, reused: null };
    const plan = planSpec(spec);
    generationPolicy?.validate?.(plan);
    return reused && Object.keys(reused).length ? { ...plan, reused } : plan;
  }

  function planSpec(spec) {
    const kind = spec.kind === 'music-video' ? 'video' : MEDIA_KINDS.includes(spec.kind) ? spec.kind : 'image';
    const prompt = String(spec.prompt || '').trim();
    if (!prompt) throw Object.assign(new Error(kind === 'voice' ? 'Write what should be said.' : 'Prompt is required.'), { status: 400 });
    const { full: folderFull, rel: folderRel } = resolveFolder(root, spec.folder);
    const count = Math.min(Math.max(Number(spec.count) || 1, 1), COUNT_MAX[kind]);
    if (kind === 'voice') return planVoice(spec, { prompt, count, folderFull, folderRel });
    const refs = resolveRefs(root, registerRefPaths(spec.images));
    if (kind === 'song') return planSong(spec, { prompt, count, refs, folderFull, folderRel });

    // Picked characters bring their own reference images and are named in the
    // prompt, so "@Nora at a market stall" reaches the model as a described
    // person backed by pictures of her.
    const cast = resolveCharacters(charactersRoot, spec.characters);
    const characterRefs = cast.flatMap((c) => c.resolved);
    const common = {
      kind,
      count,
      prompt,
      composed: composePrompt(prompt, cast),
      castNames: cast.map((c) => c.name),
      folderFull,
      folderRel
    };

    if (kind === 'video') {
      const model = String(spec.model || videoModels[0]?.id || '').trim();
      if (!model) throw Object.assign(new Error('Pick a video model.'), { status: 400 });
      const modelSpec =
        (spec.api && videoModels.find((m) => m.id === model && videoApiOf(m) === spec.api)) || videoModels.find((m) => m.id === model);
      const musicVideo = spec.kind === 'music-video' || spec.workflow === 'music-video' ? musicVideoSpec(spec, modelSpec) : null;
      // A lip-synced shot hears a piece of the song. Checked here, before any
      // money is spent: the model must lip sync to a song, and OpenRouter can
      // only fetch the piece from a public link.
      const audioRef = spec.audioRef ? resolveAudioRef(root, spec.audioRef) : null;
      if (spec.audioRef) {
        if (!audioRef) throw badRequest('The piece of song for this shot is missing. Add it again.');
        if (!isLipSyncModel(modelSpec || { id: model })) throw badRequest(`${modelSpec?.name || model} cannot lip sync to a song. Pick a Seedance 2 model.`);
        if (!modelSpec?.adapter && !audioRelay) throw badRequest('Lip sync through OpenRouter needs a public link for each piece of the song. Use the OpenLux version of this model, or set JUSTIMAGINE_AUDIO_RELAY.');
      }
      // A typed-in id nobody lists goes to the API asked for, else OpenRouter.
      const videoApi = modelSpec ? videoApiOf(modelSpec) : apiById.get(spec.api)?.video ? spec.api : VIDEO_KEY_API;
      if (videoApi !== VIDEO_KEY_API && !modelSpec?.adapter) {
        throw Object.assign(new Error(`${apiById.get(videoApi)?.name || videoApi} has no video route for "${model}".`), { status: 400 });
      }
      const params = {
        duration: musicVideo?.duration || (spec.duration ? Number(spec.duration) : undefined),
        resolution: spec.resolution,
        aspectRatio: spec.aspectRatio,
        size: spec.size,
        generateAudio: musicVideo || audioRef ? true : typeof spec.audio === 'boolean' ? spec.audio : undefined,
        seed: spec.seed,
        ...(audioRef ? { audioRefs: [audioRef] } : {}),
        ...frameSelection({
          refs,
          characterRefs,
          spec: modelSpec,
          firstFrame: spec.firstFrame !== false,
          lastFrame: spec.lastFrame === true
        })
      };
      return { ...common, ...(musicVideo ? { composed: buildMusicVideoPrompt(common.composed, musicVideo), musicVideo } : {}), model, videoApi, adapter: modelSpec?.adapter, params, refs };
    }

    const api = apiById.get(spec.api) || apiById.get(defaultApi) || apis[0];
    if (!api) throw Object.assign(new Error('No image API configured.'), { status: 400 });
    const model = String(spec.model || api.models?.[0]?.id || '').trim();
    if (!model) throw Object.assign(new Error('Pick or type a model.'), { status: 400 });
    // A character's pictures ride alongside whatever was attached by hand,
    // capped the same way a manual attachment set is.
    return { ...common, api, model, size: spec.size, quality: spec.quality, refs: [...refs, ...characterRefs].slice(0, 8) };
  }

  const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

  // A song: the idea, plus the lyrics, vocals, tempo and length folded into
  // the one prompt a music model takes. An attached picture sets the mood on a
  // model that reads images, and is refused up front on one that does not.
  function planSong(spec, { prompt, count, refs, folderFull, folderRel }) {
    const model = String(spec.model || songModels[0]?.id || '').trim();
    if (!model) throw badRequest('Pick a song model.');
    const modelSpec = songModels.find((m) => m.id === model);
    if (refs.length && modelSpec?.images === false) throw badRequest(`${modelSpec.name || model} does not take images. Remove the attachments.`);
    const instrumental = spec.instrumental === true;
    const lyrics = instrumental ? '' : String(spec.lyrics || '').trim().slice(0, 5000);
    const vocals = instrumental ? '' : String(spec.vocals || '').trim().slice(0, 200);
    const bpm = Number(spec.bpm) >= 30 && Number(spec.bpm) <= 300 ? Math.round(Number(spec.bpm)) : undefined;
    // A clip is a clip; length is only something a full-song model can honour.
    const length = !modelSpec?.clipSeconds && ['short', 'medium', 'full'].includes(spec.length) ? spec.length : undefined;
    return {
      kind: 'song',
      count,
      prompt,
      composed: buildSongPrompt({ prompt, lyrics, instrumental, vocals, bpm, length }),
      model,
      api: apiById.get(songApi),
      lyrics,
      instrumental,
      vocals,
      bpm,
      length,
      seed: spec.seed,
      refs: refs.slice(0, 4),
      castNames: [],
      folderFull,
      folderRel
    };
  }

  // A voice line, or a script. Speakers are found in the text itself — a line
  // that starts "Nora:" is Nora's, in Nora's voice — so a scene between three
  // cast members is written, not configured. Everything that could fail (a
  // speaker with no voice, text too long for the model) fails here, before a
  // credit is spent.
  function planVoice(spec, { prompt, count, folderFull, folderRel }) {
    const everyone = listCharacters(charactersRoot);
    const picked = resolveCharacters(charactersRoot, spec.characters);
    const { lines, speakers } = parseScript(prompt, everyone);
    let model = String(spec.model || voiceLib.models[0]?.id || DEFAULT_VOICE_MODEL).trim();
    const format = VOICE_FORMATS.includes(spec.format) ? spec.format : DEFAULT_VOICE_FORMAT;
    const language = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(spec.language || '')) ? spec.language : undefined;
    // The narrator: the voice named in the request, else the one picked cast
    // member who has a voice.
    const named = typeof spec.voice === 'object' && spec.voice ? spec.voice : spec.voice ? { id: String(spec.voice) } : null;
    const pickedVoiced = picked.filter((c) => c.voice);
    const narratorCast = !named && pickedVoiced.length === 1 ? pickedVoiced[0] : null;
    const narrator = named?.id
      ? { id: String(named.id).slice(0, 100), name: String(named.name || spec.voiceName || voiceLib.voices?.find((v) => v.id === named.id)?.name || named.id).slice(0, 100) }
      : narratorCast
        ? narratorCast.voice
        : null;
    const asked = voiceSettings({ stability: spec.stability, similarity: spec.similarity, style: spec.style, speed: spec.speed, speakerBoost: spec.speakerBoost }, model);
    const base = { kind: 'voice', count, prompt, format, language, seed: spec.seed, folderFull, folderRel };

    if (speakers.length) {
      const silent = speakers.filter((c) => !c.voice);
      if (silent.length) {
        const names = silent.map((c) => c.name).join(', ');
        throw badRequest(`${names} ${silent.length === 1 ? 'has' : 'have'} no voice yet. Give ${silent.length === 1 ? 'them' : 'each'} one in the Cast tab.`);
      }
      if (lines.some((l) => !l.speaker) && !narrator) {
        throw badRequest('Some lines have no speaker. Start each line with a cast name ("Nora: …"), or pick a voice to narrate the rest.');
      }
      const said = lines.map((l) => ({ text: l.text, voiceId: (l.speaker ? l.speaker.voice : narrator).id, speaker: l.speaker?.name || narrator.name }));
      const names = [...new Set(said.map((l) => l.speaker))];
      const castNames = speakers.map((c) => c.name);
      // One voice throughout is a plain read, which every model can do.
      if (new Set(said.map((l) => l.voiceId)).size === 1) {
        const only = speakers.length === 1 && lines.every((l) => l.speaker) ? speakers[0] : null;
        const text = said.map((l) => l.text).join('\n');
        checkLength(text, model);
        return {
          ...base,
          model,
          voiceMode: 'speech',
          voice: only ? only.voice : narrator,
          lines: [{ text, voiceId: said[0].voiceId }],
          settings: asked || voiceSettings(only?.voice?.settings, model),
          castNames,
          speakers: names,
          chars: text.length
        };
      }
      // Several voices in one take is Eleven v3's alone.
      let warning;
      const modelSpec = voiceLib.models.find((m) => m.id === model);
      if (!modelSpec?.dialogue && model !== DIALOGUE_MODEL) {
        warning = `A scene between several voices is performed by ${voiceLib.models.find((m) => m.id === DIALOGUE_MODEL)?.name || DIALOGUE_MODEL}, so that model was used.`;
        model = DIALOGUE_MODEL;
      }
      const chars = said.reduce((n, l) => n + l.text.length, 0);
      checkLength(said.map((l) => l.text).join('\n'), model);
      return { ...base, model, voiceMode: 'dialogue', lines: said, settings: asked, castNames, speakers: names, chars, warning };
    }

    if (!narrator) throw badRequest('Pick a voice first, or give a cast member a voice and pick them.');
    const text = plainRead(prompt, everyone);
    checkLength(text, model);
    return {
      ...base,
      model,
      voiceMode: 'speech',
      voice: narrator,
      lines: [{ text, voiceId: narrator.id }],
      settings: asked || voiceSettings(narratorCast?.voice?.settings, model),
      castNames: narratorCast ? [narratorCast.name] : [],
      speakers: [narrator.name],
      chars: text.length
    };
  }

  function checkLength(text, model) {
    const max = voiceLib.models.find((m) => m.id === model)?.maxChars;
    if (max && text.length > max) {
      throw badRequest(`That is ${text.length.toLocaleString()} characters; ${voiceLib.models.find((m) => m.id === model)?.name || model} takes ${max.toLocaleString()} at a time. Split it into parts.`);
    }
  }

  // What a queued generation says about the last choices. Folder and cast stay
  // the composer's own: a script filing work somewhere else should not move
  // the gallery the next time it is opened.
  function rememberPlan(plan) {
    const p = plan.params || {};
    const patch =
      plan.kind === 'song'
        ? {
            mode: 'song',
            songModel: plan.model,
            instrumental: plan.instrumental,
            vocals: plan.vocals || '',
            length: plan.length || 'auto',
            ...(plan.bpm ? { bpm: plan.bpm } : {})
          }
        : plan.kind === 'voice'
        ? {
            mode: 'voice',
            voiceModel: plan.model,
            format: plan.format,
            ...(plan.voice ? { voiceId: plan.voice.id, voiceName: plan.voice.name } : {})
          }
        : plan.kind === 'video'
        ? {
            mode: plan.musicVideo ? 'music-video' : 'video',
            ...(plan.musicVideo ? { musicVideoModel: plan.model, musicStyle: plan.musicVideo.musicStyle } : {}),
            videoModel: plan.model,
            videoApi: plan.videoApi,
            duration: p.duration ? String(p.duration) : 'auto',
            resolution: p.resolution || 'auto',
            aspect: p.aspectRatio || 'auto',
            ...(typeof p.generateAudio === 'boolean' ? { audio: p.generateAudio } : {})
          }
        : {
            mode: 'image',
            api: plan.api.id,
            imageModel: plan.model,
            imageModels: { ...readSettings(root).imageModels, [plan.api.id]: plan.model },
            size: plan.size || 'auto',
            quality: plan.quality || 'auto'
          };
    try {
      writeSettings(root, patch);
    } catch {
      /* remembering is a convenience; the generation still runs */
    }
  }

  function queueFromPlan(plan, reservations = []) {
    const { kind, count, prompt, composed, castNames, folderFull, folderRel, model, refs } = plan;
    rememberPlan(plan);
    // One id for the `count` copies of this spec, recorded on each job and on
    // each history entry, so the gallery can group a prompt's results.
    const batch = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const ids = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        jobs.add({
          kind,
          folder: folderRel,
          prompt,
          model,
          characters: castNames,
          batch,
          refs:
            kind === 'video'
              ? plan.params.refs.length + (plan.params.firstFrame ? 1 : 0) + (plan.params.lastFrame ? 1 : 0)
              : refs?.length || 0,
          onCancel: () => generationPolicy?.release(reservations[i]),
          run: (job) => executeReserved(reservations[i], () =>
            kind === 'song'
              ? runSongJob(job, { ...plan, batch })
              : kind === 'voice'
              ? runVoiceJob(job, { ...plan, batch })
              : kind === 'video'
              ? runVideoJob(job, { prompt, composed, model, videoApi: plan.videoApi, adapter: plan.adapter, params: plan.params, refs, castNames, folderFull, folderRel, batch, musicVideo: plan.musicVideo })
              : runImageJob(job, {
                  prompt,
                  composed,
                  api: plan.api,
                  model,
                  size: plan.size,
                  quality: plan.quality,
                  refs,
                  castNames,
                  folderFull,
                  folderRel,
                  batch
                }), job)
        })
      );
    }
    return {
      jobs: ids,
      batch,
      kind,
      model,
      folder: folderRel,
      reused: plan.reused || undefined,
      warning:
        kind === 'video' && plan.params.droppedCharacters
          ? 'Your attached frame takes precedence, so the character references were not sent.'
          : plan.warning
    };
  }

  // A plain request to an upstream that should not hang the page forever.
  async function withTimeout(ms, work) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await work(ctrl.signal);
    } catch (e) {
      if (ctrl.signal.aborted) throw Object.assign(new Error('ElevenLabs took too long to answer. Try again.'), { status: 504 });
      throw Object.assign(e, { status: e.status || 502 });
    } finally {
      clearTimeout(timer);
    }
  }

  // Files on their way in through /api/media, kept outside the gallery (and
  // so outside anything a host syncs) until the last piece arrives.
  const uploads = new Map();
  const UPLOAD_DIR = path.join(os.tmpdir(), 'justimagine-uploads');
  const UPLOAD_MAX = 2 * 1024 ** 3;
  const sweepUploads = () => {
    for (const [id, up] of uploads) {
      if (Date.now() - up.touched < 3600_000) continue;
      fs.rm(up.file, { force: true }, () => {});
      uploads.delete(id);
    }
  };

  const executeReserved = (reservation, work, job) => generationPolicy
    ? generationPolicy.execute(reservation, work, job)
    : work();

  function queuePlans(plans) {
    const reservations = generationPolicy?.reserve(plans.flatMap(plan =>
      Array.from({ length: plan.count }, () => ({ ...plan, count: 1 }))
    )) || [];
    let offset = 0;
    try {
      return plans.map(plan => {
        const tickets = reservations.slice(offset, offset + plan.count);
        const queued = queueFromPlan(plan, tickets);
        offset += plan.count;
        return queued;
      });
    } catch (error) {
      for (const reservation of reservations.slice(offset)) generationPolicy?.release(reservation);
      throw error;
    }
  }

  const queueGeneration = (spec) => queuePlans([planGeneration(spec)])[0];

  // ---------- polling ----------

  const waitSeconds = (v) => Math.min(Math.max(Number(v) || 0, 0), WAIT_MAX_SEC);

  // Hold the request until every named job has finished (or the clock runs out),
  // then report them grouped the way a caller actually consumes them: what
  // landed, what failed, what is still going.
  async function collect(ids, seconds) {
    const settled = await jobs.wait(ids, seconds * 1000);
    const { jobs: rows, missing } = jobs.read(ids);
    return {
      settled,
      results: rows,
      items: rows.filter((j) => j.status === 'done' && j.item).map((j) => j.item),
      failed: rows
        .filter((j) => j.status === 'error')
        .map((j) => ({ id: j.id, prompt: j.prompt, model: j.model, error: j.error })),
      cancelled: rows.filter((j) => j.status === 'cancelled').map((j) => j.id),
      pending: rows.filter((j) => !isTerminal(j)).map((j) => j.id),
      missing: missing.length ? missing : undefined
    };
  }

  const routes = {
    async 'GET /api/state'() {
      // Every model row carries display-ready facts (age, cost, speed,
      // quality); speed is this gallery's own record of how long the model
      // has taken.
      return {
        title,
        root: suiteNavigation ? '' : root,
        hosted: suiteNavigation,
        preferenceScope,
        settings: readSettings(root),
        defaultApi,
        ...modelsPayload(),
        videoReady: videoReady(),
        songReady: !!keyOf(songApi),
        voiceReady: !!keyOf(ELEVENLABS_API_ID),
        voiceFormats: VOICE_FORMATS,
        countMax: COUNT_MAX,
        // The ✨ button rides on the same OpenRouter key as video.
        enhanceReady: !!keyOf(enhanceApi),
        characterRefsReady: !!keyOf(characterApi),
        enhanceModel,
        // Whether OpenRouter models can lip sync to a song (OpenLux always can),
        // and whether a song's words can be timed by ear.
        audioRelay: !!audioRelay,
        transcribeReady: !!keyOf(VIDEO_KEY_API),
        folders: listFolders(root),
        context: listContext(root),
        characters: listCharacters(charactersRoot),
        jobs: jobs.active()
      };
    },

    // The last choices, as the composer and `reuse` see them.
    'GET /api/settings'() {
      return { settings: readSettings(root) };
    },

    // Merge a patch into them. Unknown keys and wrong types are dropped.
    async 'POST /api/settings'(req) {
      const body = await readJsonBody(req, 256 * 1024);
      return { settings: writeSettings(root, body?.settings ?? body) };
    },

    // What the settings panel shows: every provider, whether it has a key and
    // where that key came from. Never the key itself — only enough of it to
    // recognise which one is saved.
    'GET /api/config'() {
      return {
        configPath: suiteNavigation ? '' : configPath,
        root: suiteNavigation ? '' : root,
        hosted: suiteNavigation,
        writable: !!saveKey,
        videoApi: VIDEO_KEY_API,
        songApi,
        enhanceModel,
        apis: [...apis, ...audioApis].map((a) => {
          const key = keyOf(a.id);
          const env = envKeyOf(a);
          const fromEnv = !!key && env.key === key;
          return {
            id: a.id,
            name: a.name || a.id,
            video: !!a.video,
            // What else rides on this key, for the panel's tags.
            song: a.id === songApi || undefined,
            voice: !!a.voice || undefined,
            keyUrl: a.keyUrl || '',
            // The variable actually in use, when the key came from one.
            keyEnv: suiteNavigation ? '' : (fromEnv && env.name) || a.keyEnv || '',
            keyEnvAliases: suiteNavigation || !a.keyEnvAliases?.length ? undefined : a.keyEnvAliases,
            models: a.voice ? voiceLib.models.length : (a.models || []).length,
            hasKey: !!key,
            // An env var is the shell's to change, not ours — the panel says so
            // instead of offering a Remove that would not stick.
            source: key ? (fromEnv ? 'env' : 'config') : '',
            keyPreview: maskKey(key)
          };
        })
      };
    },

    // Save or clear one provider's key. An empty key removes it, which is how
    // the panel's Remove button works.
    async 'POST /api/config/key'(req) {
      if (!saveKey) throw Object.assign(new Error('This gallery cannot write the config file.'), { status: 400 });
      const { id, key } = await readJsonBody(req);
      if (!id || !(apiById.has(id) || audioApiById.has(id))) throw Object.assign(new Error(`Unknown API "${id}"`), { status: 400 });
      const trimmed = typeof key === 'string' ? key.trim() : '';
      // A pasted key with a stray newline or quote is a support ticket waiting
      // to happen; strip the obvious wrappers before it is written.
      const cleaned = trimmed.replace(/^["'`]|["'`]$/g, '').trim();
      if (cleaned.length > 500) throw Object.assign(new Error('That does not look like an API key.'), { status: 400 });
      saveKey(id, cleaned);
      if (id === ELEVENLABS_API_ID) forgetVoices();
      return { ok: true, id, hasKey: !!cleaned, keyPreview: maskKey(cleaned) };
    },

    // Paged: a folder with thousands of generations must not turn into one
    // enormous response and one enormous DOM. The browser pulls the next page
    // as it scrolls. `deep=1` includes every subfolder, newest first.
    async 'GET /api/items'(req, res, url) {
      const folder = url.searchParams.get('folder') || '';
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500);
      const all = url.searchParams.get('deep') === '1' ? listItemsDeep(root, folder) : listItems(root, folder);
      return { folder: resolveFolder(root, folder).rel, items: all.slice(offset, offset + limit), offset, total: all.length };
    },

    async 'GET /api/folders'() {
      return { folders: listFolders(root) };
    },

    async 'POST /api/folder'(req) {
      const { parent, name } = await readJsonBody(req);
      return { path: createFolder(root, parent, name), folders: listFolders(root) };
    },

    async 'POST /api/folder/rename'(req) {
      const { path: rel, name } = await readJsonBody(req);
      return { path: renameFolder(root, rel, name), folders: listFolders(root) };
    },

    async 'POST /api/folder/delete'(req) {
      const { path: rel } = await readJsonBody(req);
      const removed = deleteFolder(root, rel);
      return { removed, folders: listFolders(root) };
    },

    async 'POST /api/move'(req) {
      const { from, to, files } = await readJsonBody(req);
      return { ...moveItems(root, from, to, files), folders: listFolders(root) };
    },

    async 'POST /api/delete'(req) {
      const { folder, file } = await readJsonBody(req);
      return { ok: deleteItem(root, folder, file) };
    },

    // A reference image arrives either as a data URL from the browser or as a
    // path on disk: a script has files, and base64-ing a PNG through a shell is
    // nobody's idea of an API. Both dedupe to the same content-hash name, so
    // uploading the same picture twice costs nothing.
    async 'POST /api/context'(req) {
      const body = await readJsonBody(req, 64 * 1024 * 1024);
      if (body.dataUrl) return isAudioDataUrl(body.dataUrl) ? saveAudioRef(root, body.dataUrl) : saveContext(root, body.dataUrl);
      const given = String(body.path || '').trim();
      if (!given) throw Object.assign(new Error('Send { dataUrl } or { path } of a local image file.'), { status: 400 });
      if (!allowLocalPaths) throw Object.assign(new Error('Upload reference images instead of using server file paths.'), { status: 403 });
      const full = path.resolve(given);
      if (kindOf(full) !== 'image') {
        throw Object.assign(new Error(`Not an image file: ${given} (png, jpg, webp or gif).`), { status: 400 });
      }
      let buf;
      try {
        buf = fs.readFileSync(full);
      } catch (e) {
        throw Object.assign(new Error(`Cannot read ${full}: ${e.code || e.message}`), { status: 400 });
      }
      if (buf.length > 32 * 1024 * 1024) throw Object.assign(new Error(`${given} is over 32 MB.`), { status: 400 });
      return { ...saveContext(root, `data:${mediaTypeOf(full)};base64,${buf.toString('base64')}`), path: full };
    },

    async 'POST /api/context/delete'(req) {
      const { file } = await readJsonBody(req);
      return { ok: deleteContext(root, file) };
    },

    // A finished file made in the browser (a stitched music video, or a song
    // brought in from elsewhere), sent in pieces so a big file never rides on
    // one long request:
    //   POST /api/media                        { folder, name, size, meta } -> { id }
    //   POST /api/media/chunk?id=…&offset=…    the next bytes              -> { received }
    //   POST /api/media/done                   { id }                      -> { item }
    async 'POST /api/media'(req) {
      const body = await readJsonBody(req, 512 * 1024);
      const { rel } = resolveFolder(root, body.folder);
      const size = Number(body.size);
      if (!Number.isSafeInteger(size) || size <= 0 || size > UPLOAD_MAX) throw badRequest(`Send the file's size, up to ${UPLOAD_MAX / 1024 ** 3} GB.`);
      sweepUploads();
      if (uploads.size >= 20) throw Object.assign(new Error('Too many uploads at once. Wait for one to finish.'), { status: 429 });
      const id = crypto.randomBytes(12).toString('hex');
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const file = path.join(UPLOAD_DIR, `${id}.part`);
      fs.writeFileSync(file, '');
      uploads.set(id, { file, folder: rel, name: String(body.name || '').slice(0, 200), size, received: 0, meta: uploadMeta(body.meta), kind: body.kind === 'voice' ? 'voice' : '', touched: Date.now() });
      return { id };
    },
    async 'POST /api/media/chunk'(req, res, url) {
      const up = uploads.get(String(url.searchParams.get('id') || ''));
      if (!up) throw Object.assign(new Error('That upload has expired. Start it again.'), { status: 404 });
      if (Number(url.searchParams.get('offset')) !== up.received) throw Object.assign(new Error(`Expected the bytes from ${up.received}.`), { status: 409 });
      const buf = await readRawBody(req, 32 * 1024 * 1024);
      if (up.received + buf.length > up.size) throw badRequest('More bytes than the file was said to have.');
      fs.appendFileSync(up.file, buf);
      up.received += buf.length;
      up.touched = Date.now();
      return { received: up.received };
    },
    async 'POST /api/media/done'(req) {
      const { id } = await readJsonBody(req);
      const up = uploads.get(String(id || ''));
      if (!up) throw Object.assign(new Error('That upload has expired. Start it again.'), { status: 404 });
      if (up.received !== up.size) throw badRequest(`Only ${up.received} of ${up.size} bytes arrived.`);
      uploads.delete(id);
      const fd = fs.openSync(up.file, 'r');
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      const type = sniffMedia(head);
      const kind = type.startsWith('video/') ? 'video' : type.startsWith('image/') ? 'image' : type.startsWith('audio/') ? up.kind || 'song' : '';
      if (!kind) {
        fs.rmSync(up.file, { force: true });
        throw badRequest('That is not a picture, video or audio file this gallery can keep.');
      }
      const { full: folderFull, rel: folderRel } = resolveFolder(root, up.folder);
      fs.mkdirSync(folderFull, { recursive: true });
      const file = outputName(up.meta.title || up.meta.prompt || up.name.replace(/\.[a-z0-9]+$/i, '') || kind, EXT_BY_TYPE[type] || 'bin');
      const dest = path.join(folderFull, file);
      try {
        fs.renameSync(up.file, dest);
      } catch {
        fs.copyFileSync(up.file, dest);
        fs.rmSync(up.file, { force: true });
      }
      const entry = { file, kind, folder: folderRel, ...up.meta, prompt: up.meta.prompt || up.name || file, bytes: up.size, ts: Date.now() };
      appendHistory(folderFull, entry);
      return { item: entry };
    },

    // When each word of a song in the gallery is sung (OpenRouter's Whisper),
    // so untimed lyrics can be lined up with the music.
    async 'POST /api/transcribe'(req) {
      const body = await readJsonBody(req, 16 * 1024 * 1024);
      const apiKey = keyOf(VIDEO_KEY_API);
      if (!apiKey) throw badRequest(`Timing a song needs ${apiLabel(VIDEO_KEY_API)} key. Add it in Settings.`);
      // A short piece sent inline (a clip's own sound), or a song in the gallery.
      if (body.dataUrl) {
        const m = String(body.dataUrl).match(/^data:audio\/(wav|x-wav|mpeg|mp4|ogg|flac|webm);base64,(.+)$/is);
        if (!m) throw badRequest('Send the audio as a WAV, MP3, M4A, OGG or FLAC data URL.');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60_000);
        try {
          return await transcribeWords({ apiKey, buf: Buffer.from(m[2], 'base64'), format: { 'x-wav': 'wav', mpeg: 'mp3', mp4: 'm4a' }[m[1].toLowerCase()] || m[1].toLowerCase(), signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
      }
      const { full } = resolveFile(root, body.folder, body.file);
      if (kindOf(full) !== 'audio') throw badRequest('Only a song can be timed.');
      let buf;
      try { buf = fs.readFileSync(full); } catch { throw Object.assign(new Error('That song is not in the gallery.'), { status: 404 }); }
      if (buf.length > 24 * 1024 * 1024) throw badRequest('That song is over 24 MB, too big to time.');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      try {
        return await transcribeWords({ apiKey, buf, format: path.extname(full).slice(1).toLowerCase() || 'mp3', signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    },

    async 'POST /api/thumb'(req) {
      const { folder, file, dataUrl } = await readJsonBody(req, 8 * 1024 * 1024);
      return saveThumb(root, folder, file, dataUrl);
    },

    // One id, a list of them, or everything still in flight — which is the
    // "stop the batch I just queued" escape hatch.
    async 'POST /api/cancel'(req) {
      const body = await readJsonBody(req);
      const cancelled = body.all
        ? jobs.cancelAll(MEDIA_KINDS.includes(body.kind) ? body.kind : '')
        : (Array.isArray(body.ids) ? body.ids : [body.id]).map((id) => String(id || '')).filter((id) => jobs.cancel(id));
      return { ok: cancelled.length > 0, cancelled };
    },

    // Poll instead of subscribe. `?ids=a,b,c` reports exactly those jobs and
    // `?wait=<seconds>` holds the request open until they have all finished, so
    // a script can submit and collect in two calls without parsing an event
    // stream. With no ids it reports the whole registry — finished jobs
    // included, for as long as they are retained — which is how you find a job
    // whose id you lost.
    async 'GET /api/jobs'(req, res, url) {
      const ids = (url.searchParams.get('ids') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const wait = waitSeconds(url.searchParams.get('wait'));
      const report = await collect(ids.length ? ids : jobs.pendingIds(), wait);
      if (ids.length) return report;
      const all = url.searchParams.get('active') === '1' ? jobs.active() : jobs.snapshot();
      return {
        ...report,
        results: all.sort((a, b) => (b.queuedAt || 0) - (a.queuedAt || 0)),
        active: jobs.pendingIds().length,
        limits: jobs.limits,
        retainMs: JOB_RETAIN_MS
      };
    },

    // The catalogue on its own: every knob a generation may set, without the
    // folder tree, the cast and the reference library that `/api/state` carries.
    // `?kind=video`, `?api=openrouter`, `?q=veo`, `?detail=1`, `?limit=n`,
    // `?sort=speed|quality|cost|new` (unknowns last).
    'GET /api/models'(req, res, url) {
      const kind = url.searchParams.get('kind');
      const wantApi = url.searchParams.get('api');
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const detail = url.searchParams.get('detail') === '1';
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 2000);
      const sort = url.searchParams.get('sort') || '';
      if (sort && !MODEL_SORTS.includes(sort)) {
        throw Object.assign(new Error(`Unknown sort "${sort}". Use one of: ${MODEL_SORTS.join(', ')}.`), { status: 400 });
      }
      const payload = modelsPayload();
      const row = (m, k, api, ready) => ({
        id: m.id,
        name: m.name || m.id,
        kind: k,
        api,
        ready,
        created: m.created || undefined,
        pricing: m.pricing || undefined,
        durations: m.durations || undefined,
        resolutions: m.resolutions || undefined,
        aspectRatios: m.aspectRatios || undefined,
        sizes: m.sizes || undefined,
        frames: m.frames || undefined,
        audio: m.audio || undefined,
        seed: m.seed || undefined,
        // songs
        clipSeconds: m.clipSeconds || undefined,
        full: k === 'song' ? !!m.full : undefined,
        images: k === 'song' ? !!m.images : undefined,
        // voice
        credits: k === 'voice' ? m.credits : undefined,
        maxChars: m.maxChars || undefined,
        dialogue: m.dialogue || undefined,
        tags: m.tags || undefined,
        pricedAs: m.factsFrom || undefined,
        // The numbers the sorts use, so an ordered list shows why it is ordered.
        speedMs: m.facts?.speed?.ms || undefined,
        rank: m.quality?.rank || undefined,
        description: detail ? m.description || undefined : undefined,
        facts: detail ? m.facts : undefined
      });
      // Sorted before the rows are built: the rows drop the facts it sorts on.
      if (kind && !MEDIA_KINDS.includes(kind)) {
        throw Object.assign(new Error(`Unknown kind "${kind}". Use one of: ${MEDIA_KINDS.join(', ')}.`), { status: 400 });
      }
      const found = [];
      const wants = (k) => !kind || kind === k;
      if (wants('image')) {
        for (const a of payload.apis) {
          if (wantApi && a.id !== wantApi) continue;
          for (const m of a.models) found.push({ ...m, row: () => row(m, 'image', a.id, a.hasKey) });
        }
      }
      for (const [k, list] of [['video', payload.videoModels], ['song', payload.songModels], ['voice', payload.voiceModels]]) {
        if (!wants(k)) continue;
        for (const m of list) {
          if (wantApi && m.api !== wantApi) continue;
          found.push({ ...m, row: () => row(m, k, m.api, m.hasKey) });
        }
      }
      const matched = q ? found.filter((m) => `${m.id} ${m.name || m.id}`.toLowerCase().includes(q)) : found;
      const ordered = sort ? sortMediaModels(matched, sort) : matched;
      return {
        models: ordered.slice(0, limit).map((m) => m.row()),
        total: matched.length,
        sort: sort || undefined,
        defaultApi,
        videoApi: VIDEO_KEY_API
      };
    },

    // Rewrite the composer's prompt into something the picked model can work
    // with. Fast enough (a second or two) that the browser just waits, so this
    // is a plain request rather than a job.
    async 'POST /api/enhance'(req) {
      const body = await readJsonBody(req);
      const apiKey = keyOf(enhanceApi);
      if (!apiKey) {
        throw Object.assign(
          new Error(`Improving prompts needs ${apiLabel(enhanceApi)} key. Add it in Settings.`),
          { status: 400 }
        );
      }
      // A music video's shot list: one bigger call to the same writer.
      if (body.kind === 'storyboard') {
        const ids = Array.isArray(body.characters) ? body.characters.map(String) : [];
        const cast = listCharacters(charactersRoot).filter((c) => ids.includes(c.id)).map((c) => ({ name: c.name, description: c.description }));
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 150_000);
        try {
          const plan = { kind: 'enhance', model: enhanceModel, api: apiById.get(enhanceApi), count: 1 };
          generationPolicy?.validate?.(plan);
          const ticket = generationPolicy?.reserve([plan])?.[0];
          return await executeReserved(ticket, () => writeStoryboard({
            apiKey, song: body.song || {}, shots: body.shots, cast, idea: String(body.idea || ''), aspect: String(body.aspect || '16:9'),
            enhanceModel, chatUrl: apiById.get(enhanceApi)?.chatUrl, signal: ctrl.signal
          }));
        } finally {
          clearTimeout(timer);
        }
      }
      const kind = ['video', 'character', ...AUDIO_ENHANCE_KINDS].includes(body.kind) ? body.kind : 'image';
      const model = String(body.model || '').trim();
      const spec =
        kind === 'video'
          ? videoModels.find((m) => m.id === model)
          : kind === 'song' || kind === 'lyrics'
            ? songModels.find((m) => m.id === model)
            : kind === 'voice'
              ? voiceLib.models.find((m) => m.id === model)
              : null;
      // Names only — the enhancer is told to keep them and not to re-describe
      // the face, which the reference images already carry. A voice script
      // names its own speakers, and those labels must survive the rewrite.
      const cast = (
        kind === 'voice' ? parseScript(body.prompt, listCharacters(charactersRoot)).speakers : resolveCharacters(charactersRoot, body.characters)
      ).map((c) => ({ name: c.name }));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45_000);
      try {
        const plan = { kind: 'enhance', model: enhanceModel, api: apiById.get(enhanceApi), count: 1 };
        generationPolicy?.validate?.(plan);
        const ticket = generationPolicy?.reserve([plan])?.[0];
        return await executeReserved(ticket, () => enhancePrompt({
          apiKey,
          prompt: body.prompt,
          kind,
          model,
          spec,
          characters: cast,
          refs: Array.isArray(body.images) ? body.images.length : 0,
          // For lyrics: the song's style, so the words suit the music.
          context: typeof body.context === 'string' ? body.context : '',
          enhanceModel,
          chatUrl: apiById.get(enhanceApi)?.chatUrl,
          signal: ctrl.signal
        }));
      } finally {
        clearTimeout(timer);
      }
    },

    // Queue one spec (`count` copies of it). `wait: <seconds>` turns it into a
    // blocking call that comes back with the finished items, which is all a
    // script wants for a single picture.
    async 'POST /api/generate'(req) {
      const body = await readJsonBody(req);
      const queued = queueGeneration(body);
      const wait = waitSeconds(body.wait);
      return wait ? { ...queued, ...(await collect(queued.jobs, wait)) } : queued;
    },

    // Many prompts, one request. The gallery's composer only ever sends one
    // spec, but a script writing a storyboard has fifty — and doing that as
    // fifty round trips means fifty chances to lose track of a job id.
    //
    //   { defaults: {…}, items: [{…}|"a prompt", …], wait: <seconds> }
    //
    // `defaults` is merged under every item, so the folder, model and knobs are
    // stated once. Images and video may be mixed freely; each item's `kind`
    // decides which queue it joins.
    async 'POST /api/batch'(req) {
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      const list = Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : null;
      if (!list?.length) throw Object.assign(new Error('Send { items: [ … ] } with one entry per generation.'), { status: 400 });
      if (list.length > BATCH_MAX_ITEMS) {
        throw Object.assign(new Error(`At most ${BATCH_MAX_ITEMS} items per batch (got ${list.length}).`), { status: 400 });
      }
      const defaults = (!Array.isArray(body) && body.defaults) || {};

      // Validate and count the whole batch before queueing any of it, so a typo
      // in item 40 doesn't leave 39 paid generations already running.
      const specs = list.map((raw, i) => {
        const spec = { ...defaults, ...(typeof raw === 'string' ? { prompt: raw } : raw || {}) };
        try {
          return { spec, plan: planGeneration(spec) };
        } catch (e) {
          throw Object.assign(new Error(`items[${i}]: ${e.message}`), { status: e.status || 400 });
        }
      });
      const total = specs.reduce((n, s) => n + s.plan.count, 0);
      if (total > BATCH_MAX_JOBS) {
        throw Object.assign(
          new Error(`That batch is ${total} generations; the limit is ${BATCH_MAX_JOBS}. Split it or lower "count".`),
          { status: 400 }
        );
      }

      const queued = queuePlans(specs.map(({ plan }) => plan));
      const ids = queued.flatMap((q) => q.jobs);
      const warnings = queued.map((q, i) => (q.warning ? `items[${i}]: ${q.warning}` : null)).filter(Boolean);
      const submitted = {
        jobs: ids,
        count: ids.length,
        images: queued.filter((q) => q.kind === 'image').reduce((n, q) => n + q.jobs.length, 0),
        videos: queued.filter((q) => q.kind === 'video').reduce((n, q) => n + q.jobs.length, 0),
        songs: queued.filter((q) => q.kind === 'song').reduce((n, q) => n + q.jobs.length, 0) || undefined,
        voices: queued.filter((q) => q.kind === 'voice').reduce((n, q) => n + q.jobs.length, 0) || undefined,
        warnings: warnings.length ? warnings : undefined
      };
      const wait = waitSeconds(!Array.isArray(body) ? body.wait : 0);
      if (!wait) return submitted;
      return { ...submitted, ...(await collect(ids, wait)) };
    },

    // ---------- characters ----------

    async 'GET /api/characters'() {
      return { characters: listCharacters(charactersRoot) };
    },

    async 'POST /api/characters'(req) {
      const { name, description, voice } = await readJsonBody(req);
      return { character: createCharacter(charactersRoot, { name, description, voice }) };
    },

    // `voice: {id, name}` gives a character a voice; `voice: null` takes it away.
    async 'POST /api/characters/update'(req) {
      const { id, name, description, cover, voice } = await readJsonBody(req);
      try {
        return { character: updateCharacter(charactersRoot, id, { name, description, cover, voice }) };
      } catch (e) {
        throw Object.assign(e, { status: e.status || 400 });
      }
    },

    // ---------- voices ----------

    // The account's voices and speech models, plus which cast member speaks
    // with which — the composer's voice menu and the cast editor both start here.
    async 'GET /api/voices'(req, res, url) {
      const voices = await voiceLibrary({ refresh: url.searchParams.get('refresh') === '1' });
      return {
        voices,
        models: modelsPayload().voiceModels,
        cast: listCharacters(charactersRoot)
          .filter((c) => c.voice)
          .map((c) => ({ id: c.id, name: c.name, voice: c.voice }))
      };
    },

    // Three candidate voices from a description, to audition before keeping one.
    async 'POST /api/voices/design'(req) {
      const { description, text: sample } = await readJsonBody(req);
      const apiKey = keyOf(ELEVENLABS_API_ID);
      if (!apiKey) throw badRequest(`Designing a voice needs ${apiLabel(ELEVENLABS_API_ID)} key. Add it in Settings.`);
      if (String(description || '').trim().length < 20) throw badRequest('Describe the voice in a little more detail, at least 20 characters.');
      const plan = { kind: 'voice-design', api: audioApiById.get(ELEVENLABS_API_ID), count: 1 };
      generationPolicy?.validate?.(plan);
      const ticket = generationPolicy?.reserve([plan])?.[0];
      return withTimeout(90_000, (signal) => executeReserved(ticket, () => designVoice({ apiKey, description, text: sample, signal, onBusy: elevenBusy })));
    },

    // Keep one designed candidate as a real voice, and give it to a character.
    async 'POST /api/voices/save'(req) {
      const { generatedVoiceId, name, description, characterId } = await readJsonBody(req);
      const apiKey = keyOf(ELEVENLABS_API_ID);
      if (!apiKey) throw badRequest(`Saving a voice needs ${apiLabel(ELEVENLABS_API_ID)} key. Add it in Settings.`);
      const character = characterId ? getCharacter(charactersRoot, characterId) : null;
      if (characterId && !character) throw badRequest(`No character "${characterId}"`);
      const saved = await withTimeout(60_000, (signal) =>
        saveDesignedVoice({ apiKey, generatedVoiceId, name: name || character?.name, description, signal, onBusy: elevenBusy })
      );
      forgetVoices();
      const voice = { ...saved, source: 'designed', description: String(description || '').trim() || undefined };
      return { voice, character: character ? updateCharacter(charactersRoot, character.id, { voice }) : undefined };
    },

    // An instant clone from recordings, optionally given straight to a character.
    async 'POST /api/voices/clone'(req) {
      const { name, description, samples, characterId, removeNoise } = await readJsonBody(req, 64 * 1024 * 1024);
      const apiKey = keyOf(ELEVENLABS_API_ID);
      if (!apiKey) throw badRequest(`Cloning a voice needs ${apiLabel(ELEVENLABS_API_ID)} key. Add it in Settings.`);
      const character = characterId ? getCharacter(charactersRoot, characterId) : null;
      if (characterId && !character) throw badRequest(`No character "${characterId}"`);
      const decoded = (Array.isArray(samples) ? samples : []).slice(0, 25).map((s, i) => {
        const m = String(s?.dataUrl ?? s ?? '').match(/^data:(audio\/[a-z0-9.+-]+|video\/(?:mp4|webm|quicktime));base64,(.+)$/is);
        if (!m) throw badRequest(`samples[${i}] is not an audio recording.`);
        const buf = Buffer.from(m[2], 'base64');
        return { buf, type: m[1].toLowerCase(), name: path.basename(String(s?.name || `sample-${i + 1}`)).slice(0, 80) };
      });
      if (!decoded.length) throw badRequest('Add at least one recording of the voice. A minute or two of clean speech is ideal.');
      const cloned = await withTimeout(120_000, (signal) =>
        cloneVoice({ apiKey, name: name || character?.name, description, samples: decoded, removeNoise: removeNoise === true, signal, onBusy: elevenBusy })
      );
      forgetVoices();
      const voice = { ...cloned, source: 'cloned', description: String(description || '').trim() || undefined };
      return { voice, character: character ? updateCharacter(charactersRoot, character.id, { voice }) : undefined };
    },

    // Hear a voice say a line before committing to it — nothing is saved to the
    // gallery. The editor uses it to audition a cast member's voice and settings.
    async 'POST /api/voices/say'(req) {
      const body = await readJsonBody(req);
      const apiKey = keyOf(ELEVENLABS_API_ID);
      if (!apiKey) throw badRequest(`Voice needs ${apiLabel(ELEVENLABS_API_ID)} key. Add it in Settings.`);
      const voiceId = String(body.voice?.id ?? body.voice ?? '').trim();
      if (!voiceId) throw badRequest('Which voice? Send { voice: "<voice id>" }.');
      const text = String(body.text || '').trim().slice(0, 300) || 'Hello there. This is how I sound. Does this feel right for me?';
      const model = String(body.model || voiceLib.models[0]?.id || DEFAULT_VOICE_MODEL);
      const plan = { kind: 'voice', model, api: audioApiById.get(ELEVENLABS_API_ID), count: 1, chars: text.length };
      generationPolicy?.validate?.(plan);
      const ticket = generationPolicy?.reserve([plan])?.[0];
      const out = await withTimeout(60_000, (signal) =>
        executeReserved(ticket, () => textToSpeech({ apiKey, voiceId, text, model, settings: voiceSettings(body.settings || {}, model), signal, onBusy: elevenBusy }))
      );
      return { dataUrl: `data:audio/mpeg;base64,${out.buf.toString('base64')}`, chars: out.characters || text.length };
    },

    // One file for the whole cast (or `?ids=a,b`), and back again. Import adds.
    async 'GET /api/characters/export'(req, res, url) {
      const ids = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
      return exportCast(charactersRoot, ids);
    },

    async 'POST /api/characters/import'(req) {
      const body = await readJsonBody(req, 256 * 1024 * 1024);
      try {
        const imported = importCast(charactersRoot, body?.cast ?? body);
        return { imported: imported.map((c) => c.id), characters: listCharacters(charactersRoot) };
      } catch (e) {
        throw Object.assign(e, { status: e.status || 400 });
      }
    },

    async 'POST /api/characters/delete'(req) {
      const { id } = await readJsonBody(req);
      return { ok: deleteCharacter(charactersRoot, id) };
    },

    // A reference arrives either as an upload or as "make this generation one
    // of Nora's references", which is the loop that sharpens a character.
    async 'POST /api/characters/refs'(req) {
      const { id, dataUrl, folder, file, path: given } = await readJsonBody(req, 64 * 1024 * 1024);
      if (dataUrl) return addRefFromDataUrl(charactersRoot, id, dataUrl);
      // A photo on disk — the third way in, for the same reason /api/context
      // takes one: a script has files, not data URLs.
      if (given) {
        if (!allowLocalPaths) throw Object.assign(new Error('Upload reference images instead of using server file paths.'), { status: 403 });
        const full = path.resolve(String(given));
        if (kindOf(full) !== 'image') throw Object.assign(new Error(`Not an image file: ${given}`), { status: 400 });
        let buf;
        try {
          buf = fs.readFileSync(full);
        } catch (e) {
          throw Object.assign(new Error(`Cannot read ${full}: ${e.code || e.message}`), { status: 400 });
        }
        return addRefFromDataUrl(charactersRoot, id, `data:${mediaTypeOf(full)};base64,${buf.toString('base64')}`);
      }
      const src = resolveFile(root, folder, file);
      if (kindOf(src.name) !== 'image') throw Object.assign(new Error('Only images can be character references.'), { status: 400 });
      return addRefFromDataUrl(
        charactersRoot,
        id,
        `data:${mediaTypeOf(src.name)};base64,${fs.readFileSync(src.full).toString('base64')}`
      );
    },

    // Draw the character a set of reference shots with Nano Banana 2.
    async 'POST /api/characters/refs/generate'(req) {
      const { id, count } = await readJsonBody(req);
      const character = getCharacter(charactersRoot, id);
      if (!character) throw Object.assign(new Error(`No character "${id}"`), { status: 400 });
      const want = Math.min(Math.max(Number(count) || 5, 1), 5);
      const plan = { kind: 'character-refs', model: characterModel, api: apiById.get(characterApi), count: want };
      generationPolicy?.validate?.(plan);
      const ticket = generationPolicy?.reserve([plan])?.[0];
      const job = jobs.add({
        kind: 'image',
        folder: '',
        prompt: `Reference shots for ${character.name}`,
        model: characterModel,
        characterId: character.id,
        refs: character.refs.length,
        onCancel: () => generationPolicy?.release(ticket),
        run: (j) => executeReserved(ticket, () => runCharacterRefsJob(j, { id: character.id, count: want }), j)
      });
      return { job, model: characterModel, count: want };
    },

    // Promote chosen shots into real references; the rest are thrown away.
    async 'POST /api/characters/refs/keep'(req) {
      const { id, files } = await readJsonBody(req);
      return keepCandidates(charactersRoot, id, files);
    },

    async 'POST /api/characters/candidates/clear'(req) {
      const { id, files } = await readJsonBody(req);
      return { character: clearCandidates(charactersRoot, id, files) };
    },

    async 'POST /api/characters/refs/delete'(req) {
      const { id, file } = await readJsonBody(req);
      return { ok: deleteRef(charactersRoot, id, file), character: getCharacter(charactersRoot, id) };
    }
  };


  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    try {
      if (method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, title, service: 'justimagine' }));
        return;
      }

      // Only the initial navigation may exchange a token for a cookie.
      if (authGuard?.enabled) {
        res.setHeader('referrer-policy', 'no-referrer');
        if (method === 'GET' && url.pathname === '/' && url.searchParams.has('token') && authGuard.matches(url.searchParams.get('token'))) {
          res.writeHead(303, { location: '/', 'set-cookie': authCookie(url.searchParams.get('token')), 'cache-control': 'no-store' });
          res.end();
          return;
        }
        const supplied = authGuard.tokenFromRequest(req);
        if (!authGuard.matches(supplied)) {
          res.writeHead(401, { ...authGuard.challenge(), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: 'Authentication required.' }));
          return;
        }
      }
      if (method === 'GET' && PAGE_MODULES[url.pathname]) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(fs.readFileSync(path.join(__dirname, PAGE_MODULES[url.pathname])));
        return;
      }
      if (method === 'GET' && url.pathname === '/') {
        let html = fs.readFileSync(UI_HTML);
        if (suiteNavigation) html = Buffer.from(html.toString().replace('<header', '<a class="suite-back" href="/" aria-label="Back to tools">← Your tools</a><header'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': html.length });
        res.end(req.method === 'HEAD' ? undefined : html);
        return;
      }

      // Live job feed. One long-lived response per tab; a comment line every
      // 25s keeps proxies and Windows' idle-socket reaper from closing it.
      if (method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        });
        res.write(`retry: 2000\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'snapshot', jobs: jobs.snapshot() })}\n\n`);
        const unsubscribe = jobs.subscribe(res);
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* closing */
          }
        }, 25_000);
        ping.unref?.();
        const close = () => {
          clearInterval(ping);
          unsubscribe();
        };
        req.on('close', close);
        res.on('close', close);
        return;
      }

      if (method === 'GET' && (url.pathname.startsWith('/media/') || url.pathname.startsWith('/thumb/'))) {
        const isThumb = url.pathname.startsWith('/thumb/');
        const name = decodeURIComponent(url.pathname.slice('/media/'.length)); // '/thumb/' is the same length
        const { full, name: file, folder } = resolveFile(root, url.searchParams.get('f') || '', name);
        if (isThumb) {
          sendFile(req, res, thumbPath(root, folder, file), 'image/jpeg');
          return;
        }
        if (url.searchParams.get('dl')) res.setHeader('content-disposition', `attachment; filename="${file.replace(/[^\w.\-]/g, '_')}"`);
        sendFile(req, res, full, mediaTypeOf(file));
        return;
      }

      // A character's own reference images, served from the global library
      // rather than from any one gallery.
      if (method === 'GET' && url.pathname.startsWith('/charref/')) {
        // Kept shots keep their filename, so one route covers a reference and a
        // candidate still waiting to be judged.
        const name = path.basename(decodeURIComponent(url.pathname.slice('/charref/'.length)));
        const full = resolveCandidate(charactersRoot, url.searchParams.get('c') || '', name);
        if (!full) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        sendFile(req, res, full, mediaTypeOf(name));
        return;
      }

      // The page's own artwork: section illustrations and provider marks,
      // shipped in the package. One folder deep, plain names only.
      const asset = method === 'GET' && url.pathname.match(/^\/assets\/([a-z]+)\/([a-z0-9-]+)\.(svg|png|jpg)$/);
      if (asset) {
        const types = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg' };
        sendFile(req, res, path.join(ASSETS_DIR, asset[1], `${asset[2]}.${asset[3]}`), types[asset[3]], { immutable: false });
        return;
      }

      if (method === 'GET' && url.pathname.startsWith('/context/')) {
        const name = path.basename(decodeURIComponent(url.pathname.slice('/context/'.length)));
        sendFile(req, res, path.join(contextDir(root), name), mediaTypeOf(name));
        return;
      }

      const handler = routes[`${method} ${url.pathname}`];
      if (handler) {
        // Reads are harmless; a write from another site is not — it could spend
        // the user's credits or overwrite a saved key.
        if (method !== 'GET' && !sameOrigin(req)) {
          sendJson(res, 403, { error: 'Cross-site request refused.' });
          return;
        }
        sendJson(res, 200, (await handler(req, res, url)) ?? { ok: true });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, e?.status || 500, { error: e?.message || String(e) });
    }
  });

  server.jobs = jobs;
  server.planGeneration = planGeneration;
  return server;
}

export function listenOnFreePort(server, start = 8790, tries = 20, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const attempt = (port, left) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && left > 0) attempt(port + 1, left - 1);
        else reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        // Ask the socket rather than trusting `port` — with port 0 the OS picks
        // one, and only the socket knows which.
        resolve(server.address()?.port ?? port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    attempt(start, tries);
  });
}
