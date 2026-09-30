// A whole-song music video, planned. The song comes first; its timed lines are
// cut into shots that fit the lip sync model's clip lengths; a text model (or a
// plain template when there is none) writes what each shot shows; then every
// shot is one picture and one lip-synced clip, made with ordinary studio
// requests. The page stitches the clips back onto the song.
//
// Pure functions only, no imports: the studio page, the local server and the
// in-browser engine all load this same file.

// The prompt writer the storyboard defaults to, the studio's own ✨ model.
export const STORYBOARD_MODEL = 'google/gemini-3.7-flash';

// Models that take the song itself as an audio reference and move the singer's
// mouth to it. Seedance 2 and later keep the reference as the clip's own
// soundtrack, which is what lets each shot be measured and lined up exactly.
export const isLipSyncModel = (m) => !!m && m.audio !== false && /seedance-2[.-]\d/i.test(String(m.id || ''));

// The reference audio a lip sync model accepts, per clip.
export const AUDIO_MIN_SECONDS = 2;
export const AUDIO_MAX_SECONDS = 15;

// ---------- lyrics with timings ----------

const round2 = (n) => Math.round(n * 100) / 100;

// Lyria's timed lyrics ("[4.0:8.0] a line"), LRC ("[01:02.50] a line") or
// plain lines. Section labels such as "[Chorus]" are dropped. Returns the lines
// in order and whether they carry times.
export function parseTimedLyrics(text) {
  const lines = [];
  let timed = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    // Lyria 3 Pro marks sections "[[B1]]" and leaves each line's time slot
    // empty ("[:] a line"); neither has anything to time by.
    let line = raw.trim().replace(/^\[:\]\s*/, '');
    if (!line || /^\[\[[^\]]*\]\]$/.test(line)) continue;
    const span = line.match(/^\[(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    // Lyria writes both ends with decimals; LRC writes minutes:seconds.
    if (span && span[1].includes('.') && span[2].includes('.')) {
      const start = Number(span[1]), end = Number(span[2]);
      if (span[3].trim() && end > start) {
        lines.push({ start, end, text: span[3].trim() });
        timed++;
      }
      continue;
    }
    const stamps = [];
    let m;
    while ((m = line.match(/^\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]\s*/))) {
      stamps.push(Number(m[1]) * 60 + Number(m[2]));
      line = line.slice(m[0].length);
    }
    if (stamps.length) {
      if (line.trim()) {
        for (const start of stamps) lines.push({ start, end: null, text: line.trim() });
        timed += stamps.length;
      }
      continue;
    }
    if (/^\[[^\]]*\]$/.test(line) || /^\([^)]*\)$/.test(line)) continue;
    lines.push({ start: null, end: null, text: line });
  }
  if (timed && timed === lines.length) {
    lines.sort((a, b) => a.start - b.start);
    // An LRC line lasts until the next one starts, but not forever.
    lines.forEach((l, i) => {
      if (l.end == null) l.end = Math.min(lines[i + 1]?.start ?? l.start + 4, l.start + 8);
    });
    return { lines, timed: true };
  }
  return { lines: lines.map((l) => ({ start: null, end: null, text: l.text })), timed: false };
}

// Untimed lyrics are spread evenly over the part of the song that has singing
// in it. Rough, but enough to tell the storyboard what each shot is about.
export function spreadLines(lines, duration, { from = duration * 0.06, to = duration * 0.96 } = {}) {
  const n = lines.length;
  if (!n || !(duration > 0)) return [];
  const span = Math.max(0.5, to - from) / n;
  return lines.map((l, i) => ({ start: round2(from + i * span), end: round2(from + (i + 1) * span), text: l.text }));
}

// ---------- shots ----------

// The shortest clip a model makes that covers `seconds`.
export const clipFor = (seconds, durations) => [...durations].sort((a, b) => a - b).find((d) => d >= seconds - 1e-6) ?? null;

// How cuts are chosen: a lyric line starting is the best place to cut, the gap
// after a line is next, and cutting inside a line (only ever needed when one
// line is longer than any clip) is the last resort. Each shot then pays for
// the seconds a clip adds beyond it, and for straying from the pace.
const CUT = { line: 0, gap: 0.35, grid: 0.25, mid: 2.5 };

