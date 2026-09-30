import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer, listenOnFreePort } from './justimagine-server.js';
import { deleteRef, addRef, getCharacter } from './justimagine-characters.js';
import { listItems } from './justimagine-store.js';
import { fakeMp3 } from './audio.fixture.js';
import { ELEVEN_RETRY } from './justimagine-audio.js';

// Songs and voices end to end: the gallery's own routes, in front of a local
// stand-in that answers as OpenRouter (chat completions, streaming a song) and
// as ElevenLabs (speech, dialogue, the voice library, design and cloning).

const SONG = fakeMp3(3);
const SPEECH = fakeMp3(1);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let root;
let charRoot;
let upstream;
let upstreamBase;
let server;
let base;
let keys = {};
let calls = [];
let failVoice = false;
// How many more speech requests to turn away as over the account's cap.
let busyFor = 0;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-audio-'));
  charRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-audio-cast-'));
  keys = { openrouter: 'or-key', elevenlabs: 'el-key' };
  calls = [];
  failVoice = false;
  busyFor = 0;

  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = null;
    try {
      body = JSON.parse(raw.toString());
    } catch {
      /* multipart */
    }
    const url = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, raw });
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === '/v1/chat/completions') {
      // The prompt enhancer carries a system message; echo it so a test can
      // see which brief it was given.
      if (body.messages?.[0]?.role === 'system') return json(200, { choices: [{ message: { content: body.messages[0].content.split('\n')[0] } }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '[Chorus]\nsung words' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: SONG.toString('base64') } }, finish_reason: 'stop' }], usage: { cost: 0.08 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (failVoice) return json(401, { detail: { message: 'Invalid API key' } });
    if (busyFor > 0 && url.pathname.startsWith('/v1/text-to-speech/')) {
      busyFor--;
      return json(429, { detail: { status: 'too_many_concurrent_requests', message: 'Too many concurrent requests. Your current subscription is associated with a maximum of 3 concurrent requests (running in parallel).' } });
    }
    if (url.pathname.startsWith('/v1/text-to-speech/') || url.pathname === '/v1/text-to-dialogue') {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-character-count': String(JSON.stringify(body).length) });
      return res.end(SPEECH);
    }
    if (url.pathname === '/v2/voices') {
      return json(200, {
        voices: [
          { voice_id: 'rachel', name: 'Rachel', category: 'premade', preview_url: 'https://el.example/rachel.mp3', labels: { gender: 'female' } },
          { voice_id: 'mine1', name: 'My Narrator', category: 'cloned' }
        ],
        has_more: false
      });
    }
    if (url.pathname === '/v1/models') {
      return json(200, [
        { model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true, model_rates: { character_cost_multiplier: 1 }, maximum_text_length_per_request: 5000 },
        { model_id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', can_do_text_to_speech: true, model_rates: { character_cost_multiplier: 0.5 }, maximum_text_length_per_request: 40000 }
      ]);
    }
    if (url.pathname === '/v1/text-to-voice/design') {
      return json(200, { previews: [1, 2, 3].map((n) => ({ generated_voice_id: `gen-${n}`, audio_base_64: SPEECH.toString('base64'), media_type: 'audio/mpeg' })), text: 'sample' });
    }
    if (url.pathname === '/v1/text-to-voice') return json(200, { voice_id: 'designed-1', name: body.voice_name });
    if (url.pathname === '/v1/voices/add') return json(200, { voice_id: 'cloned-1' });
    json(404, { detail: 'not found' });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  process.env.JUSTIMAGINE_ELEVENLABS_URL = upstreamBase;

  server = createServer({
    root,
    apis: [{ id: 'openrouter', name: 'OpenRouter', chatUrl: `${upstreamBase}/v1/chat/completions`, video: true, models: [] }],
    videoModels: [],
    resolveKey: (id) => keys[id] || '',
    defaultApi: 'openrouter',
    charactersRoot: charRoot,
    saveKey: (id, key) => {
      if (key) keys[id] = key;
      else delete keys[id];
    }
  });
  base = `http://127.0.0.1:${await listenOnFreePort(server, 0)}`;
});

const shutdown = async (s) => {
  const closed = new Promise((r) => s.close(r));
  s.closeAllConnections?.();
  await closed;
};

