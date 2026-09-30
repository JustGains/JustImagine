import { readApiResponse } from './justimagine-gen.js';

// Upstream calls for the two audio kinds.
//
//   song   — music models OpenRouter serves over chat completions (Lyria 3).
//            The request asks for an audio modality and streams; the song
//            arrives as base64 in `delta.audio.data`, and whatever the model
//            sang comes back as text in `delta.content`.
//   voice  — ElevenLabs: speech from text in one voice, dialogue between
//            several, and the voice library itself (list, design, clone).
//
// Like justimagine-gen.js, nothing here touches the filesystem: callers hand in
// text and reference images and get a buffer back.

// ---------- audio files ----------

// What a buffer actually is, from its first bytes. Neither upstream reliably
// says in a header, and the extension is what the gallery serves it by.
export function audioExt(buf) {
  if (!buf || buf.length < 12) return 'mp3';
  const head = buf.toString('latin1', 0, 4);
  if (head.startsWith('ID3')) return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (head === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (head === 'fLaC') return 'flac';
  if (head === 'OggS') return 'ogg';
  if (buf.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  return 'mp3';
}

const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// How long a clip runs, in seconds, read from the file itself so the gallery
// can label a tile without decoding it. WAV is exact; MP3 is exact when the
// encoder wrote a Xing/Info or VBRI frame count, and a constant-bitrate
// estimate otherwise. Anything else is left unknown rather than guessed.
export function audioDuration(buf) {
  if (!buf || buf.length < 64) return null;
  const ext = audioExt(buf);
  if (ext === 'wav') {
    let i = 12;
    let byteRate = 0;
    while (i + 8 <= buf.length) {
      const id = buf.toString('latin1', i, i + 4);
      const size = buf.readUInt32LE(i + 4);
      if (id === 'fmt ' && i + 16 <= buf.length) byteRate = buf.readUInt32LE(i + 16);
      if (id === 'data') return byteRate ? round(Math.min(size, buf.length - i - 8) / byteRate) : null;
      i += 8 + size + (size % 2);
    }
    return null;
  }
  if (ext !== 'mp3') return null;
  let start = 0;
  if (buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  // The first real frame header: a sync, Layer III, and indices that mean something.
  for (let i = start; i + 4 < Math.min(buf.length, start + 64 * 1024); i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (buf[i + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (buf[i + 1] >> 1) & 3; // 1 = Layer III
    const bitrateIdx = buf[i + 2] >> 4;
    const rateIdx = (buf[i + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) continue;
    const mpeg1 = version === 3;
    const bitrate = MP3_BITRATES[mpeg1 ? 1 : 2][bitrateIdx] * 1000;
    const sampleRate = MP3_RATES[version][rateIdx];
    const samples = mpeg1 ? 1152 : 576;
    const mono = buf[i + 3] >> 6 === 3;
    const side = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const xing = i + 4 + side;
    const tag = buf.toString('latin1', xing, xing + 4);
    if ((tag === 'Xing' || tag === 'Info') && buf.readUInt32BE(xing + 4) & 1) {
      return round((buf.readUInt32BE(xing + 8) * samples) / sampleRate);
    }
    if (buf.toString('latin1', i + 36, i + 40) === 'VBRI') {
      return round((buf.readUInt32BE(i + 36 + 14) * samples) / sampleRate);
    }
    return round(((buf.length - i) * 8) / bitrate);
  }
  return null;
}

const round = (s) => (Number.isFinite(s) && s > 0 ? Math.round(s * 10) / 10 : null);

// ---------- songs (OpenRouter) ----------

// Offline fallback for the song picker. The live list comes from OpenRouter's
// catalogue (loadOpenRouterSongModels in models.js); these keep the section
// usable on a first run with no network, and carry the prices OpenRouter only
// states in prose.
export const SONG_MODELS = [
  {
    id: 'google/lyria-3-pro-preview',
    name: 'Google: Lyria 3 Pro Preview',
    created: 1774907286,
    description:
      "Google's Lyria 3 Pro: full-length songs with verses, choruses and bridges, vocals with timed lyrics, and full instrumental arrangements in 48kHz stereo. Takes an image to set the mood.",
    pricing: { perSong: 0.08, source: 'OpenRouter list price' },
    full: true,
    images: true,
    seed: true
  },
  {
    id: 'google/lyria-3-clip-preview',
    name: 'Google: Lyria 3 Clip Preview',
    created: 1774907255,
    description:
      "Google's Lyria 3 for 30-second clips: loops, stingers, jingles and sketches of an idea before you pay for a full song. Vocals, lyrics and instrumentals, 48kHz stereo.",
    pricing: { perClip: 0.04, clipSeconds: 30, source: 'OpenRouter list price' },
    clipSeconds: 30,
    images: true,
    seed: true
  }
];

// Which audio-output models are music rather than speech. OpenRouter lists both
// under the same modality; gpt-audio talks, Lyria sings.
// (\budio, not udio: "gpt-audio" contains the letters too.)
const MUSIC_FAMILY = /lyria|music|song|suno|\budio\b|stable-audio|musicgen|riffusion|ace-step/i;

// "Full-length songs are priced at $0.08 per song." — OpenRouter prices these
// per output, and says so only in the description.
export function songPricing(description = '') {
  const text = String(description);
  const m = text.match(/\$\s*([\d.]+)\s*(?:per|\/)\s*(song|clip|track|generation)/i);
  if (!m) return undefined;
  const price = Number(m[1]);
  if (!Number.isFinite(price)) return undefined;
  const secs = Number(text.match(/(\d+)[\s-]*second/i)?.[1]) || undefined;
  return /clip/i.test(m[2])
    ? { perClip: price, clipSeconds: secs, source: 'OpenRouter list price' }
    : { perSong: price, source: 'OpenRouter list price' };
}

export function mapOpenRouterSongModels(data) {
  if (!Array.isArray(data)) return [];
  const known = new Map(SONG_MODELS.map((m) => [m.id, m]));
  return data
    .filter((m) => m?.id && (m.architecture?.output_modalities || []).includes('audio') && MUSIC_FAMILY.test(`${m.id} ${m.name || ''}`))
    .sort((a, b) => (b.created || 0) - (a.created || 0) || String(a.id).localeCompare(String(b.id)))
    .map((m) => {
      const bundled = known.get(m.id) || {};
      const pricing = songPricing(m.description) || bundled.pricing;
      return {
        ...bundled,
        id: m.id,
        name: m.name || bundled.name || m.id,
        kind: 'song',
        created: m.created || bundled.created,
        description: bundled.description || String(m.description || '').trim() || undefined,
        pricing,
        clipSeconds: pricing?.clipSeconds || bundled.clipSeconds,
        full: bundled.full ?? !pricing?.perClip,
        images: (m.architecture?.input_modalities || []).includes('image'),
        seed: (m.supported_parameters || []).includes('seed')
      };
    });
}

// The pieces of a song the composer asks for, as one prompt. Lyria reads
// lyrics with [Verse]/[Chorus] markers and follows plain instructions about
// vocals, tempo and length — there are no separate parameters for them.
export function buildSongPrompt({ prompt = '', lyrics = '', instrumental = false, vocals = '', bpm, length = '' } = {}) {
  const parts = [String(prompt || '').trim()];
  const extra = [];
  const tempo = Number(bpm);
  if (Number.isFinite(tempo) && tempo >= 30 && tempo <= 300) extra.push(`Tempo: around ${Math.round(tempo)} BPM.`);
  const lengths = { short: 'about one minute', medium: 'about two minutes', full: 'about three minutes, a complete song' };
  if (lengths[length]) extra.push(`Length: ${lengths[length]}.`);
  if (instrumental) extra.push('Instrumental only, with no vocals and no singing.');
  else if (String(vocals || '').trim()) extra.push(`Vocals: ${String(vocals).trim()}.`);
  if (extra.length) parts.push(extra.join(' '));
  const words = String(lyrics || '').trim();
  if (words && !instrumental) parts.push(`Lyrics:\n${words}`);
  return parts.filter(Boolean).join('\n\n');
}

// Read an SSE body into its data frames. OpenRouter interleaves comment lines
// (": OPENROUTER PROCESSING") to keep the connection open; those are skipped.
async function readSse(res, onFrame) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return; // a torn frame; the next one carries on
    }
    onFrame(frame);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) flush(line);
  }
  buffer += decoder.decode();
  for (const line of buffer.split(/\r?\n/)) flush(line);
}

// One song. The request streams because audio output requires it; the answer
// is collected whole, since nothing can play half an MP3 that is still
// arriving as base64 fragments.
export async function generateSong({ chatUrl, apiKey, model, prompt, images = [], seed, signal }) {
  const content = images.length
    ? [{ type: 'text', text: prompt }, ...images.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } }))]
    : prompt;
  const body = { model, messages: [{ role: 'user', content }], modalities: ['text', 'audio'], stream: true };
  if (Number.isFinite(Number(seed)) && String(seed).trim() !== '') body.seed = Number(seed);
  const res = await fetch(chatUrl, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const type = (res.headers.get('content-type') || '').toLowerCase();
  // An error, or a provider that ignored `stream` — both answer in JSON.
  if (!res.ok || !type.includes('event-stream')) return songFromJson(await readApiResponse(res));

  const audio = [];
  let text = '';
  let cost;
  let error = '';
  let finish = '';
  await readSse(res, (frame) => {
    if (frame.error) error = frame.error.message || JSON.stringify(frame.error);
    const choice = frame.choices?.[0];
    const delta = choice?.delta || {};
    if (delta.audio?.data) audio.push(delta.audio.data);
    if (typeof delta.content === 'string') text += delta.content;
    else if (delta.audio?.transcript) text += delta.audio.transcript;
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (frame.usage?.cost != null) cost = frame.usage.cost;
  });
  if (error) throw new Error(error);
  const buf = Buffer.from(audio.join(''), 'base64');
  if (!buf.length) {
    const said = text.trim();
    throw new Error(
      said
        ? `The model replied without a song: ${said.slice(0, 200)}`
        : `The model returned no audio${finish && finish !== 'stop' ? ` (${finish})` : ''}.`
    );
  }
  return { buf, ext: audioExt(buf), lyrics: cleanLyrics(text), cost };
}