export function planShots({ duration, lines = [], durations = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], pace = 6, minShot = 2 } = {}) {
  const T = Number(duration);
  if (!(T > 0)) throw new Error('The song has no length.');
  const usable = [...new Set(durations.map(Number).filter((d) => d > 0 && d <= AUDIO_MAX_SECONDS))].sort((a, b) => a - b);
  if (!usable.length) throw new Error('This model has no clip length that works for lip sync.');
  const maxClip = usable[usable.length - 1];
  const timed = lines.filter((l) => Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start && l.start < T).map((l) => ({ ...l, end: Math.min(l.end, T) }));

  // Candidate cut points, each with the price of cutting there.
  const points = new Map();
  const add = (t, kind) => {
    if (!(t > 0 && t < T)) return;
    const key = Math.round(t * 20) / 20;
    const was = points.get(key);
    if (was === undefined || CUT[kind] < was) points.set(key, CUT[kind]);
  };
  const grid = (from, to, kind) => {
    for (let t = Math.ceil(from * 2) / 2; t < to - 1e-6; t += 0.5) add(t, kind);
  };
  if (!timed.length) grid(0, T, 'grid');
  timed.forEach((l, i) => {
    add(l.start, 'line');
    const next = timed[i + 1]?.start ?? T;
    if (next - l.end >= 0.6) add(l.end, 'gap');
    // A long instrumental stretch can be cut anywhere in it.
    if (next - l.end > pace) grid(l.end, next, 'gap');
    // So can a line longer than the longest clip, as a last resort.
    if (l.end - l.start > maxClip - 0.5) grid(l.start + 1, l.end - 1, 'mid');
  });
  if (timed.length && timed[0].start > pace) grid(0, timed[0].start, 'gap');
  const cuts = [0, ...[...points.keys()].sort((a, b) => a - b), T];

  const cost = (i, j) => {
    const len = cuts[j] - cuts[i];
    const clip = clipFor(len, usable);
    if (!clip) return Infinity;
    if (len < minShot && !(i === 0 && j === cuts.length - 1)) return Infinity;
    const cutAt = j === cuts.length - 1 ? 0 : points.get(cuts[j]);
    return (clip - len) + 0.5 * ((len - pace) ** 2) / pace + cutAt;
  };
  const best = new Array(cuts.length).fill(Infinity), from = new Array(cuts.length).fill(-1);
  best[0] = 0;
  for (let j = 1; j < cuts.length; j++) {
    for (let i = j - 1; i >= 0 && cuts[j] - cuts[i] <= maxClip + 1e-6; i--) {
      if (best[i] === Infinity) continue;
      const c = best[i] + cost(i, j);
      if (c < best[j]) { best[j] = c; from[j] = i; }
    }
  }
  if (best[cuts.length - 1] === Infinity) throw new Error('The song could not be cut into clips this model can make.');
  const bounds = [];
  for (let j = cuts.length - 1; j > 0; j = from[j]) bounds.unshift([cuts[from[j]], cuts[j]]);

  return bounds.map(([start, end], k) => {
    const len = end - start;
    const sung = timed.filter((l) => Math.min(l.end, end) - Math.max(l.start, start) >= Math.min(0.6, (l.end - l.start) * 0.5));
    return { n: k + 1, start: round2(start), end: round2(end), clip: clipFor(len, usable), lines: sung.map((l) => l.text), vocal: sung.length > 0 };
  });
}

// The piece of the song a shot's clip hears: from the shot's start for the
// whole clip, so the clip is lip synced past the cut and can be lined up.
export const audioWindow = (shot) => ({ start: shot.start, length: shot.clip });

// ---------- the storyboard ----------

const ASPECT_WORDS = {
  '16:9': 'Wide 16:9 landscape frame.',
  '9:16': 'Tall 9:16 vertical frame.',
  '1:1': 'Square 1:1 frame.',
  '4:3': 'Classic 4:3 frame.',
  '3:4': 'Tall 3:4 portrait frame.',
  '21:9': 'Ultra-wide 21:9 cinematic frame.'
};

