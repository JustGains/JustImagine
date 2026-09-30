import { EXT_BY_TYPE } from './justimagine-store.js';
import { modelKey } from './model-info.js';
import { parseStoryboard, storyboardRequest, TRANSCRIBE_MODEL } from './music-video-plan.js';

// Upstream calls for both media kinds.
//
//   image  — OpenAI-shaped /images/generations and /images/edits, plus the
//            "chat-routed" models (Gemini and friends) that aggregators serve
//            through /chat/completions with the picture embedded in the reply.
//   video  — OpenRouter's asynchronous /api/v1/videos: submit, poll, download.
//
// Nothing here touches the filesystem; callers hand in decoded reference images
// and get a buffer back.

// ---------- image APIs ----------

// Keys are shared with the chat provider of the same id, so a saved yunwu key
// just works. Users extend this via `imageApis` in ~/.bro/config.json.
export const IMAGE_APIS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    // Legacy image models use chat; newer models use the dedicated Images API.
    // The live catalogue extends this explicit list on selection.
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    unifiedImagesUrl: 'https://openrouter.ai/api/v1/images',
    chatBody: { modalities: ['image', 'text'] },
    keyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    video: true,
    models: [
      { id: 'openai/gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare', via: 'images' },
      { id: 'google/gemini-3.1-flash-image', name: 'Nano Banana 2 (Gemini 3.1 Flash Image)', via: 'chat' },
      { id: 'google/gemini-3-pro-image', name: 'Nano Banana Pro (Gemini 3 Pro Image)', via: 'chat' },
      { id: 'openai/gpt-5.4-image-2', name: 'GPT-5.4 Image 2', via: 'chat' }
    ]
  },
  {
    id: 'yunwu',
    name: 'Yunwu (云雾)',
    imagesUrl: 'https://yunwu.ai/v1/images/generations',
    keyEnv: 'YUNWU_API_KEY',
    keyUrl: 'https://yunwu.ai',
    models: [
      { id: 'gpt-image-2', name: 'GPT Image 2' },
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image', via: 'chat' },
      { id: 'dall-e-3', name: 'DALL·E 3' }
    ]
  },
  {
    // A new-api relay like Yunwu. Its public pricing catalogue replaces this
    // list at start-up (see openlux.js); these keep it usable offline.
    id: 'openlux',
    name: 'OpenLux',
    imagesUrl: 'https://api.openlux.ai/v1/images/generations',
    chatUrl: 'https://api.openlux.ai/v1/chat/completions',
    keyEnv: 'OPENLUX_API_KEY',
    keyUrl: 'https://api.openlux.ai',
    video: true,
    models: [
      { id: 'gpt-image-2-c', name: 'gpt-image-2-c', via: 'images' },
      { id: 'gemini-3.1-flash-image', name: 'gemini-3.1-flash-image', via: 'chat' },
      { id: 'gemini-3-pro-image', name: 'gemini-3-pro-image', via: 'chat' },
      { id: 'doubao-seedream-5-0-260128', name: 'doubao-seedream-5-0-260128', via: 'images' }
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    imagesUrl: 'https://api.openai.com/v1/images/generations',
    keyEnv: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      { id: 'dall-e-3', name: 'DALL·E 3' }
    ]
  }
];

// A one-line note for the models OpenRouter's catalogue cannot describe for us
// — the first-party Images API models that aggregators also serve. Keyed by
// normalised id so every provider offering the same model gets the same note,
// and only used when neither the model entry nor the catalogue has anything:
// a custom API in config.json can give its models a `description` of its own.
export const MODEL_NOTES = {
  gptimage2: "OpenAI's second-generation Images API model, succeeding GPT Image 1. Takes the size and quality knobs.",
  gptimage1: "OpenAI's Images API model: close prompt following and legible text in the picture. Supports edits and takes the size and quality knobs.",
  dalle3: "OpenAI's DALL·E 3. It expands a short prompt into a more detailed one before drawing, which suits illustration and stylised work. Takes the size and quality knobs."
};