function songFromJson(json) {
  const msg = json?.choices?.[0]?.message || {};
  const data = msg.audio?.data || (typeof msg.content === 'string' ? msg.content.match(/data:audio\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/i)?.[1] : '');
  if (!data) throw new Error('The model returned no audio.');
  const buf = Buffer.from(data, 'base64');
  const text = typeof msg.content === 'string' ? msg.content.replace(/data:audio\/[^\s)]+/g, '') : msg.audio?.transcript || '';
  return { buf, ext: audioExt(buf), lyrics: cleanLyrics(text), cost: json.usage?.cost };
}

// Lyria answers "<instrumental>" when there are no words; that is not lyrics.
function cleanLyrics(text) {
  const out = String(text || '').trim();
  return !out || /^<\s*instrumental\s*>$/i.test(out) ? '' : out;
}

// ---------- voices (ElevenLabs) ----------

export const ELEVENLABS_API_ID = 'elevenlabs';

// The audio providers, listed beside the image APIs in Settings. Kept apart
// from IMAGE_APIS because nothing about images or the model picker applies.
export const AUDIO_APIS = [
  {
    id: ELEVENLABS_API_ID,
    name: 'ElevenLabs',
    keyEnv: 'ELEVENLABS_API_KEY',
    // The spelling people also reach for; either one works.
    keyEnvAliases: ['ELEVEN_LABS_API_KEY'],
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    voice: true
  }
];

