import { afterEach, beforeEach, expect, test } from 'bun:test';
import http from 'node:http';
import {
  AUDIO_APIS,
  concurrencyCap,
  envKeyOf,
  audioDuration,
  audioExt,
  buildSongPrompt,
  cloneVoice,
  designVoice,
  generateSong,
  listVoices,
  mapOpenRouterSongModels,
  mapVoiceModels,
  parseScript,
  plainRead,
  saveDesignedVoice,
  songPricing,
  textToDialogue,
  textToSpeech,
  voiceSettings
} from './justimagine-audio.js';
import { fakeMp3 } from './audio.fixture.js';

function fakeWav(seconds = 1.5) {
  const rate = 8000;
  const data = Buffer.alloc(Math.round(seconds * rate * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ---------- files ----------

test('an audio buffer is named by what it is, not what anyone claimed', () => {
  expect(audioExt(fakeMp3())).toBe('mp3');
  expect(audioExt(fakeMp3(1, { id3: false }))).toBe('mp3');
  expect(audioExt(fakeWav())).toBe('wav');
  expect(audioExt(Buffer.from('fLaC' + '\0'.repeat(20)))).toBe('flac');
  expect(audioExt(Buffer.from('OggS' + '\0'.repeat(20)))).toBe('ogg');
  expect(audioExt(Buffer.from('\0\0\0\x20ftypM4A ' + '\0'.repeat(20), 'latin1'))).toBe('m4a');
});

test('a clip knows how long it is without being decoded', () => {
  expect(audioDuration(fakeMp3(3))).toBeCloseTo(3, 0);
  expect(audioDuration(fakeMp3(10, { id3: false }))).toBeCloseTo(10, 0);
  expect(audioDuration(fakeWav(1.5))).toBe(1.5);
  // Something that is not audio at all is unknown, not zero.
  expect(audioDuration(Buffer.from('not audio at all, just some text that goes on for a while longer'))).toBeNull();
  expect(audioDuration(null)).toBeNull();
});

test('an encoder frame count wins over the bitrate estimate', () => {
  const mp3 = fakeMp3(1, { id3: false });
  // A Xing header in the first frame, 32 bytes after the frame header (stereo MPEG-1).
  mp3.write('Xing', 4 + 32, 'latin1');
  mp3.writeUInt32BE(1, 4 + 32 + 4); // flags: frame count present
  mp3.writeUInt32BE(2297, 4 + 32 + 8); // ≈ 60 seconds of frames
  expect(audioDuration(mp3)).toBeCloseTo(60, 0);
});

// ---------- songs ----------

test('a song model is priced from the words OpenRouter prices it in', () => {
  expect(songPricing('Full-length songs are priced at $0.08 per song. Lyria 3 is…')).toMatchObject({ perSong: 0.08 });
  expect(songPricing('30 second duration clips are priced at $0.04 per clip.')).toMatchObject({ perClip: 0.04, clipSeconds: 30 });
  expect(songPricing('A model with no price in its blurb')).toBeUndefined();
});

test('the song catalogue keeps music models and leaves the talking ones out', () => {
  const models = mapOpenRouterSongModels([
    {
      id: 'google/lyria-3-clip-preview',
      name: 'Google: Lyria 3 Clip Preview',
      created: 10,
      description: '30 second duration clips are priced at $0.04 per clip.',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'audio'] },
      supported_parameters: ['seed']
    },
    {
      id: 'google/lyria-4-preview',
      name: 'Google: Lyria 4',
      created: 20,
      description: 'Songs are $0.12 per song.',
      architecture: { input_modalities: ['text'], output_modalities: ['audio'] },
      supported_parameters: []
    },
    { id: 'openai/gpt-audio', name: 'OpenAI: GPT Audio', architecture: { input_modalities: ['text', 'audio'], output_modalities: ['text', 'audio'] } },
    { id: 'some/music-but-text-only', architecture: { output_modalities: ['text'] } }
  ]);
  expect(models.map((m) => m.id)).toEqual(['google/lyria-4-preview', 'google/lyria-3-clip-preview']);
  expect(models[0]).toMatchObject({ kind: 'song', pricing: { perSong: 0.12 }, full: true, images: false, seed: false });
  expect(models[1]).toMatchObject({ pricing: { perClip: 0.04 }, clipSeconds: 30, images: true, seed: true });
  expect(mapOpenRouterSongModels(null)).toEqual([]);
});

test('lyrics, vocals, tempo and length ride inside the one prompt a music model takes', () => {
  const text = buildSongPrompt({
    prompt: 'dreamy synth-pop about a night drive',
    lyrics: '[Verse]\nNeon on the windscreen',
    vocals: 'breathy female lead',
    bpm: 104,
    length: 'medium'
  });
  expect(text).toContain('dreamy synth-pop about a night drive');
  expect(text).toContain('Tempo: around 104 BPM.');
  expect(text).toContain('about two minutes');
  expect(text).toContain('Vocals: breathy female lead.');
  expect(text).toContain('Lyrics:\n[Verse]\nNeon on the windscreen');
});

test('an instrumental drops the words and the singer, and says so', () => {
  const text = buildSongPrompt({ prompt: 'lo-fi beat', lyrics: 'la la', vocals: 'tenor', instrumental: true, bpm: 5000 });
  expect(text).toContain('Instrumental only');
  expect(text).not.toContain('la la');
  expect(text).not.toContain('tenor');
  expect(text).not.toContain('BPM'); // out of range is ignored rather than sent
});

// A local stand-in for OpenRouter's chat completions, speaking SSE the way
// Lyria does: the song arrives as base64 in delta.audio.data, words in content.
let upstream;
let base;
let reply = null;
let seen = [];

beforeEach(async () => {
  seen = [];
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, headers: req.headers, raw, body: (() => { try { return JSON.parse(raw.toString()); } catch { return null; } })() });
    await reply(req, res, seen[seen.length - 1]);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${upstream.address().port}`;
  process.env.JUSTIMAGINE_ELEVENLABS_URL = base;
});

afterEach(async () => {
  delete process.env.JUSTIMAGINE_ELEVENLABS_URL;
  await new Promise((r) => upstream.close(r));
});

const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write(typeof f === 'string' ? f : `data: ${JSON.stringify(f)}\n\n`);
  res.end('data: [DONE]\n\n');
};

test('a song streams back whole, with its lyrics and its cost', async () => {
  const song = fakeMp3(2);
  const b64 = song.toString('base64');
  reply = (req, res) =>
    sse(res, [
      { choices: [{ delta: { role: 'assistant', content: '[Verse]\nNeon on the ' } }] },
      ': OPENROUTER PROCESSING\n\n',
      { choices: [{ delta: { content: 'windscreen', audio: { data: b64.slice(0, 100) } } }] },
      { choices: [{ delta: { audio: { data: b64.slice(100) } }, finish_reason: 'stop' }], usage: { cost: 0.04 } }
    ]);
  const out = await generateSong({ chatUrl: `${base}/v1/chat/completions`, apiKey: 'k', model: 'google/lyria-3-clip-preview', prompt: 'synth-pop', seed: 7 });
  expect(out.buf.equals(song)).toBe(true);
  expect(out.ext).toBe('mp3');
  expect(out.lyrics).toBe('[Verse]\nNeon on the windscreen');
  expect(out.cost).toBe(0.04);
  const sent = seen[0];
  expect(sent.headers.authorization).toBe('Bearer k');
  expect(sent.body).toMatchObject({ model: 'google/lyria-3-clip-preview', modalities: ['text', 'audio'], stream: true, seed: 7 });
});

test('an instrumental marker is not lyrics, and an image rides along as vision input', async () => {
  reply = (req, res) => sse(res, [{ choices: [{ delta: { content: '<instrumental>', audio: { data: fakeMp3(1).toString('base64') } } }] }]);
  const out = await generateSong({ chatUrl: base, apiKey: 'k', model: 'm', prompt: 'p', images: [{ dataUrl: 'data:image/png;base64,AAAA' }] });
  expect(out.lyrics).toBe('');
  expect(seen[0].body.messages[0].content).toEqual([
    { type: 'text', text: 'p' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  ]);
});

test('a song that fails says why — upstream errors, mid-stream errors and silence alike', async () => {
  reply = (req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'out of credit' } }));
  };
  await expect(generateSong({ chatUrl: base, apiKey: 'k', model: 'm', prompt: 'p' })).rejects.toThrow('402 out of credit');

  reply = (req, res) => sse(res, [{ error: { message: 'Provider returned error' } }]);
  await expect(generateSong({ chatUrl: base, apiKey: 'k', model: 'm', prompt: 'p' })).rejects.toThrow('Provider returned error');

  reply = (req, res) => sse(res, [{ choices: [{ delta: { content: 'I cannot make that song.' }, finish_reason: 'stop' }] }]);
  await expect(generateSong({ chatUrl: base, apiKey: 'k', model: 'm', prompt: 'p' })).rejects.toThrow('without a song: I cannot make that song.');
});

test('a provider that ignores streaming and answers in JSON still yields the song', async () => {
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'la la', audio: { data: fakeMp3(1).toString('base64') } } }], usage: { cost: 0.08 } }));
  };
  const out = await generateSong({ chatUrl: base, apiKey: 'k', model: 'm', prompt: 'p' });
  expect(out.ext).toBe('mp3');
  expect(out.lyrics).toBe('la la');
  expect(out.cost).toBe(0.08);
});

// ---------- voices ----------

test('a script is split by cast name; any other colon is just a colon', () => {
  const cast = [
    { id: 'nora', name: 'Nora', voice: { id: 'v1' } },
    { id: 'sam-2', name: 'Sam Reyes', voice: { id: 'v2' } }
  ];
  const { lines, speakers } = parseScript(
    'It was late.\nNora: Where were you?\n@Sam Reyes (quietly): Out.\nNote: that is all he said.\nsam-2: And then\nI left.',
    cast
  );
  expect(speakers.map((c) => c.name)).toEqual(['Nora', 'Sam Reyes']);
  expect(lines).toEqual([
    { speaker: null, text: 'It was late.' },
    { speaker: cast[0], text: 'Where were you?' },
    { speaker: cast[1], text: 'Out. Note: that is all he said.' },
    { speaker: cast[1], text: 'And then I left.' }
  ]);
});

test('plain text with no cast lines is not a script', () => {
  const { lines, speakers } = parseScript('Welcome back.\nToday: the weather.', [{ id: 'nora', name: 'Nora' }]);
  expect(speakers).toEqual([]);
  expect(lines).toEqual([{ speaker: null, text: 'Welcome back. Today: the weather.' }]);
  expect(plainRead('Say hi to @Nora and @nora.', [{ id: 'nora', name: 'Nora' }])).toBe('Say hi to Nora and Nora.');
});

test('an ElevenLabs key is found under either spelling of its variable', () => {
  const el = AUDIO_APIS.find((a) => a.id === 'elevenlabs');
  expect(envKeyOf(el, { ELEVENLABS_API_KEY: 'a' })).toEqual({ key: 'a', name: 'ELEVENLABS_API_KEY' });
  expect(envKeyOf(el, { ELEVEN_LABS_API_KEY: 'b' })).toEqual({ key: 'b', name: 'ELEVEN_LABS_API_KEY' });
  expect(envKeyOf(el, {})).toEqual({ key: '', name: '' });
});

test('delivery settings are sent in ElevenLabs terms, and only when set', () => {
  expect(voiceSettings({})).toBeUndefined();
  expect(voiceSettings({ stability: 0.3, similarity: '0.8', style: 2, speed: 3, speakerBoost: true }, 'eleven_multilingual_v2')).toEqual({
    stability: 0.3,
    similarity_boost: 0.8,
    style: 1,
    speed: 1.2,
    use_speaker_boost: true
  });
  // Eleven v3 has three stability steps: Creative, Natural, Robust.
  expect(voiceSettings({ stability: 0.1 }, 'eleven_v3')).toEqual({ stability: 0 });
  expect(voiceSettings({ stability: 0.6 }, 'eleven_v3')).toEqual({ stability: 0.5 });
  expect(voiceSettings({ stability: 0.9 }, 'eleven_v3')).toEqual({ stability: 1 });
});

test('speech goes to the voice named, with the key, format and settings asked for', async () => {
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-character-count': '11', 'request-id': 'req-1' });
    res.end(fakeMp3(1));
  };
  const out = await textToSpeech({ apiKey: 'el-key', voiceId: 'voice-1', text: 'Hello there', model: 'eleven_v3', settings: { stability: 0.5 }, language: 'en', seed: '42' });
  expect(out).toMatchObject({ ext: 'mp3', characters: 11, requestId: 'req-1' });
  const sent = seen[0];
  expect(sent.url).toBe('/v1/text-to-speech/voice-1?output_format=mp3_44100_128');
  expect(sent.headers['xi-api-key']).toBe('el-key');
  expect(sent.body).toEqual({ text: 'Hello there', model_id: 'eleven_v3', voice_settings: { stability: 0.5 }, language_code: 'en', seed: 42 });
});

test('a dialogue sends every line with its own voice, in order', async () => {
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(fakeMp3(1));
  };
  await textToDialogue({ apiKey: 'k', lines: [{ text: 'Hi.', voiceId: 'a' }, { text: 'Hey.', voiceId: 'b' }], stability: 0.9 });
  expect(seen[0].url).toBe('/v1/text-to-dialogue?output_format=mp3_44100_128');
  expect(seen[0].body).toEqual({
    inputs: [{ text: 'Hi.', voice_id: 'a' }, { text: 'Hey.', voice_id: 'b' }],
    model_id: 'eleven_v3',
    settings: { stability: 1 }
  });
});

test('ElevenLabs errors come back readable, whatever shape they take', async () => {
  reply = (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }));
  };
  await expect(textToSpeech({ apiKey: 'bad', voiceId: 'v', text: 'x' })).rejects.toThrow('401 Invalid API key');
  reply = (req, res) => {
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: [{ msg: 'text too long' }] }));
  };
  await expect(textToSpeech({ apiKey: 'k', voiceId: 'v', text: 'x' })).rejects.toThrow('422 text too long');
  await expect(textToSpeech({ apiKey: 'k', voiceId: '', text: 'x' })).rejects.toThrow('Pick a voice');
});

const BUSY = { detail: { status: 'too_many_concurrent_requests', message: 'Too many concurrent requests. Your current subscription is associated with a maximum of 3 concurrent requests (running in parallel).' } };
const FAST = { baseMs: 5, maxMs: 10, maxWaitMs: 2000 };

test('a request over the account concurrency cap waits for a slot instead of failing', async () => {
  let n = 0;
  reply = (req, res) => {
    if (++n <= 2) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(BUSY));
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(fakeMp3(1));
  };
  const busy = [];
  const out = await textToSpeech({ apiKey: 'k', voiceId: 'v', text: 'hi', retry: FAST, onBusy: (b) => busy.push(b) });
  expect(out.ext).toBe('mp3');
  expect(seen).toHaveLength(3);
  // the same request each time, body included
  expect(seen.every((c) => c.body?.text === 'hi')).toBe(true);
  expect(busy.map((b) => b.attempt)).toEqual([1, 2]);
  expect(busy[0].cap).toBe(3);
  expect(concurrencyCap('no number here')).toBeNull();
});

test('waiting for a slot gives up eventually, and at once when cancelled', async () => {
  reply = (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify(BUSY));
  };
  await expect(textToSpeech({ apiKey: 'k', voiceId: 'v', text: 'hi', retry: { baseMs: 20, maxMs: 20, maxWaitMs: 50 } })).rejects.toThrow('429 Too many concurrent requests');

  const ctrl = new AbortController();
  const pending = textToSpeech({ apiKey: 'k', voiceId: 'v', text: 'hi', signal: ctrl.signal, retry: { baseMs: 60_000, maxMs: 60_000, maxWaitMs: 600_000 }, onBusy: () => setTimeout(() => ctrl.abort(), 10) });
  const started = Date.now();
  await expect(pending).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(5000);
});

test('the voice library is read a page at a time, your own voices first', async () => {
  reply = (req, res) => {
    const page2 = req.url.includes('next_page_token=p2');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        page2
          ? { voices: [{ voice_id: 'c', name: 'Adam', category: 'premade', preview_url: 'https://x/c.mp3' }], has_more: false }
          : {
              voices: [
                { voice_id: 'a', name: 'Zed', category: 'cloned', labels: { gender: 'male', accent: 'british' } },
                { voice_id: 'b', name: 'Aria', category: 'premade', labels: { use_case: 'narrative_story' } }
              ],
              has_more: true,
              next_page_token: 'p2'
            }
      )
    );
  };
  const voices = await listVoices({ apiKey: 'k' });
  expect(voices.map((v) => v.id)).toEqual(['a', 'c', 'b']);
  expect(voices[0]).toMatchObject({ name: 'Zed', labels: ['male', 'british'] });
  expect(voices[2].labels).toEqual(['narrative story']);
  expect(voices[1].previewUrl).toBe('https://x/c.mp3');
  expect(seen).toHaveLength(2);
});

test('only speech models make the model list, known ones first with their credits', () => {
  const models = mapVoiceModels([
    { model_id: 'eleven_english_sts_v2', can_do_text_to_speech: false },
    { model_id: 'eleven_multilingual_ttv_v2', can_do_text_to_speech: true },
    { model_id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', can_do_text_to_speech: true, model_rates: { character_cost_multiplier: 0.5 }, languages: [{}, {}] },
    { model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true, model_rates: { character_cost_multiplier: 1 } }
  ]);
  expect(models.map((m) => m.id)).toEqual(['eleven_v3', 'eleven_flash_v2_5']);
  expect(models[0]).toMatchObject({ credits: 1, dialogue: true, tags: true });
  expect(models[1]).toMatchObject({ credits: 0.5, languages: 2 });
});

test('a designed voice is auditioned first, then kept under a name', async () => {
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/v1/text-to-voice/design')) {
      res.end(JSON.stringify({ previews: [{ generated_voice_id: 'g1', audio_base_64: 'QUJD', media_type: 'audio/mpeg', duration_secs: 4.2 }], text: 'auto text' }));
    } else {
      res.end(JSON.stringify({ voice_id: 'new-voice', name: 'Nora', preview_url: 'https://x/p.mp3' }));
    }
  };
  await expect(designVoice({ apiKey: 'k', description: 'too short' })).rejects.toThrow('at least 20 characters');
  const design = await designVoice({ apiKey: 'k', description: 'a warm, husky alto in her thirties with a Dublin accent' });
  expect(design).toEqual({ previews: [{ id: 'g1', dataUrl: 'data:audio/mpeg;base64,QUJD', duration: 4.2 }], text: 'auto text' });
  expect(seen[0].body).toMatchObject({ model_id: 'eleven_multilingual_ttv_v2', auto_generate_text: true });

  const saved = await saveDesignedVoice({ apiKey: 'k', generatedVoiceId: 'g1', name: 'Nora', description: 'warm alto' });
  expect(saved).toMatchObject({ id: 'new-voice', name: 'Nora', previewUrl: 'https://x/p.mp3' });
  expect(seen[1].body).toEqual({ voice_name: 'Nora', voice_description: 'warm alto', generated_voice_id: 'g1' });
});

test('a clone uploads its recordings as multipart files', async () => {
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ voice_id: 'clone-1', requires_verification: false }));
  };
  await expect(cloneVoice({ apiKey: 'k', name: 'Sam' })).rejects.toThrow('at least one recording');
  const out = await cloneVoice({ apiKey: 'k', name: 'Sam', samples: [{ buf: fakeMp3(1), type: 'audio/mpeg', name: 'take1.mp3' }], removeNoise: true });
  expect(out).toMatchObject({ id: 'clone-1', name: 'Sam', category: 'cloned' });
  expect(seen[0].url).toBe('/v1/voices/add');
  expect(seen[0].headers['content-type']).toContain('multipart/form-data');
  const text = seen[0].raw.toString('latin1');
  expect(text).toContain('name="name"');
  expect(text).toContain('filename="take1.mp3"');
  expect(text).toContain('name="remove_background_noise"');
});