// Published per-image prices for the same models. OpenRouter's catalogue is
// where every other price in the picker comes from, but it does not list the
// first-party Images API models at all — so without this, choosing between
// DALL·E 3 and GPT Image 1 means comparing two blank cells. A price per
// picture only means something alongside the size and quality it assumes, so
// each carries the basis it was quoted at and who quoted it.
//
// These are list prices and they do move: check them against
// https://openai.com/api/pricing/ when they look wrong. Anything not listed
// here stays blank rather than guessed — the picker says so plainly.
export const MODEL_PRICING = {
  gptimage1: { perImage: 0.04, basis: '1024×1024, medium quality', source: 'OpenAI list price' },
  dalle3: { perImage: 0.04, basis: '1024×1024, standard quality', source: 'OpenAI list price' }
};

// A model entry filled out with whatever we know about it that the live
// catalogue cannot supply. The entry's own fields always win, so a custom API in
// config.json can state its real price and override ours.
function withKnown(model) {
  if (!model?.id) return model;
  const key = modelKey(model.id);
  const note = MODEL_NOTES[key];
  const pricing = MODEL_PRICING[key];
  const out = { ...model };
  if (note && !out.description) out.description = note;
  if (pricing && !out.pricing) out.pricing = { ...pricing };
  return out;
}

export function mergeImageApis(configApis = []) {
  const apis = IMAGE_APIS.map((a) => ({ ...a, models: a.models.map(withKnown) }));
  const byId = new Map(apis.map((a) => [a.id, a]));
  for (const c of configApis) {
    if (!c || !c.id) continue;
    const existing = byId.get(c.id);
    if (existing) {
      for (const f of ['imagesUrl', 'unifiedImagesUrl', 'chatUrl', 'chatBody', 'editsUrl', 'keyEnv', 'keyUrl', 'name', 'video']) {
        if (c[f] != null) existing[f] = c[f];
      }
      for (const m of c.models || []) existing.models.push(withKnown(m));
    } else {
      const np = { ...c, models: (c.models || []).map(withKnown) };
      apis.push(np);
      byId.set(np.id, np);
    }
  }
  return apis;
}

// ---------- shared http helpers ----------