// A provider's key from the environment, under its main name or an alias —
// and which variable it came from, so Settings can say where to change it.
export function envKeyOf(api, env = process.env) {
  for (const name of [api?.keyEnv, ...(api?.keyEnvAliases || [])].filter(Boolean)) {
    if (env[name]) return { key: env[name], name };
  }
  return { key: '', name: '' };
}

// Resolved per call, so a test or a proxy can redirect a running server.
export const elevenBase = () => (process.env.JUSTIMAGINE_ELEVENLABS_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');

// The speech models, for when the live list cannot be read (no key yet, or
// offline). `credits` is ElevenLabs' cost multiplier per character; `dialogue`
// marks the one model that voices a multi-speaker script in a single take.
export const VOICE_MODELS = [
  {
    id: 'eleven_v3',
    name: 'Eleven v3',
    description:
      'The most expressive model: reads audio tags like [whispers], [laughs] or [sighs] as direction, 70+ languages, and the only one that performs a dialogue between several voices in one take.',
    credits: 1,
    maxChars: 5000,
    languages: 70,
    tags: true,
    dialogue: true
  },
  {
    id: 'eleven_multilingual_v2',
    name: 'Eleven Multilingual v2',
    description: 'Lifelike, steady narration in 29 languages. The dependable choice for long reads, audiobooks and voice-over.',
    credits: 1,
    maxChars: 10000,
    languages: 29,
    style: true
  },
  {
    id: 'eleven_flash_v2_5',
    name: 'Eleven Flash v2.5',
    description: 'Ultra-low latency speech in 32 languages at half the credits. Good for quick drafts and bulk lines.',
    credits: 0.5,
    maxChars: 40000,
    languages: 32
  },
  {
    id: 'eleven_turbo_v2_5',
    name: 'Eleven Turbo v2.5',
    description: 'Fast, good-quality speech in 32 languages at half the credits.',
    credits: 0.5,
    maxChars: 40000,
    languages: 32
  }
];
export const DEFAULT_VOICE_MODEL = 'eleven_v3';
export const DIALOGUE_MODEL = 'eleven_v3';
// Voice design has its own model family; the voices it makes speak on any TTS model.
export const VOICE_DESIGN_MODEL = 'eleven_multilingual_ttv_v2';
export const VOICE_FORMATS = ['mp3_44100_128', 'mp3_44100_192', 'mp3_44100_64'];
export const DEFAULT_VOICE_FORMAT = 'mp3_44100_128';

// ElevenLabs reports errors as `{detail: {message}}`, `{detail: "…"}` or a
// validation list; flatten whichever it is into one readable line.
function elevenError(status, text) {
  let msg = String(text || '').slice(0, 400);
  try {
    const j = JSON.parse(text);
    const d = j.detail ?? j.error ?? j;
    if (typeof d === 'string') msg = d;
    else if (Array.isArray(d)) msg = d.map((x) => x.msg || x.message || JSON.stringify(x)).join('; ');
    else if (d?.message) msg = d.message;
  } catch {
    /* keep raw */
  }
  return new Error(`${status} ${msg}`);
}

// ElevenLabs caps how many requests an account may have open at once (3 on
// Starter, more on higher plans) and answers the next one with a 429. That is
// not a failure — a slot frees up in seconds — so the request waits and tries
// again, quietly, until one does. `onBusy` hears about each wait, with the
// account's cap when the message states it, so a caller can stop sending more
// than the account allows.
export const ELEVEN_RETRY = { baseMs: 1000, maxMs: 8000, maxWaitMs: 10 * 60 * 1000 };

// "…a maximum of 3 concurrent requests…" → 3.
export function concurrencyCap(message) {
  const n = Number(String(message || '').match(/maximum of (\d+) concurrent/i)?.[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Wait, but give up the moment the caller cancels.
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Cancelled.'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason || new Error('Cancelled.')); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

async function eleven(pathname, { apiKey, method = 'GET', query, json, form, signal, audio = false, onBusy, retry = ELEVEN_RETRY } = {}) {
  const url = new URL(elevenBase() + pathname);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const headers = { 'xi-api-key': apiKey };
  if (json) headers['content-type'] = 'application/json';
  if (audio) headers.accept = 'audio/mpeg';
  const body = json ? JSON.stringify(json) : form;
  const started = Date.now();
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { method, signal, headers, body });
    if (res.status !== 429) break;
    const err = elevenError(res.status, await res.text());
    // Jittered and growing, so queued requests do not all retry in lockstep.
    const wait = Math.min(retry.maxMs, retry.baseMs * 2 ** Math.min(attempt, 6)) * (0.75 + Math.random() * 0.5);
    if (Date.now() - started + wait > retry.maxWaitMs) throw err;
    onBusy?.({ attempt: attempt + 1, waitMs: Math.round(wait), cap: concurrencyCap(err.message), message: err.message });
    await pause(wait, signal);
  }
  if (!res.ok) throw elevenError(res.status, await res.text());
  if (audio) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('ElevenLabs returned no audio.');
    return { buf, ext: audioExt(buf), characters: Number(res.headers.get('x-character-count')) || undefined, requestId: res.headers.get('request-id') || undefined };
  }
  const text = await res.text();
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error(`ElevenLabs returned non-JSON: ${text.slice(0, 200)}`);
  }
}