afterEach(async () => {
  delete process.env.JUSTIMAGINE_ELEVENLABS_URL;
  server.jobs.closeAll();
  await shutdown(server);
  await shutdown(upstream);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(charRoot, { recursive: true, force: true });
});

const getJson = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json() };
};
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
};
const upstreamCalls = (p) => calls.filter((c) => c.path === p || c.path.startsWith(p));

// A cast member with a voice, the way the editor leaves one.
async function voiced(name, voiceId, extra = {}) {
  const { body } = await post('/api/characters', { name, description: `${name} is someone`, voice: { id: voiceId, name: `${name}'s voice`, ...extra } });
  return body.character;
}

// ---------- state ----------

test('the gallery says which audio sections are ready, and lists their models', async () => {
  let { body } = await getJson('/api/state');
  expect(body).toMatchObject({ songReady: true, voiceReady: true });
  expect(body.songModels.map((m) => m.id)).toEqual(['google/lyria-3-pro-preview', 'google/lyria-3-clip-preview']);
  expect(body.songModels[0].facts.cost.label).toBe('8¢/song');
  expect(body.songModels[1].facts.cost.label).toBe('4¢/clip');
  expect(body.voiceModels[0]).toMatchObject({ id: 'eleven_v3', api: 'elevenlabs', hasKey: true });
  expect(body.voiceModels[0].facts.cost.label).toBe('1 cr/char');
  expect(body.voiceModels[0].detail.chips.map((c) => c.label)).toContain('dialogue');
  expect(body.countMax).toMatchObject({ song: 4, voice: 4 });

  keys = {};
  ({ body } = await getJson('/api/state'));
  expect(body).toMatchObject({ songReady: false, voiceReady: false });
});

test('ElevenLabs sits in the settings panel beside the image providers, and takes a key', async () => {
  keys = { openrouter: 'or-key' };
  const { body } = await getJson('/api/config');
  const el = body.apis.find((a) => a.id === 'elevenlabs');
  expect(el).toMatchObject({ name: 'ElevenLabs', voice: true, hasKey: false, keyEnv: 'ELEVENLABS_API_KEY' });
  expect(body.apis.find((a) => a.id === 'openrouter')).toMatchObject({ song: true, video: true });

  const saved = await post('/api/config/key', { id: 'elevenlabs', key: ' sk_el_1234567890abcd ' });
  expect(saved.body).toMatchObject({ ok: true, hasKey: true, keyPreview: 'sk_e…abcd' });
  expect(keys.elevenlabs).toBe('sk_el_1234567890abcd');
});

// ---------- songs ----------

test('a song is composed from its parts, streamed, and filed with its lyrics', async () => {
  await post('/api/folder', { parent: '', name: 'Album' });
  const { status, body } = await post('/api/generate', {
    kind: 'song',
    folder: 'Album',
    prompt: 'dreamy synth-pop about a night drive',
    model: 'google/lyria-3-pro-preview',
    lyrics: '[Verse]\nNeon on the windscreen',
    vocals: 'breathy female lead',
    bpm: 104,
    length: 'full',
    count: 9,
    wait: 10
  });
  expect(status).toBe(200);
  expect(body.jobs).toHaveLength(4); // capped: a song is judged by listening
  expect(body.failed).toEqual([]);

  const sent = upstreamCalls('/v1/chat/completions')[0];
  expect(sent.headers.authorization).toBe('Bearer or-key');
  expect(sent.body).toMatchObject({ model: 'google/lyria-3-pro-preview', modalities: ['text', 'audio'], stream: true });
  const composed = sent.body.messages[0].content;
  expect(composed).toContain('dreamy synth-pop');
  expect(composed).toContain('Tempo: around 104 BPM.');
  expect(composed).toContain('about three minutes');
  expect(composed).toContain('Vocals: breathy female lead.');
  expect(composed).toContain('Lyrics:\n[Verse]\nNeon on the windscreen');

  const items = listItems(root, 'Album');
  expect(items).toHaveLength(4);
  const song = items[0];
  expect(song).toMatchObject({
    kind: 'song',
    prompt: 'dreamy synth-pop about a night drive',
    lyrics: '[Verse]\nNeon on the windscreen',
    sung: '[Chorus]\nsung words',
    vocals: 'breathy female lead',
    bpm: 104,
    length: 'full',
    api: 'openrouter',
    model: 'google/lyria-3-pro-preview',
    cost: 0.08
  });
  expect(song.file).toEndWith('.mp3');
  expect(song.duration).toBeCloseTo(3, 0);

  // and it plays straight back out, seekable
  const r = await fetch(`${base}/media/${encodeURIComponent(song.file)}?f=Album`, { headers: { range: 'bytes=0-9' } });
  expect(r.status).toBe(206);
  expect(r.headers.get('content-type')).toBe('audio/mpeg');
});