export async function readApiResponse(res) {
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 500);
    try {
      msg = JSON.parse(text).error?.message || msg;
    } catch {
      /* keep raw */
    }
    throw new Error(`${res.status} ${msg}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Upstream returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function postJson(url, apiKey, body, signal) {
  return readApiResponse(
    await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    })
  );
}

// multipart POST — fetch sets the boundary header from the FormData itself.
async function postForm(url, apiKey, form, signal) {
  return readApiResponse(await fetch(url, { method: 'POST', signal, headers: { authorization: `Bearer ${apiKey}` }, body: form }));
}

export async function download(url, signal, headers = {}) {
  const res = await fetch(url, { signal, headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const fromUrl = (url.split('?')[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1];
  const ext = EXT_BY_TYPE[type] || (fromUrl ? fromUrl.toLowerCase() : '') || 'bin';
  return { buf: Buffer.from(await res.arrayBuffer()), ext };
}

function decodeDataUrl(url) {
  const m = String(url).match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/is);
  if (!m) return null;
  return { buf: Buffer.from(m[2], 'base64'), ext: EXT_BY_TYPE[m[1].toLowerCase()] || 'png' };
}

// ---------- images ----------

function chatUrlOf(api) {
  return api.chatUrl || api.imagesUrl.replace(/\/images\/generations\/?$/, '/chat/completions');
}

// Reference images go to the edits endpoint (multipart) instead of generations.
function editsUrlOf(api) {
  return api.editsUrl || api.imagesUrl.replace(/\/generations\/?$/, '/edits');
}

// The image families that answer over chat completions. Everything else an
// aggregator serves — GPT Image, Flux, Recraft, Seedream — is Images API only.
const CHAT_IMAGE_FAMILY = /gemini|flash-image|banana|gpt-\d[\w.]*-image/i;

// Whether `model` goes over chat completions rather than an Images API.
export function usesChatApi(api, model) {
  const known = (api.models || []).find((m) => m.id === model);
  if (api.unifiedImagesUrl) {
    if (known?.via) return known.via !== 'images';
    // A typed-in id, or a catalogue row that did not say: only the chat-native
    // families belong on chat — sending GPT Image there is a 404.
    return CHAT_IMAGE_FAMILY.test(model);
  }
  if (!api.imagesUrl) return true; // chat-only API
  if (known) return known.via === 'chat';
  return /gemini|flash-image|banana/i.test(model);
}

// OpenRouter's answer when an Images API model is sent to chat completions.
const isImagesOnlyRefusal = (message) => /image generation model and cannot be used with/i.test(String(message || ''));

async function imageFromData(data, signal) {
  if (!data) throw new Error('Empty response (no data[0])');
  if (data.b64_json) return { buf: Buffer.from(data.b64_json, 'base64'), ext: 'png', revisedPrompt: data.revised_prompt };
  if (data.url) return { ...(await download(data.url, signal)), revisedPrompt: data.revised_prompt };
  throw new Error('Response had neither b64_json nor url');
}

// One image. Concurrency comes from the browser firing several of these at
// once, so n is always 1 here.
export async function generateImage({ api, apiKey, prompt, model, size, quality, refs = [], signal }) {
  const viaImagesApi = async () => {
    const body = { model, prompt, n: 1 };
    if (size && size !== 'auto') body.size = size;
    if (quality && quality !== 'auto') body.quality = quality;
    if (refs.length) body.input_references = refs.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } }));
    const json = await postJson(api.unifiedImagesUrl, apiKey, body, signal);
    return { ...(await imageFromData(json.data?.[0], signal)), cost: json.usage?.cost };
  };
  if (api.unifiedImagesUrl && !usesChatApi(api, model)) return viaImagesApi();
  if (usesChatApi(api, model)) {
    // A model we guessed wrong about says so; take it at its word, once.
    if (api.unifiedImagesUrl) {
      try {
        return await chatImage();
      } catch (e) {
        if (isImagesOnlyRefusal(e.message)) return viaImagesApi();
        throw e;
      }
    }
    return chatImage();
  }
  return imagesEndpoint();

  async function chatImage() {
    // size/quality knobs don't exist on the chat path — steer with the prompt.
    const userContent = refs.length
      ? [{ type: 'text', text: prompt }, ...refs.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } }))]
      : prompt;
    const json = await postJson(
      chatUrlOf(api),
      apiKey,
      { model, messages: [{ role: 'user', content: userContent }], ...(api.chatBody || {}) },
      signal
    );
    const msg = json.choices?.[0]?.message || {};
    const fromImages = msg.images?.[0]?.image_url?.url || msg.images?.[0]?.url;
    const content = typeof msg.content === 'string' ? msg.content : '';
    const dataUrl = fromImages || content.match(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/i)?.[0];
    if (dataUrl) return decodeDataUrl(dataUrl) || (await download(dataUrl, signal));
    const httpUrl = content.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)?.[1];
    if (httpUrl) return await download(httpUrl, signal);
    throw new Error('Model replied without an image: ' + (content.slice(0, 200) || JSON.stringify(json).slice(0, 200)));
  }

  // An OpenAI-shaped /images/generations API, or /images/edits with references.
  async function imagesEndpoint() {
    if (refs.length) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      if (size && size !== 'auto') form.append('size', size);
      if (quality && quality !== 'auto') form.append('quality', quality);
      // gpt-image models take multiple references via image[]; a single one stays
      // `image` for compatibility with stricter backends.
      const field = refs.length > 1 ? 'image[]' : 'image';
      refs.forEach((im, i) => form.append(field, new Blob([im.buf], { type: im.type }), `ref-${i}.${im.ext}`));
      const json = await postForm(editsUrlOf(api), apiKey, form, signal);
      return await imageFromData(json.data?.[0], signal);
    }

    const body = { model, prompt, n: 1 };
    if (size && size !== 'auto') body.size = size;
    if (quality && quality !== 'auto') body.quality = quality;
    const json = await postJson(api.imagesUrl, apiKey, body, signal);
    return await imageFromData(json.data?.[0], signal);
  }
}

// ---------- prompt enhancement ----------

// A one-line idea is rarely what a generation model wants. This rewrites it
// into something specific — subject, framing, light, and for video what
// actually moves — using a fast text model on the same OpenRouter key the rest
// of JustImagine uses.
export const ENHANCE_MODEL = 'google/gemini-3.7-flash';
// Resolved per call rather than at import, so pointing this at a proxy takes
// effect without restarting a long-running service.
export const enhanceUrl = () => process.env.JUSTIMAGINE_CHAT_URL || 'https://openrouter.ai/api/v1/chat/completions';

const RULES = [
  'Return ONLY the rewritten prompt. No preamble, no quotes, no markdown, no explanation, no options.',
  'Keep the user\'s subject and intent exactly. Add specificity; never substitute a different scene.',
  'Write flowing descriptive prose, not a comma-separated keyword dump, and never pad with "8k, masterpiece, trending on artstation" filler.',
  'Do not mention aspect ratio, resolution, duration or file format. Those are separate controls.'
];

export function enhanceSystemPrompt({ kind = 'image', model = '', spec = null, characters = [], refs = 0, context = '' } = {}) {
  const audio = audioSystemPrompt({ kind, model, spec, characters, refs, context });
  if (audio) return audio;
  // A character description is not a scene: it is the fixed part of a person
  // that has to read the same in every shot they appear in.
  if (kind === 'character') {
    return [
      'You rewrite a character description for an image and video generation tool.',
      'The description is reused in every prompt this character appears in, so it must cover only what stays the same about them.',
      '',
      'Rules:',
      ...RULES.slice(0, 3).map((r) => `- ${r}`),
      '- Cover apparent age, build, face, hair, skin, and signature clothing, in that order, as one flowing phrase.',
      '- Describe only the permanent look. No pose, no location, no lighting, no action, no camera, no mood: those belong to the individual prompt.',
      '- Do not give them a name; the tool supplies that separately.',
      '- Keep it under about 45 words, lower case, no trailing full stop, so it reads naturally inside a longer sentence.'
    ].join('\n');
  }

  const lines = [
    `You rewrite prompts for the ${kind === 'video' ? 'text-to-video' : 'text-to-image'} model "${model || 'unknown'}".`,
    '',
    'Rules:',
    ...RULES.map((r) => `- ${r}`)
  ];

  if (kind === 'video') {
    lines.push(
      '- Describe one continuous shot: what the camera does, what the subject does, and how the scene changes from start to end.',
      '- Name the camera move explicitly (locked off, slow push in, handheld follow, orbit, crane down).',
      '- Keep it under about 110 words. One paragraph.'
    );
    if (spec?.audio === false) lines.push('- This model produces no audio, so do not describe sound.');
    if (spec && Array.isArray(spec.durations) && spec.durations.length) {
      lines.push(`- The clip is short (${spec.durations[0]}–${spec.durations[spec.durations.length - 1]} seconds), so describe one beat, not a sequence of events.`);
    }
  } else {
    lines.push(
      '- Cover subject, composition and framing, lighting, colour and mood, and material or surface detail.',
      '- Keep it under about 80 words. One paragraph.'
    );
  }

  if (characters.length) {
    const names = characters.map((c) => c.name || c).join(', ');
    lines.push(
      `- ${names} ${characters.length === 1 ? 'is a saved character whose' : 'are saved characters whose'} appearance comes from attached reference images. Keep ${characters.length === 1 ? 'the name' : 'the names'} exactly as written and do NOT invent or restate ${characters.length === 1 ? 'their' : 'their'} face, hair, age or clothing. Describe only what they are doing and where.`
    );
  }
  if (refs) {
    lines.push(`- ${refs} reference image${refs === 1 ? '' : 's'} will be attached, so describe the scene rather than restating what the reference already shows.`);
  }
  return lines.join('\n');
}

// The audio kinds each rewrite something different, so each gets its own brief:
//
//   song          a song idea → what a music model needs: genre, instruments,
//                 tempo feel, production, and the voice that sings it
//   lyrics        an idea (or a draft) → singable lyrics with section markers
//   voice         a line or a script → the same words, directed for delivery
//   voice-design  a character's description → how that character sounds
//
// Returns '' for the picture kinds, which enhanceSystemPrompt handles itself.
export const AUDIO_ENHANCE_KINDS = ['song', 'lyrics', 'voice', 'voice-design'];

function audioSystemPrompt({ kind, model, spec, characters = [], refs = 0, context = '' }) {
  const only = '- Return ONLY the result. No preamble, no quotes, no markdown, no explanation, no options.';
  const ctx = String(context || '').trim().slice(0, 1500);
  if (kind === 'song') {
    const lines = [
      `You rewrite song ideas into prompts for the music model "${model || 'unknown'}".`,
      '',
      'Rules:',
      only,
      "- Keep the user's idea, genre and mood exactly. Add specificity; never swap in a different style.",
      '- Cover genre and subgenre, era or influences, the key instruments, tempo feel, mood and energy, production character, and (unless it is instrumental) the vocal: who sings and how.',
      '- Write it as flowing prose, not a tag list. Do not write lyrics; those are a separate field.',
      '- Keep it under about 70 words. One paragraph.'
    ];
    if (spec?.clipSeconds) lines.push(`- The model makes ${spec.clipSeconds}-second clips, so describe one strong idea (a hook or a loop), not a song's whole arc.`);
    else if (spec?.full) lines.push('- The model writes full songs, so you may say how it builds: intro, verses, a lifting chorus, a bridge, an outro.');
    if (refs) lines.push(`- ${refs} image${refs === 1 ? '' : 's'} will be attached to set the mood, so do not describe the picture itself.`);
    return lines.join('\n');
  }
  if (kind === 'lyrics') {
    const lines = [
      `You write song lyrics for the music model "${model || 'unknown'}".`,
      'You are given an idea, or a draft to improve.',
      '',
      'Rules:',
      only,
      '- Put each section marker on its own line in square brackets ([Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Outro]) and the sung lines under it.',
      '- A draft keeps its story, images and best lines; tighten the meter and rhyme and make the chorus memorable. An idea becomes original lyrics about exactly that.',
      '- Singable: short lines, natural stresses, a chorus that repeats. No stage directions and no chords.'
    ];
    lines.push(
      spec?.clipSeconds
        ? `- The model makes ${spec.clipSeconds}-second clips: write one short verse and one chorus, eight lines at most.`
        : '- Write a complete song: two verses, a chorus that returns, and a bridge. About 250 words at most.'
    );
    if (ctx) lines.push(`- The music is: ${ctx}. Fit the words to that style and mood.`);
    return lines.join('\n');
  }
  if (kind === 'voice') {
    const tags = !!spec?.tags || /eleven_v3/.test(String(model));
    const names = characters.map((c) => c.name || c).filter(Boolean);
    const lines = [
      `You direct text for the text-to-speech model "${model || 'unknown'}". You change how it is performed, not what is said.`,
      '',
      'Rules:',
      only,
      "- Keep every word's meaning and the order of what is said. Fix typos; do not add new sentences or content.",
      '- Shape the delivery with punctuation: commas and ellipses for pauses, an em dash for a break, a question mark where the voice should lift, capitals for a stressed word.'
    ];
    if (tags) {
      lines.push(
        '- This model performs audio tags. Add a few in square brackets right before the words they colour: emotions like [excited], [nervous], [sad], [warmly]; delivery like [whispers], [shouts], [sarcastic]; and sounds like [laughs], [sighs], [clears throat], [gasps].',
        '- Use tags sparingly (one every sentence or two at most) and only where the text implies them.'
      );
    } else {
      lines.push('- This model reads square brackets aloud, so do not add any tags or stage directions. Direct it with punctuation and phrasing alone.');
    }
    if (names.length) {
      lines.push(
        `- It is a script. Lines begin with a speaker's name and a colon (${names.map((n) => `"${n}:"`).join(', ')}). Keep every speaker label exactly as written, at the start of its line, and keep the lines in order.`
      );
    }
    return lines.join('\n');
  }
  if (kind === 'voice-design') {
    return [
      'You write voice descriptions for a text-to-voice designer, from a description of a character.',
      '',
      'Rules:',
      only,
      "- Describe only how they sound: apparent age and gender, accent, pitch, timbre (warm, raspy, bright, breathy), pace, and the attitude in their delivery.",
      '- Infer a voice that fits who they are; do not describe their appearance or clothes.',
      '- End with the kind of recording: studio quality, clear, close to the microphone.',
      '- Write one flowing sentence or two, between 25 and 60 words. No name.'
    ].join('\n');
  }
  return '';
}