// A voice as the gallery shows it: who it is, what it sounds like, and a
// public preview to play before choosing it.
export function mapVoice(v) {
  if (!v?.voice_id) return null;
  const labels = v.labels || {};
  const describe = [labels.gender, labels.age, labels.accent, labels.descriptive || labels.description, labels.use_case || labels['use case']]
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.replace(/_/g, ' '));
  return {
    id: v.voice_id,
    name: v.name || v.voice_id,
    category: v.category || '',
    description: String(v.description || '').trim().slice(0, 400) || undefined,
    labels: describe.length ? describe : undefined,
    previewUrl: v.preview_url || undefined
  };
}

// Every voice on the account — premade, designed, cloned and saved from the
// library — a page at a time, up to a sane ceiling.
export async function listVoices({ apiKey, signal, max = 500, onBusy, retry }) {
  const out = [];
  let token = '';
  for (let page = 0; page < 10 && out.length < max; page++) {
    const json = await eleven('/v2/voices', { apiKey, signal, onBusy, retry, query: { page_size: 100, next_page_token: token || undefined, include_total_count: false } });
    for (const v of json.voices || []) {
      const mapped = mapVoice(v);
      if (mapped) out.push(mapped);
    }
    if (!json.has_more || !json.next_page_token) break;
    token = json.next_page_token;
  }
  // Your own voices first, then the premade set, each alphabetical.
  const rank = (v) => (v.category === 'premade' ? 1 : 0);
  return out.slice(0, max).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function mapVoiceModels(list) {
  if (!Array.isArray(list)) return [];
  const known = new Map(VOICE_MODELS.map((m) => [m.id, m]));
  return list
    .filter((m) => m?.model_id && m.can_do_text_to_speech !== false && !/_sts|ttv|stt|scribe/i.test(m.model_id))
    .map((m) => {
      const bundled = known.get(m.model_id) || {};
      return {
        ...bundled,
        id: m.model_id,
        name: m.name || bundled.name || m.model_id,
        kind: 'voice',
        description: bundled.description || String(m.description || '').trim() || undefined,
        credits: m.model_rates?.character_cost_multiplier ?? bundled.credits,
        maxChars: m.maximum_text_length_per_request || bundled.maxChars,
        languages: Array.isArray(m.languages) ? m.languages.length : bundled.languages,
        style: m.can_use_style ?? bundled.style,
        tags: bundled.tags,
        dialogue: bundled.dialogue
      };
    })
    .sort((a, b) => {
      const order = (x) => {
        const i = VOICE_MODELS.findIndex((m) => m.id === x.id);
        return i < 0 ? 99 : i;
      };
      return order(a) - order(b) || a.name.localeCompare(b.name);
    });
}

export async function listVoiceModels({ apiKey, signal, onBusy, retry }) {
  const models = mapVoiceModels(await eleven('/v1/models', { apiKey, signal, onBusy, retry }));
  return models.length ? models : VOICE_MODELS.map((m) => ({ ...m, kind: 'voice' }));
}

// The delivery sliders, as ElevenLabs names them. Anything unset stays unsent
// so the voice's own saved settings apply. Eleven v3 only takes three
// stability steps (Creative, Natural, Robust), so the value is snapped there.
export function voiceSettings({ stability, similarity, style, speed, speakerBoost } = {}, model = '') {
  const unit = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? undefined : Math.min(Math.max(Number(v), 0), 1));
  const out = {};
  let s = unit(stability);
  if (s != null && model === 'eleven_v3') s = s < 0.25 ? 0 : s > 0.75 ? 1 : 0.5;
  if (s != null) out.stability = s;
  const sim = unit(similarity);
  if (sim != null) out.similarity_boost = sim;
  const st = unit(style);
  if (st != null) out.style = st;
  const sp = Number(speed);
  if (speed !== '' && speed != null && Number.isFinite(sp)) out.speed = Math.min(Math.max(sp, 0.7), 1.2);
  if (typeof speakerBoost === 'boolean') out.use_speaker_boost = speakerBoost;
  return Object.keys(out).length ? out : undefined;
}