test('an instrumental sends no words, and a clip model ignores the length', async () => {
  await post('/api/generate', {
    kind: 'song',
    prompt: 'lo-fi beat',
    model: 'google/lyria-3-clip-preview',
    instrumental: true,
    lyrics: 'should not be sung',
    length: 'full',
    wait: 10
  });
  const composed = upstreamCalls('/v1/chat/completions')[0].body.messages[0].content;
  expect(composed).toContain('Instrumental only');
  expect(composed).not.toContain('should not be sung');
  expect(composed).not.toContain('minutes');
  expect(listItems(root, '')[0]).toMatchObject({ kind: 'song', instrumental: true });
  expect(listItems(root, '')[0].lyrics).toBeUndefined();
});

test('a picture sets the mood of a song as vision input', async () => {
  const { body: ctx } = await post('/api/context', { dataUrl: 'data:image/png;base64,' + PNG.toString('base64') });
  await post('/api/generate', { kind: 'song', prompt: 'the feeling of this photo', images: [ctx.file], wait: 10 });
  const content = upstreamCalls('/v1/chat/completions')[0].body.messages[0].content;
  expect(content[0]).toMatchObject({ type: 'text' });
  expect(content[1].image_url.url).toStartWith('data:image/png;base64,');
  expect(listItems(root, '')[0]).toMatchObject({ refs: 1, images: [ctx.file] });
});

test('a song without an OpenRouter key fails with instructions', async () => {
  keys = { elevenlabs: 'el-key' };
  const { body } = await post('/api/generate', { kind: 'song', prompt: 'anything', wait: 5 });
  expect(body.failed[0].error).toContain('OpenRouter key');
});

// ---------- voices ----------

test('a line is spoken in the voice picked, and filed under it', async () => {
  const { body } = await post('/api/generate', {
    kind: 'voice',
    prompt: 'Welcome back to the show.',
    voice: 'rachel',
    voiceName: 'Rachel',
    model: 'eleven_multilingual_v2',
    stability: 0.4,
    speed: 1.1,
    wait: 10
  });
  expect(body.failed).toEqual([]);
  const call = upstreamCalls('/v1/text-to-speech/')[0];
  expect(call.path).toBe('/v1/text-to-speech/rachel');
  expect(call.headers['xi-api-key']).toBe('el-key');
  expect(call.query.output_format).toBe('mp3_44100_128');
  expect(call.body).toEqual({ text: 'Welcome back to the show.', model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, speed: 1.1 } });
  const [item] = listItems(root, '');
  expect(item).toMatchObject({ kind: 'voice', prompt: 'Welcome back to the show.', voice: { id: 'rachel', name: 'Rachel' }, api: 'elevenlabs', model: 'eleven_multilingual_v2' });
  expect(item.file).toMatch(/^\d{8}-\d{6}-rachel-welcome-back/);
});

test("a picked cast member speaks in their own voice, with their own delivery", async () => {
  const nora = await voiced('Nora', 'nora-voice', { settings: { stability: 0.9, similarity: 0.7 } });
  await post('/api/generate', { kind: 'voice', prompt: 'Hello, @Nora here.', characters: [nora.id], model: 'eleven_multilingual_v2', wait: 10 });
  const call = upstreamCalls('/v1/text-to-speech/')[0];
  expect(call.path).toBe('/v1/text-to-speech/nora-voice');
  expect(call.body.text).toBe('Hello, Nora here.');
  expect(call.body.voice_settings).toEqual({ stability: 0.9, similarity_boost: 0.7 });
  expect(listItems(root, '')[0]).toMatchObject({ characters: ['Nora'], voice: { id: 'nora-voice' } });
});