// Models sometimes wrap the answer despite being told not to; strip the usual
// wrappers rather than handing the user a quoted, prefixed blob.
export function cleanEnhanced(text) {
  let out = String(text || '').trim();
  out = out.replace(/^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  out = out.replace(/^(?:here(?:'s| is)[^\n:]*:|rewritten prompt:|prompt:|enhanced prompt:)\s*/i, '').trim();
  if (out.length > 1 && /^["'“”](.|\n)*["'“”]$/.test(out)) out = out.slice(1, -1).trim();
  // A model that ignored "one paragraph" and gave alternatives — take the first.
  const numbered = out.match(/^\s*1[.)]\s+([\s\S]*?)(?=\n\s*2[.)]\s)/);
  if (numbered) out = numbered[1].trim();
  // Plain punctuation only: an em dash becomes a comma.
  return out.replace(/\s*\u2014\s*/g, ', ');
}

// Cut back to the last sentence that actually ends, so a truncated answer
// becomes a shorter usable prompt rather than a dangling clause.
export function lastCompleteSentence(text) {
  const end = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'));
  if (end < 0) return '';
  const cut = text.slice(0, end + 1).trim();
  // A couple of surviving words is not a prompt; better to say it failed.
  return cut.length >= 12 ? cut : '';
}

// Lyrics and scripts are lines, not sentences: a lyric rarely ends in a full
// stop, so a truncated one is cut back to its last whole line instead.
export function lastCompleteLine(text) {
  const end = text.lastIndexOf('\n');
  if (end < 0) return '';
  const cut = text.slice(0, end).trim();
  return cut.length >= 12 ? cut : '';
}

export async function enhancePrompt({ apiKey, prompt, kind = 'image', model, spec, characters = [], refs = 0, context = '', enhanceModel = ENHANCE_MODEL, chatUrl = enhanceUrl(), signal }) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Nothing to improve yet. Write an idea first.');
  const byLine = kind === 'lyrics' || kind === 'voice';
  const json = await postJson(
    chatUrl,
    apiKey,
    {
      model: enhanceModel,
      messages: [
        { role: 'system', content: enhanceSystemPrompt({ kind, model, spec, characters, refs, context }) },
        { role: 'user', content: text }
      ],
      // Generous, because a reasoning model spends most of this budget thinking
      // before it writes a word — Gemini 3.7 Flash burns ~350 tokens on a
      // rewrite this small, and a tighter cap cuts the answer off mid-sentence.
      // A whole song's lyrics or a long script needs more room again.
      max_tokens: byLine ? 2400 : 1200,
      temperature: 0.8
    },
    signal
  );
  const choice = json.choices?.[0];
  const out = cleanEnhanced(choice?.message?.content);
  if (!out) throw new Error('The prompt model returned nothing usable.');
  // A model that ran out of room mid-sentence must not hand back a fragment.
  if (choice?.finish_reason === 'length') {
    const whole = byLine ? lastCompleteLine(out) : lastCompleteSentence(out);
    if (!whole) throw new Error('The prompt model ran out of room before finishing. Try again, or shorten what you wrote.');
    return { prompt: whole, model: enhanceModel, cost: json.usage?.cost, truncated: true };
  }
  return { prompt: out, model: enhanceModel, cost: json.usage?.cost };
}

// A whole-song music video's shot list, written by the ✨ model. The request
// and the checks on the answer live in music-video-plan.js, so the browser's
// own-key engine writes it exactly the same way. A reply that cannot be read
// falls back to the plan's template rather than failing the video.
export async function writeStoryboard({ apiKey, song = {}, shots = [], cast = [], idea = '', aspect = '16:9', enhanceModel = ENHANCE_MODEL, chatUrl = enhanceUrl(), signal }) {
  if (!Array.isArray(shots) || !shots.length || shots.length > 200) throw Object.assign(new Error('Send the shots to write, up to 200.'), { status: 400 });
  const clean = shots.map((s, i) => ({
    n: Number(s?.n) || i + 1,
    start: Number(s?.start) || 0,
    end: Number(s?.end) || 0,
    vocal: !!s?.vocal,
    lines: (Array.isArray(s?.lines) ? s.lines : []).map((l) => String(l).slice(0, 300)).slice(0, 12)
  }));
  const people = (Array.isArray(cast) ? cast : []).slice(0, 12).map((c) => ({ name: String(c?.name || '').slice(0, 100), description: String(c?.description || '').slice(0, 400) })).filter((c) => c.name);
  const request = storyboardRequest({ title: song.title, style: song.style, idea, shots: clean, cast: people, aspect, model: enhanceModel });
  const json = await postJson(chatUrl, apiKey, request, signal);
  const board = parseStoryboard(json.choices?.[0]?.message?.content, clean, people, { idea, title: song.title });
  return { board, model: enhanceModel, cost: json.usage?.cost };
}

// When each word of a song is sung, for lyrics that came without times
// (Lyria 3 Pro's, or a song brought in). music-video-plan.js lines the known
// lyrics up against these words.
export async function transcribeWords({ apiKey, buf, format = 'mp3', model = TRANSCRIBE_MODEL, signal }) {
  const url = process.env.JUSTIMAGINE_TRANSCRIBE_URL || 'https://openrouter.ai/api/v1/audio/transcriptions';
  const json = await postJson(url, apiKey, { model, input_audio: { data: Buffer.from(buf).toString('base64'), format }, response_format: 'verbose_json', timestamp_granularities: ['word', 'segment'] }, signal);
  const words = (Array.isArray(json.words) ? json.words : [])
    .map((w) => ({ word: String(w.word || ''), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.word && Number.isFinite(w.start));
  return { words, text: String(json.text || ''), model, cost: json.usage?.cost };
}

// ---------- video (OpenRouter) ----------

export const VIDEO_BASE = process.env.JUSTIMAGINE_VIDEO_URL || 'https://openrouter.ai/api/v1/videos';
const currentVideoBase = () => process.env.JUSTIMAGINE_VIDEO_URL || VIDEO_BASE;
export const VIDEO_KEY_API = 'openrouter';
const origin = (url) => new URL(url).origin;

// Frame images name a first/last frame for image-to-video; input_references
// steer style/subject without pinning a frame. OpenRouter documents these as
// directly downloadable URLs, so an https reference passes straight through and
// a local one is inlined as a data URL (which most upstreams accept).
function frameEntry(ref, frameType) {
  const url = ref.url || ref.dataUrl;
  return { type: 'image_url', image_url: { url }, ...(frameType ? { frame_type: frameType } : {}) };
}

export function buildVideoBody({ model, prompt, duration, resolution, aspectRatio, size, generateAudio, seed, firstFrame, lastFrame, refs = [], audioRefs = [] }) {
  const body = { model, prompt };
  if (duration) body.duration = Number(duration);
  // `size` fully determines resolution + aspect ratio, so sending all three
  // risks a contradiction the upstream would reject.
  if (size && size !== 'auto') body.size = size;
  else {
    if (resolution && resolution !== 'auto') body.resolution = resolution;
    if (aspectRatio && aspectRatio !== 'auto') body.aspect_ratio = aspectRatio;
  }
  if (typeof generateAudio === 'boolean') body.generate_audio = generateAudio;
  if (Number.isFinite(Number(seed)) && String(seed).trim() !== '') body.seed = Number(seed);
  // A reference song (lip sync): the model moves the singer's mouth to it and
  // keeps it as the clip's sound. OpenRouter only takes it as an https link,
  // and drops every reference once a frame is pinned, so with a song the
  // opening frame travels as the first reference image instead.
  if (audioRefs.length) {
    const images = [firstFrame, lastFrame, ...refs].filter(Boolean).map((r) => frameEntry(r));
    body.input_references = [...images, ...audioRefs.map((a) => ({ type: 'audio_url', audio_url: { url: a.url } }))];
    return body;
  }
  const frames = [];
  if (firstFrame) frames.push(frameEntry(firstFrame, 'first_frame'));
  if (lastFrame) frames.push(frameEntry(lastFrame, 'last_frame'));
  if (frames.length) body.frame_images = frames;
  // frame_images wins upstream when both are present, so only send references
  // when no frame was pinned — otherwise they are silently ignored.
  else if (refs.length) body.input_references = refs.map((r) => frameEntry(r));
  return body;
}

const TERMINAL_FAIL = new Set(['failed', 'cancelled', 'expired']);

// Poll gently but not slowly: video takes tens of seconds to minutes, and a
// fixed 30s tick would add half a minute of dead time to every short clip.
export function pollDelay(attempt) {
  if (attempt < 3) return 2000;
  if (attempt < 8) return 4000;
  if (attempt < 20) return 8000;
  return 15000;
}

export async function generateVideo({ apiKey, params, signal, onProgress = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxMs = 20 * 60 * 1000 }) {
  const body = buildVideoBody(params);
  const auth = { authorization: `Bearer ${apiKey}` };
  onProgress({ phase: 'submitting' });
  const videoBase = currentVideoBase();
  let job = await postJson(videoBase, apiKey, body, signal);
  if (!job?.id && !job?.polling_url) throw new Error('Video API did not return a job id.');
  onProgress({ phase: 'queued', jobId: job.id, status: job.status || 'pending' });

  const started = Date.now();
  for (let attempt = 0; !TERMINAL_FAIL.has(job.status) && job.status !== 'completed'; attempt++) {
    if (Date.now() - started > maxMs) throw new Error('Video generation timed out.');
    await sleep(pollDelay(attempt));
    if (signal?.aborted) throw new Error('Cancelled.');
    const pollUrl = new URL(job.polling_url || `${videoBase}/${job.id}`, origin(videoBase));
    const res = await fetch(pollUrl, { signal, headers: auth });
    job = await readApiResponse(res);
    onProgress({ phase: 'generating', jobId: job.id, status: job.status || 'pending', attempt, elapsed: Date.now() - started });
  }
  if (job.status !== 'completed') throw new Error(job.error || `Video generation ${job.status}.`);

  const url = job.unsigned_urls?.[0] || job.url || job.output?.[0];
  if (!url) throw new Error('Completed job had no video URL.');
  onProgress({ phase: 'downloading', jobId: job.id });
  // Unsigned URLs are served from OpenRouter and need the key; a signed URL
  // elsewhere must not receive it.
  const sameHost = String(url).startsWith(origin(videoBase));
  const { buf, ext } = await download(String(url), signal, sameHost ? auth : {});
  return {
    buf,
    ext: ext === 'bin' ? 'mp4' : ext,
    cost: job.usage?.cost ?? undefined,
    generationId: job.generation_id || job.id
  };
}