export function storyboardRequest({ title = '', idea = '', style = '', shots = [], cast = [], aspect = '16:9', model = STORYBOARD_MODEL } = {}) {
  const system = [
    'You direct music videos. You get a song (its style and its lyrics, cut into timed shots), the cast who can appear and the look the user wants. Write every shot.',
    'For each shot give:',
    '- "cast": the names of the cast members in the shot, spelled exactly as given. An empty list for no one.',
    '- "singer": the name of the one cast member who sings in this shot, or null when nobody sings.',
    '- "image": the opening frame, described so it can be drawn: who is where, what they wear and do, the setting, the light, the camera angle and the framing.',
    '- "motion": one or two short sentences on what moves during the shot: gestures, dancing and one simple, smooth camera move. Never describe the singing, the voice or the vocals; the song itself provides them.',
    'Rules:',
    '- A shot with lyrics has a singer. Show the singer\'s face clearly, facing the camera or in three-quarter view, mouth visible, as a close-up or medium shot.',
    '- A shot without lyrics has no singer. Use it for wide shots, dancing, the setting, details and the rest of the cast.',
    '- Keep one world: the same outfits, style, colours and places, so it feels like one video. Vary the angle, framing and spot from shot to shot so it never gets boring. Make the chorus bigger and brighter.',
    '- Never put text, captions, logos or lyrics on screen, and never describe the frame as having any.',
    '- Only use names from the cast list. If the cast list is empty, invent one performer and keep them the same in every shot.',
    'Answer with JSON only: {"title": "a short title", "look": "one sentence on the shared look", "shots": [{"n": 1, "cast": [], "singer": null, "image": "", "motion": ""}]} with exactly one entry per shot, in order.'
  ].join('\n');
  const user = JSON.stringify({
    song: { title: String(title).slice(0, 200), style: String(style).slice(0, 500) },
    look: String(idea).slice(0, 2000),
    frame: aspect,
    cast: cast.slice(0, 12).map((c) => ({ name: c.name, description: String(c.description || '').slice(0, 400) })),
    shots: shots.map((s) => ({ n: s.n, seconds: `${s.start.toFixed(1)}-${s.end.toFixed(1)}`, lyrics: s.lines.length ? s.lines.join(' / ') : null }))
  });
  return {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    // A reasoning model thinks before it writes; thirty shots of prose need room.
    max_tokens: Math.min(32000, 4000 + shots.length * 450),
    temperature: 0.9,
    response_format: { type: 'json_object' }
  };
}