test('a script between cast members is one dialogue, each in their own voice', async () => {
  await voiced('Nora', 'nora-voice');
  await voiced('Sam', 'sam-voice');
  const { body } = await post('/api/generate', {
    kind: 'voice',
    prompt: 'Nora: [whispers] Where were you?\nSam: Out.\nNora: All night?',
    model: 'eleven_flash_v2_5',
    wait: 10
  });
  // Only Eleven v3 performs several voices at once, so the plan says it switched.
  expect(body.warning).toContain('Eleven v3');
  const call = upstreamCalls('/v1/text-to-dialogue')[0];
  expect(call.body).toEqual({
    inputs: [
      { text: '[whispers] Where were you?', voice_id: 'nora-voice' },
      { text: 'Out.', voice_id: 'sam-voice' },
      { text: 'All night?', voice_id: 'nora-voice' }
    ],
    model_id: 'eleven_v3'
  });
  const [item] = listItems(root, '');
  expect(item).toMatchObject({ kind: 'voice', dialogue: true, speakers: ['Nora', 'Sam'], characters: ['Nora', 'Sam'], model: 'eleven_v3' });
});

test('lines with no speaker go to the narrator voice', async () => {
  await voiced('Nora', 'nora-voice');
  await post('/api/generate', { kind: 'voice', prompt: 'The door creaked.\nNora: Hello?', voice: 'rachel', wait: 10 });
  expect(upstreamCalls('/v1/text-to-dialogue')[0].body.inputs).toEqual([
    { text: 'The door creaked.', voice_id: 'rachel' },
    { text: 'Hello?', voice_id: 'nora-voice' }
  ]);
});

test('a script with a single speaker is a plain read, on any model', async () => {
  await voiced('Nora', 'nora-voice');
  await post('/api/generate', { kind: 'voice', prompt: 'Nora: First line.\nNora: Second line.', model: 'eleven_flash_v2_5', wait: 10 });
  expect(upstreamCalls('/v1/text-to-dialogue')).toHaveLength(0);
  const call = upstreamCalls('/v1/text-to-speech/')[0];
  expect(call.path).toBe('/v1/text-to-speech/nora-voice');
  expect(call.body).toMatchObject({ text: 'First line.\nSecond line.', model_id: 'eleven_flash_v2_5' });
});

test('a voice request that cannot work is refused before a credit is spent', async () => {
  await voiced('Nora', 'nora-voice');
  await post('/api/characters', { name: 'Mute Mo' });

  let r = await post('/api/generate', { kind: 'voice', prompt: 'Nora: hi\nMute Mo: …' });
  expect(r.status).toBe(400);
  expect(r.body.error).toBe('Mute Mo has no voice yet. Give them one in the Cast tab.');

  r = await post('/api/generate', { kind: 'voice', prompt: 'Once upon a time.\nNora: hi' });
  expect(r.status).toBe(400);
  expect(r.body.error).toContain('Some lines have no speaker');

  r = await post('/api/generate', { kind: 'voice', prompt: 'Nobody to say this.' });
  expect(r.status).toBe(400);
  expect(r.body.error).toContain('Pick a voice first');

  r = await post('/api/generate', { kind: 'voice', prompt: 'x'.repeat(5001), voice: 'rachel', model: 'eleven_v3' });
  expect(r.status).toBe(400);
  expect(r.body.error).toContain('takes 5,000 at a time');

  r = await post('/api/generate', { kind: 'voice', prompt: '   ', voice: 'rachel' });
  expect(r.body.error).toBe('Write what should be said.');

  expect(calls.filter((c) => c.path !== '/v1/chat/completions')).toHaveLength(0);
});

test('over the account concurrency cap, a line waits its turn and the queue learns the cap', async () => {
  const saved = { ...ELEVEN_RETRY };
  Object.assign(ELEVEN_RETRY, { baseMs: 5, maxMs: 10 });
  try {
    busyFor = 2;
    const { body } = await post('/api/generate', { kind: 'voice', prompt: 'patience', voice: 'rachel', wait: 10 });
    expect(body.failed).toEqual([]);
    expect(body.items).toHaveLength(1);
    expect(upstreamCalls('/v1/text-to-speech/')).toHaveLength(3);
    // From now on, no more than the account allows are sent at once.
    expect((await getJson('/api/jobs')).body.limits.voice).toBe(3);
    expect((await getJson('/api/jobs')).body.limits.image).toBe(32);
  } finally {
    Object.assign(ELEVEN_RETRY, saved);
  }
});