const seedOf = (seed) => (Number.isFinite(Number(seed)) && String(seed ?? '').trim() !== '' ? Math.floor(Number(seed)) : undefined);

// One voice reading one text.
export async function textToSpeech({ apiKey, voiceId, text, model = DEFAULT_VOICE_MODEL, settings, language, seed, format = DEFAULT_VOICE_FORMAT, signal, onBusy, retry }) {
  if (!voiceId) throw new Error('Pick a voice first.');
  return eleven(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    apiKey,
    method: 'POST',
    audio: true,
    signal,
    onBusy,
    retry,
    query: { output_format: format },
    json: {
      text,
      model_id: model,
      ...(settings ? { voice_settings: settings } : {}),
      ...(language ? { language_code: language } : {}),
      ...(seedOf(seed) != null ? { seed: seedOf(seed) } : {})
    }
  });
}

// Several voices, one take: `lines` is [{ text, voiceId }] in speaking order.
export async function textToDialogue({ apiKey, lines, model = DIALOGUE_MODEL, stability, language, seed, format = DEFAULT_VOICE_FORMAT, signal, onBusy, retry }) {
  if (!lines?.length) throw new Error('The script has no lines to say.');
  const s = voiceSettings({ stability }, model);
  return eleven('/v1/text-to-dialogue', {
    apiKey,
    method: 'POST',
    audio: true,
    signal,
    onBusy,
    retry,
    query: { output_format: format },
    json: {
      inputs: lines.map((l) => ({ text: l.text, voice_id: l.voiceId })),
      model_id: model,
      ...(s?.stability != null ? { settings: { stability: s.stability } } : {}),
      ...(language ? { language_code: language } : {}),
      ...(seedOf(seed) != null ? { seed: seedOf(seed) } : {})
    }
  });
}