// The first JSON object in a model's reply, fenced or not.
function jsonIn(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

const clean = (v, max = 1200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// The model's storyboard, checked shot by shot. Names are matched to the cast
// (so "mal" is Mal), a shot with lyrics always has a singer, and anything
// missing is filled from the template.
export function parseStoryboard(text, shots, cast = [], context = {}) {
  const json = typeof text === 'object' && text ? text : jsonIn(text);
  const fallback = fallbackStoryboard({ shots, cast, ...context });
  if (!json || !Array.isArray(json.shots)) return { ...fallback, written: false };
  const byName = new Map(cast.map((c) => [c.name.toLowerCase(), c.name]));
  const known = (name) => byName.get(String(name || '').trim().toLowerCase().replace(/^@/, '')) || null;
  const out = shots.map((shot, i) => {
    const got = json.shots.find((s) => Number(s?.n) === shot.n) || json.shots[i] || {};
    const base = fallback.shots[i];
    const inShot = (Array.isArray(got.cast) ? got.cast : []).map(known).filter(Boolean);
    let singer = shot.vocal ? known(got.singer) || inShot[0] || base.singer : null;
    if (singer && !inShot.includes(singer)) inShot.unshift(singer);
    return {
      n: shot.n,
      cast: cast.length ? [...new Set(inShot.length ? inShot : base.cast)] : [],
      singer: cast.length ? singer : shot.vocal ? base.singer : null,
      image: clean(got.image) || base.image,
      motion: clean(got.motion, 600) || base.motion
    };
  });
  return { title: clean(json.title, 120) || fallback.title, look: clean(json.look, 600) || fallback.look, shots: out, written: true };
}

// Without a text model: a plain but sound plan. Singers alternate through the
// cast, framing cycles from close to wide, and instrumental shots go wide.
const VOCAL_FRAMES = ['close-up', 'medium shot', 'low-angle medium shot', 'three-quarter close-up', 'medium close-up with a slow push-in'];
const WIDE_FRAMES = ['wide shot of the whole scene', 'high wide shot', 'tracking shot', 'detail shot'];
const VOCAL_MOVES = ['A slow push-in toward the singer.', 'A gentle orbit around the singer.', 'A slow dolly to the side.', 'The camera holds steady while the singer performs.'];
const WIDE_MOVES = ['A slow pull back to reveal the scene.', 'A smooth tracking move past the performers.', 'A gentle crane up over the scene.'];

export function fallbackStoryboard({ shots, cast = [], idea = '', title = '' }) {
  const names = cast.map((c) => c.name);
  const setting = clean(idea, 600) || 'A stylish stage with warm, colourful concert lights';
  let v = 0, w = 0;
  return {
    title: clean(title, 120) || 'Music video',
    look: setting,
    written: false,
    shots: shots.map((s) => {
      if (s.vocal) {
        const singer = names.length ? names[v % names.length] : 'The singer';
        const frame = VOCAL_FRAMES[v % VOCAL_FRAMES.length], move = VOCAL_MOVES[v % VOCAL_MOVES.length];
        v++;
        return { n: s.n, cast: names.length ? [singer] : [], singer: names.length ? singer : null, image: `${frame} of ${singer} singing with feeling, face clearly visible, mouth open mid-word. ${setting}.`, motion: `${singer} sings and moves with the music. ${move}` };
      }
      const frame = WIDE_FRAMES[w % WIDE_FRAMES.length], move = WIDE_MOVES[w % WIDE_MOVES.length];
      w++;
      const who = names.length ? names.join(', ') : 'the performers';
      return { n: s.n, cast: names.slice(0, 4), singer: null, image: `${frame}: ${who} dancing and enjoying the music. ${setting}.`, motion: `Everyone dances to the beat. ${move}` };
    })
  };
}

// ---------- what each shot asks for ----------

// A sentence ends with a stop, whatever the model wrote.
const sentence = (s) => (s = clean(s)) && (/[.!?]$/.test(s) ? s : `${s}.`);

export function keyframePrompt(shot, board, aspect = '16:9') {
  return [ASPECT_WORDS[aspect] || '', 'A frame from a music video.', sentence(board?.look), sentence(shot.image), 'No text, captions, logos or watermarks.']
    .filter(Boolean)
    .join(' ');
}

export function motionPrompt(shot) {
  const opening = 'The video opens on the reference image and keeps its characters, look and setting.';
  if (shot.singer) {
    return `${opening} ${sentence(shot.motion)} ${shot.singer} sings the song in the reference audio, lip syncing every word exactly in time with it.`;
  }
  return `${opening} ${sentence(shot.motion)} Nobody sings or talks in this shot; mouths stay closed. Movement follows the beat of the music.`;
}

// ---------- cost ----------

// Seedance keeps the pixel count per tier the same across frame shapes, and
// prices are quoted at 720p.
const RES_FACTOR = { '480p': 0.445, '720p': 1, '1080p': 2.25, '4K': 9 };

export function estimateCost({ shots = [], songPricing = null, newSong = true, imagePricing = null, videoPricing = null, resolution = '720p' } = {}) {
  const seconds = shots.reduce((n, s) => n + (s.clip || 0), 0);
  const song = !newSong ? 0 : songPricing?.perSong ?? songPricing?.perClip ?? null;
  const images = imagePricing?.perImage != null ? imagePricing.perImage * shots.length : null;
  const perSecond = videoPricing?.perSecondAudio ?? videoPricing?.perSecond;
  const clips = perSecond != null ? perSecond * (RES_FACTOR[resolution] ?? 1) * seconds : null;
  const parts = { song, images, clips, text: 0.01 };
  const known = Object.values(parts).filter((v) => v != null);
  return { seconds, shots: shots.length, parts, usd: known.reduce((a, b) => a + b, 0), complete: known.length === Object.keys(parts).length };
}

// ---------- files made in the browser ----------

// What an uploaded file is, from its first bytes rather than its name.
export function sniffMedia(head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  const at = (i, text) => [...text].every((ch, k) => b[i + k] === ch.charCodeAt(0));
  if (at(4, 'ftyp')) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    return /^M4A|^M4B/.test(brand) ? 'audio/mp4' : /^qt/.test(brand) ? 'video/quicktime' : 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav';
  if (at(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return 'audio/mpeg';
  if (at(0, 'OggS')) return 'audio/ogg';
  if (at(0, 'fLaC')) return 'audio/flac';
  if (b[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  return '';
}

// History fields an upload may set. Everything else is dropped.
const UPLOAD_META = {
  prompt: (v) => (typeof v === 'string' ? v.slice(0, 4000) : undefined),
  workflow: (v) => (['music-video-song', 'upload'].includes(v) ? v : undefined),
  title: (v) => (typeof v === 'string' ? v.slice(0, 200) : undefined),
  lyrics: (v) => (typeof v === 'string' ? v.slice(0, 10000) : undefined),
  sung: (v) => (typeof v === 'string' ? v.slice(0, 20000) : undefined),
  musicStyle: (v) => (typeof v === 'string' ? v.slice(0, 500) : undefined),
  duration: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v) * 100) / 100 : undefined),
  aspectRatio: (v) => (typeof v === 'string' && v.length <= 10 ? v : undefined),
  resolution: (v) => (typeof v === 'string' && v.length <= 10 ? v : undefined),
  model: (v) => (typeof v === 'string' ? v.slice(0, 200) : undefined),
  characters: (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 12).map((x) => x.slice(0, 100)) : undefined),
  song: (v) => (v && typeof v === 'object' && typeof v.file === 'string' ? { folder: String(v.folder || '').slice(0, 300), file: v.file.slice(0, 300) } : undefined),
  shots: (v) => (Array.isArray(v)
    ? v.slice(0, 300).map((x) => ({
      n: Number(x?.n) || 0,
      start: Number(x?.start) || 0,
      end: Number(x?.end) || 0,
      clip: typeof x?.clip === 'string' ? x.clip.slice(0, 300) : undefined,
      still: typeof x?.still === 'string' ? x.still.slice(0, 300) : undefined,
      singer: typeof x?.singer === 'string' ? x.singer.slice(0, 100) : undefined,
      offset: Number.isFinite(Number(x?.offset)) ? Math.round(Number(x.offset) * 1000) / 1000 : undefined,
      rate: Number.isFinite(Number(x?.rate)) && Number(x.rate) > 0 ? Math.round(Number(x.rate) * 1000) / 1000 : undefined,
      aligned: ['sound', 'words', 'phrasing'].includes(x?.aligned) ? x.aligned : undefined
    }))
    : undefined)
};
export function uploadMeta(meta) {
  const out = {};
  if (meta && typeof meta === 'object') {
    for (const [k, check] of Object.entries(UPLOAD_META)) {
      const v = check(meta[k]);
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

// ---------- timing lyrics by ear ----------

// Lyrics without times (Lyria 3 Pro's, or a song brought in) are timed by a
// speech model that hears the song and reports when each word is sung: the
// known lines are lined up against those words, so a misheard word here and
// there does not matter.
export const TRANSCRIBE_MODEL = 'openai/whisper-large-v3';

const norm = (w) => String(w).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const tokensOf = (text) => String(text).split(/[\s\-–/]+/).map(norm).filter(Boolean);
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const was = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = was;
    }
  }
  return row[b.length];
}
const sameWord = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && distance(a, b) <= (Math.max(a.length, b.length) >= 6 ? 2 : 1));

// `words`: [{ word, start, end }] in seconds. Returns the lines with times, and
// how much of the lyrics was heard (0 to 1); null when nothing lines up.
export function alignLyrics(lines, words, duration) {
  const lw = [];
  lines.forEach((l, i) => tokensOf(l.text).forEach((t) => lw.push({ t, line: i })));
  const tw = (words || []).map((w) => ({ t: norm(w.word), start: Number(w.start), end: Number(w.end ?? w.start) })).filter((w) => w.t && Number.isFinite(w.start));
  const n = lw.length, m = tw.length;
  if (!n || !m) return null;
  // Edit-distance alignment. Hearing a word the lyrics do not have is cheap
  // (fillers, ad-libs); missing a lyric word costs a little more.
  const W = m + 1, cost = new Float32Array((n + 1) * W), move = new Uint8Array((n + 1) * W);
  for (let i = 1; i <= n; i++) { cost[i * W] = i; move[i * W] = 1; }
  for (let j = 1; j <= m; j++) { cost[j] = j * 0.6; move[j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const hit = sameWord(lw[i - 1].t, tw[j - 1].t);
      const diag = cost[(i - 1) * W + j - 1] + (hit ? 0 : 1.2), up = cost[(i - 1) * W + j] + 1, left = cost[i * W + j - 1] + 0.6;
      const best = Math.min(diag, up, left);
      cost[i * W + j] = best;
      move[i * W + j] = best === diag ? (hit ? 0 : 3) : best === up ? 1 : 2;
    }
  }
  const heard = Array.from({ length: lines.length }, () => ({ start: Infinity, end: -Infinity, hits: 0 }));
  let matched = 0;
  for (let i = n, j = m; i > 0 || j > 0;) {
    const mv = i > 0 && j > 0 ? move[i * W + j] : i > 0 ? 1 : 2;
    if (mv === 0) {
      const h = heard[lw[i - 1].line], w = tw[j - 1];
      h.start = Math.min(h.start, w.start); h.end = Math.max(h.end, w.end); h.hits++; matched++;
      i--; j--;
    } else if (mv === 3) { i--; j--; } else if (mv === 1) i--; else j--;
  }
  if (matched < Math.max(2, n * 0.15)) return null;
  // Lines nobody heard share the time between the lines around them, by length.
  const T = Number(duration) || Math.max(...tw.map((w) => w.end)) + 1;
  const out = lines.map((l, i) => ({ text: l.text, start: heard[i].hits ? heard[i].start : null, end: heard[i].hits ? Math.max(heard[i].end, heard[i].start + 0.3) : null }));
  for (let i = 0; i < out.length;) {
    if (out[i].start != null) { i++; continue; }
    let k = i;
    while (k < out.length && out[k].start == null) k++;
    const from = i ? out[i - 1].end : Math.max(0, (out[k]?.start ?? T) - 3 * (k - i));
    const to = k < out.length ? out[k].start : Math.min(T, from + 3 * (k - i));
    const weights = out.slice(i, k).map((l) => Math.max(1, tokensOf(l.text).length)), total = weights.reduce((a, b) => a + b, 0);
    let at = from;
    for (let x = i; x < k; x++) {
      const len = ((to - from) * weights[x - i]) / total;
      out[x].start = round2(at); out[x].end = round2(at + len); at += len;
    }
    i = k;
  }
  // In order, inside the song.
  for (let i = 0; i < out.length; i++) {
    out[i].start = round2(Math.max(0, Math.min(out[i].start, T), i ? out[i - 1].start : 0));
    out[i].end = round2(Math.min(T, Math.max(out[i].end, out[i].start + 0.3)));
  }
  // A line nobody heard that got almost no time was in the lyrics but not sung.
  return { lines: out.filter((l, i) => heard[i].hits || l.end - l.start >= 0.6), heard: Math.round((matched / n) * 100) / 100 };
}

// Lines straight from what was heard, for a song that came without lyrics:
// a new line at each pause, or every dozen words.
export function linesFromWords(words) {
  const lines = [];
  let cur = null;
  for (const w of words || []) {
    const text = String(w.word || '').replace(/♪/g, '').trim(), start = Number(w.start), end = Number(w.end ?? w.start);
    if (!text || !Number.isFinite(start)) continue;
    if (!cur || start - cur.end > 0.7 || cur.count >= 12) {
      if (cur) lines.push(cur);
      cur = { start, end, text, count: 1 };
    } else {
      cur.text += ` ${text}`; cur.end = end; cur.count++;
    }
  }
  if (cur) lines.push(cur);
  return lines.map(({ start, end, text }) => ({ start: round2(start), end: round2(Math.max(end, start + 0.3)), text }));
}

// ---------- lining a re-sung clip up with the song ----------

// A lip sync model sometimes sings its piece of the song again instead of
// keeping it: the same words, a slightly different timing. Its picture follows
// its own singing, so the clip is lined up by the words themselves: the words
// heard in the clip are matched to the song's words for that stretch, and a
// straight-line fit (clip time = rate × song time + offset) puts each word
// where the song sings it. `songWords` and `clipWords` are [{ word, start }],
// both in seconds from the start of the shot's piece.
export function wordShift(songWords, clipWords) {
  const a = (songWords || []).map((w) => ({ t: norm(w.word), at: Number(w.start) })).filter((w) => w.t && Number.isFinite(w.at));
  const b = (clipWords || []).map((w) => ({ t: norm(w.word), at: Number(w.start) })).filter((w) => w.t && Number.isFinite(w.at));
  const n = a.length, m = b.length;
  if (!n || !m) return null;
  const W = m + 1, cost = new Float32Array((n + 1) * W), move = new Uint8Array((n + 1) * W);
  for (let i = 1; i <= n; i++) { cost[i * W] = i; move[i * W] = 1; }
  for (let j = 1; j <= m; j++) { cost[j] = j; move[j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const hit = sameWord(a[i - 1].t, b[j - 1].t);
      const diag = cost[(i - 1) * W + j - 1] + (hit ? 0 : 1.5), up = cost[(i - 1) * W + j] + 1, left = cost[i * W + j - 1] + 1;
      const best = Math.min(diag, up, left);
      cost[i * W + j] = best;
      move[i * W + j] = best === diag ? (hit ? 0 : 3) : best === up ? 1 : 2;
    }
  }
  const pairs = [];
  for (let i = n, j = m; i > 0 && j > 0;) {
    const mv = move[i * W + j];
    if (mv === 0) { pairs.unshift([a[i - 1].at, b[j - 1].at]); i--; j--; } else if (mv === 3) { i--; j--; } else if (mv === 1) i--; else j--;
  }
  if (!pairs.length) return null;
  const fit = (list) => {
    if (list.length < 3) {
      const d = list.map(([s, c]) => c - s).sort((x, y) => x - y);
      return { rate: 1, offset: d[Math.floor(d.length / 2)] };
    }
    const k = list.length, sx = list.reduce((t, [s]) => t + s, 0), sy = list.reduce((t, [, c]) => t + c, 0);
    const sxx = list.reduce((t, [s]) => t + s * s, 0), sxy = list.reduce((t, [s, c]) => t + s * c, 0);
    const den = k * sxx - sx * sx;
    const rate = den > 1e-6 ? (k * sxy - sx * sy) / den : 1;
    return { rate, offset: (sy - rate * sx) / k };
  };
  let kept = pairs, f = fit(kept);
  // Drop the pairs that do not fit (a repeated word matched to the wrong one), then fit again.
  for (let round = 0; round < 2 && kept.length >= 3; round++) {
    const next = kept.filter(([s, c]) => Math.abs(c - (f.rate * s + f.offset)) <= 0.35);
    if (next.length === kept.length || next.length < 2) break;
    kept = next;
    f = fit(kept);
  }
  // A clip sung much faster or slower than the song is not trusted to stretch.
  if (!(f.rate >= 0.85 && f.rate <= 1.15)) {
    const d = kept.map(([s, c]) => c - s).sort((x, y) => x - y);
    f = { rate: 1, offset: d[Math.floor(d.length / 2)] };
  }
  const error = kept.reduce((t, [s, c]) => t + Math.abs(c - (f.rate * s + f.offset)), 0) / kept.length;
  return { rate: Math.round(f.rate * 1000) / 1000, offset: Math.round(f.offset * 1000) / 1000, pairs: kept.length, error: Math.round(error * 1000) / 1000 };
}