test('an ElevenLabs rejection is a failed job with its reason', async () => {
  failVoice = true;
  const { body } = await post('/api/generate', { kind: 'voice', prompt: 'hi', voice: 'rachel', wait: 5 });
  expect(body.failed[0].error).toBe('401 Invalid API key');
});

// ---------- the voice library ----------

test('the voice menu lists the account, the cast and the live models — and caches them', async () => {
  await voiced('Nora', 'nora-voice');
  let { status, body } = await getJson('/api/voices');
  expect(status).toBe(200);
  expect(body.voices.map((v) => v.id)).toEqual(['mine1', 'rachel']);
  expect(body.cast).toEqual([{ id: 'nora', name: 'Nora', voice: { id: 'nora-voice', name: "Nora's voice" } }]);
  expect(body.models.map((m) => m.id)).toEqual(['eleven_v3', 'eleven_flash_v2_5']);

  await getJson('/api/voices');
  expect(upstreamCalls('/v2/voices')).toHaveLength(1);
  await getJson('/api/voices?refresh=1');
  expect(upstreamCalls('/v2/voices')).toHaveLength(2);

  // The live model list now drives planning, too.
  const r = await post('/api/generate', { kind: 'voice', prompt: 'x'.repeat(5001), voice: 'rachel', model: 'eleven_flash_v2_5' });
  expect(r.status).toBe(200);

  keys = {};
  ({ status, body } = await getJson('/api/voices'));
  expect(status).toBe(400);
  expect(body.error).toContain('ElevenLabs key');
});

test('a character is given a voice, keeps it through other edits, and can lose it', async () => {
  const { body } = await post('/api/characters', { name: 'Nora' });
  let r = await post('/api/characters/update', { id: 'nora', voice: { id: 'rachel', name: 'Rachel', source: 'library', previewUrl: 'https://el.example/rachel.mp3', junk: 1 } });
  expect(r.body.character.voice).toEqual({ id: 'rachel', name: 'Rachel', source: 'library', previewUrl: 'https://el.example/rachel.mp3' });

  // Renaming, re-describing and dropping a reference all rewrite the metadata.
  addRef(charRoot, 'nora', PNG);
  r = await post('/api/characters/update', { id: 'nora', name: 'Nora Vale', description: 'new' });
  expect(r.body.character.voice.id).toBe('rachel');
  deleteRef(charRoot, 'nora-vale', getCharacter(charRoot, 'nora-vale').refs[0]);
  expect(getCharacter(charRoot, 'nora-vale').voice.id).toBe('rachel');

  r = await post('/api/characters/update', { id: 'nora-vale', voice: { id: '../../etc', name: 'x' } });
  expect(r.status).toBe(400);
  r = await post('/api/characters/update', { id: 'nora-vale', voice: null });
  expect(r.body.character.voice).toBeNull();
  expect(body.character.voice).toBeNull();
});

test('a voice is designed from a description, auditioned, and kept for a character', async () => {
  await post('/api/characters', { name: 'Nora' });
  let r = await post('/api/voices/design', { description: 'short' });
  expect(r.status).toBe(400);

  r = await post('/api/voices/design', { description: 'a warm, husky alto in her thirties, Dublin accent, unhurried' });
  expect(r.body.previews).toHaveLength(3);
  expect(r.body.previews[0]).toMatchObject({ id: 'gen-1' });
  expect(r.body.previews[0].dataUrl).toStartWith('data:audio/mpeg;base64,');

  r = await post('/api/voices/save', { generatedVoiceId: 'gen-2', description: 'a warm, husky alto', characterId: 'nora' });
  expect(r.body.voice).toMatchObject({ id: 'designed-1', name: 'Nora', source: 'designed' });
  expect(r.body.character.voice).toMatchObject({ id: 'designed-1', source: 'designed', description: 'a warm, husky alto' });
  expect(upstreamCalls('/v1/text-to-voice').find((c) => c.path === '/v1/text-to-voice').body).toEqual({
    voice_name: 'Nora',
    voice_description: 'a warm, husky alto',
    generated_voice_id: 'gen-2'
  });
});