// Three candidate voices from a written description, auditioned before any of
// them is kept. ElevenLabs wants the description between 20 and 1000
// characters and sample text between 100 and 1000; shorter text is replaced by
// one it writes itself.
export async function designVoice({ apiKey, description, text = '', model = VOICE_DESIGN_MODEL, signal, onBusy, retry }) {
  const desc = String(description || '').trim();
  if (desc.length < 20) throw new Error('Describe the voice in a little more detail, at least 20 characters.');
  const sample = String(text || '').trim();
  const json = await eleven('/v1/text-to-voice/design', {
    apiKey,
    method: 'POST',
    signal,
    onBusy,
    retry,
    query: { output_format: DEFAULT_VOICE_FORMAT },
    json: {
      voice_description: desc.slice(0, 1000),
      model_id: model,
      ...(sample.length >= 100 ? { text: sample.slice(0, 1000) } : { auto_generate_text: true })
    }
  });
  const previews = (json.previews || [])
    .filter((p) => p?.generated_voice_id && p.audio_base_64)
    .map((p) => ({
      id: p.generated_voice_id,
      dataUrl: `data:${p.media_type || 'audio/mpeg'};base64,${p.audio_base_64}`,
      duration: p.duration_secs || undefined
    }));
  if (!previews.length) throw new Error('ElevenLabs returned no voice previews.');
  return { previews, text: json.text || sample };
}