test('a voice is cloned from recordings and given to a character', async () => {
  await post('/api/characters', { name: 'Sam' });
  let r = await post('/api/voices/clone', { characterId: 'sam', samples: ['data:image/png;base64,AAAA'] });
  expect(r.status).toBe(400);
  expect(r.body.error).toContain('not an audio recording');

  r = await post('/api/voices/clone', { characterId: 'sam', samples: [{ dataUrl: 'data:audio/mpeg;base64,' + SPEECH.toString('base64'), name: 'take.mp3' }] });
  expect(r.body.character.voice).toMatchObject({ id: 'cloned-1', name: 'Sam', source: 'cloned' });
  expect(upstreamCalls('/v1/voices/add')[0].raw.toString('latin1')).toContain('filename="take.mp3"');
});

test('a voice can be auditioned without filing anything in the gallery', async () => {
  const r = await post('/api/voices/say', { voice: 'rachel', text: 'Testing, one two.', settings: { stability: 0.2 }, model: 'eleven_v3' });
  expect(r.body.dataUrl).toStartWith('data:audio/mpeg;base64,');
  expect(upstreamCalls('/v1/text-to-speech/rachel')[0].body).toEqual({ text: 'Testing, one two.', model_id: 'eleven_v3', voice_settings: { stability: 0 } });
  expect(listItems(root, '')).toHaveLength(0);
});

// ---------- the rest of the gallery, for audio ----------

test('the rewriter has a brief for each audio job', async () => {
  await voiced('Nora', 'nora-voice');
  const brief = async (body) => (await post('/api/enhance', { prompt: 'something to work with', ...body })).body.prompt;
  expect(await brief({ kind: 'song', model: 'google/lyria-3-pro-preview' })).toContain('You rewrite song ideas');
  expect(await brief({ kind: 'lyrics', model: 'google/lyria-3-clip-preview', context: 'sea shanty' })).toContain('You write song lyrics');
  expect(await brief({ kind: 'voice', model: 'eleven_v3' })).toContain('You direct text for the text-to-speech model');
  expect(await brief({ kind: 'voice-design' })).toContain('You write voice descriptions');

  const sys = (i) => calls.filter((c) => c.body?.messages?.[0]?.role === 'system')[i].body.messages[0].content;
  expect(sys(1)).toContain('30-second clips');
  expect(sys(1)).toContain('The music is: sea shanty.');
  expect(sys(2)).toContain('audio tags');

  // A script's speaker labels are named so the rewrite keeps them.
  await post('/api/enhance', { kind: 'voice', model: 'eleven_multilingual_v2', prompt: 'Nora: hi there' });
  const last = calls.filter((c) => c.body?.messages?.[0]?.role === 'system').pop().body.messages[0].content;
  expect(last).toContain('"Nora:"');
  expect(last).toContain('reads square brackets aloud');
});

test('reuse fills a song or a voice line from the last one', async () => {
  await post('/api/generate', { kind: 'song', prompt: 'first', model: 'google/lyria-3-clip-preview', vocals: 'choir', bpm: 90, wait: 10 });
  const song = await post('/api/generate', { reuse: true, prompt: 'second', wait: 10 });
  expect(song.body).toMatchObject({ kind: 'song', model: 'google/lyria-3-clip-preview', reused: { kind: 'song', model: 'google/lyria-3-clip-preview', vocals: 'choir', bpm: 90 } });

  await post('/api/generate', { kind: 'voice', prompt: 'one', voice: 'rachel', voiceName: 'Rachel', model: 'eleven_v3', wait: 10 });
  const line = await post('/api/generate', { reuse: true, prompt: 'two', wait: 10 });
  expect(line.body).toMatchObject({ kind: 'voice', model: 'eleven_v3', reused: { voice: 'rachel' } });
  expect(line.body.failed).toEqual([]);
});

test('a batch mixes songs and voice lines with everything else', async () => {
  const { body } = await post('/api/batch', {
    defaults: { folder: '' },
    items: [
      { kind: 'song', prompt: 'a jingle', model: 'google/lyria-3-clip-preview', count: 2 },
      { kind: 'voice', prompt: 'and now, the news', voice: 'rachel' }
    ],
    wait: 10
  });
  expect(body).toMatchObject({ count: 3, songs: 2, voices: 1, settled: true });
  expect(listItems(root, '').map((i) => i.kind).sort()).toEqual(['song', 'song', 'voice']);

  const models = await getJson('/api/models?kind=voice&sort=cost');
  expect(models.body.models[0]).toMatchObject({ kind: 'voice', credits: 0.5 });
  expect((await getJson('/api/models?kind=music')).status).toBe(400);
});