// Keep one of the designed candidates as a real voice on the account.
export async function saveDesignedVoice({ apiKey, generatedVoiceId, name, description, signal, onBusy, retry }) {
  if (!generatedVoiceId) throw new Error('Pick one of the previews to keep.');
  const json = await eleven('/v1/text-to-voice', {
    apiKey,
    method: 'POST',
    signal,
    onBusy,
    retry,
    json: { voice_name: String(name || 'Voice').slice(0, 100), voice_description: String(description || '').trim().slice(0, 1000), generated_voice_id: generatedVoiceId }
  });
  return mapVoice(json) || { id: json.voice_id, name };
}

// An instant clone from recordings of the voice. `samples` are { buf, type, name }.
export async function cloneVoice({ apiKey, name, description = '', samples = [], removeNoise = false, signal, onBusy, retry }) {
  if (!samples.length) throw new Error('Add at least one recording of the voice.');
  const form = new FormData();
  form.append('name', String(name || 'Voice').slice(0, 100));
  if (description) form.append('description', String(description).slice(0, 500));
  if (removeNoise) form.append('remove_background_noise', 'true');
  samples.forEach((s, i) => form.append('files', new Blob([s.buf], { type: s.type || 'audio/mpeg' }), s.name || `sample-${i + 1}.${s.ext || 'mp3'}`));
  const json = await eleven('/v1/voices/add', { apiKey, method: 'POST', form, signal, onBusy, retry });
  if (!json.voice_id) throw new Error('ElevenLabs did not return a voice id.');
  return { id: json.voice_id, name: String(name || 'Voice'), category: 'cloned', requiresVerification: !!json.requires_verification };
}

// ---------- scripts ----------

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A voice script is plain text in which a line may start with a speaker —
// "Nora: Where were you?" or "@Nora: …". A speaker must be someone in the cast;
// any other "Word:" is just text with a colon in it ("Note: bring coffee"), so
// ordinary prose never turns into a script by accident. A line with no speaker
// continues whoever spoke last, and anything before the first speaker belongs
// to the narrator — the voice picked in the composer.
//
// Returns { lines: [{ speaker, text }], speakers: [character…] }, with `speaker`
// null for the narrator. `speakers` is empty when nothing in the text is a cast
// line, which is how a caller tells a script from a plain read.
export function parseScript(text, cast = []) {
  const byName = new Map();
  for (const c of cast) {
    if (!c?.name) continue;
    byName.set(c.name.toLowerCase(), c);
    if (c.id) byName.set(String(c.id).toLowerCase(), c);
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const label = names.length ? new RegExp(`^\\s*@?(${names.join('|')})\\s*(?:\\([^)]*\\))?\\s*:\\s*(.*)$`, 'i') : null;
  const lines = [];
  const speakers = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = label && raw.match(label);
    if (m) {
      current = byName.get(m[1].toLowerCase());
      if (!speakers.includes(current)) speakers.push(current);
      lines.push({ speaker: current, text: m[2].trim() });
      continue;
    }
    const said = raw.trim();
    if (!said) continue;
    const last = lines[lines.length - 1];
    if (last && last.speaker === current) last.text = last.text ? `${last.text} ${said}` : said;
    else lines.push({ speaker: current, text: said });
  }
  return { lines: lines.filter((l) => l.text), speakers };
}

// `@Nora` in a plain read becomes "Nora", the way it does in an image prompt.
export function plainRead(text, cast = []) {
  let out = String(text || '');
  for (const c of cast) {
    if (!c?.name) continue;
    out = out.replace(new RegExp(`@${escapeRe(c.name)}\\b`, 'gi'), c.name);
    if (c.id) out = out.replace(new RegExp(`@${escapeRe(c.id)}\\b`, 'gi'), c.name);
  }
  return out.trim();
}
