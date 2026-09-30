// "Make a music video": a whole song, lip synced shot by shot and put together
// in the browser.
//
//   1. the song       written by the song model, picked from the library, or uploaded
//   2. the shot list  the song's timed lines cut to the lip sync model's clip
//                     lengths (music-video-plan.js), then written up by the ✨ model
//   3. the pictures   one opening frame per shot, drawn with the cast
//   4. the clips      each frame animated by a lip sync model that hears the
//                     shot's own piece of the song
//   5. the video      the clips lined up against the song (each clip keeps the
//                     piece it heard as its sound, so its exact offset can be
//                     measured) and encoded here with WebCodecs
//
// Every step is an ordinary studio request (/api/batch, /api/jobs, /api/context,
// /api/enhance, /api/media), so the same code runs against the local server,
// an account's studio and the own-key engine in this tab. Progress is kept in
// localStorage: a closed tab picks up where it stopped.
import * as P from './music-video-plan.js';

const FPS = 24;
const BATCH = 40;
const CONFIRMED = { 'x-justimagine-confirmed': '1' };

// ---------- small things ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const money = (usd) => (usd < 0.995 ? `${Math.max(1, Math.round(usd * 100))}¢` : `$${usd.toFixed(2)}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const abortError = () => Object.assign(new Error('Stopped.'), { name: 'AbortError' });
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
});
const titleOf = (text) => {
  const words = String(text || '').replace(/[^\p{L}\p{N}' -]+/gu, ' ').trim().split(/\s+/).slice(0, 5).join(' ');
  return words ? words[0].toUpperCase() + words.slice(1) : 'Music video';
};
const stampOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;

// ---------- studio calls ----------

async function call(path, body, { signal } = {}) {
  const res = await fetch(path, body === undefined ? { signal } : { method: 'POST', signal, headers: { 'content-type': 'application/json', ...CONFIRMED }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `The studio answered ${res.status}.`), { status: res.status });
  return json;
}

// Queue specs, BATCH at a time; returns one job id per spec, in order.
async function submit(specs, signal) {
  const ids = [];
  for (let i = 0; i < specs.length; i += BATCH) ids.push(...(await call('/api/batch', { items: specs.slice(i, i + BATCH) }, { signal })).jobs);
  return ids;
}

// Wait on jobs, reporting each as it settles.
async function settle(ids, { signal, onJob } = {}) {
  const open = new Set(ids.filter(Boolean)), out = new Map();
  while (open.size) {
    const list = [...open].slice(0, 120);
    const r = await call(`/api/jobs?ids=${list.join(',')}&wait=6`, undefined, { signal });
    for (const row of r.results || []) {
      onJob?.(row);
      if (['done', 'error', 'cancelled'].includes(row.status)) { out.set(row.id, row); open.delete(row.id); }
    }
    for (const id of r.missing || []) { out.set(id, { id, status: 'error', error: 'The studio lost track of this one.' }); open.delete(id); }
    if (open.size && !(r.results || []).length) await sleep(2500, signal);
  }
  return out;
}

// Encoded for a URL, and safe inside CSS url('…') too.
const enc = (s) => encodeURIComponent(String(s ?? '')).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const mediaUrl = (it, extra = '&raw=1') => `/media/${enc(it.file)}?f=${enc(it.folder || '')}${extra}`;
async function bytesOf(it, signal) {
  const res = await fetch(mediaUrl(it), { signal });
  if (!res.ok) throw new Error(`Could not read ${it.file} (${res.status}).`);
  return res.blob();
}
const blobDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// A big file goes up in pieces; see POST /api/media.
async function upload(blob, { folder, name, meta, kind, signal, onProgress }) {
  const { id } = await call('/api/media', { folder, name, size: blob.size, meta, kind }, { signal });
  const piece = 4 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += piece) {
    const part = blob.slice(at, at + piece);
    const res = await fetch(`/api/media/chunk?id=${id}&offset=${at}`, { method: 'POST', signal, headers: { 'content-type': 'application/octet-stream' }, body: part });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload stopped at ${Math.round((at / blob.size) * 100)}%.`);
    onProgress?.((at + part.size) / blob.size);
  }
  return (await call('/api/media/done', { id }, { signal })).item;
}

// ---------- audio ----------

async function decode(bytes, rate) {
  const ctx = rate ? new OfflineAudioContext(1, 1, rate) : new OfflineAudioContext(2, 1, 48000);
  return ctx.decodeAudioData(bytes);
}

// A mono 16-bit WAV of [start, start + length) of the song, silence past its end.
function wavOf(buffer, start, length) {
  const rate = buffer.sampleRate, n = Math.round(length * rate), from = Math.round(start * rate);
  const data = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) data.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); data.setUint32(4, 36 + n * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, rate, true);
  data.setUint32(28, rate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true); text(36, 'data'); data.setUint32(40, n * 2, true);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  for (let i = 0; i < n; i++) {
    const at = from + i;
    let v = 0;
    if (at < buffer.length) for (const ch of channels) v += ch[at];
    v = Math.max(-1, Math.min(1, v / channels.length));
    data.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([data.buffer], { type: 'audio/wav' });
}

function envelope(samples, hop) {
  const n = Math.floor(samples.length / hop), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop, e = j + hop; j < e; j++) s += samples[j] * samples[j];
    out[i] = Math.log(Math.sqrt(s / hop) + 1e-4);
  }
  return out;
}
// Normalised correlation of b shifted by `lag` against a.
function corrAt(a, b, lag) {
  let sa = 0, sb = 0, n = 0;
  for (let i = Math.max(0, -lag); i < a.length && i + lag < b.length; i++) { sa += a[i]; sb += b[i + lag]; n++; }
  if (n < 16) return -1;
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = Math.max(0, -lag); i < a.length && i + lag < b.length; i++) {
    const x = a[i] - ma, y = b[i + lag] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.sqrt(da * db + 1e-12);
}

// How late a clip's sound runs against the piece of song it was given, and how
// sure that is. A lip sync model keeps the piece as the clip's soundtrack, so
// the two line up at one offset; the picture is in step with the clip's own
// sound, so the clip is shifted by the same amount when it is put in place.
export async function measureOffset(clipBlob, song8k, start, length) {
  let clip;
  try { clip = (await decode(await clipBlob.arrayBuffer(), 8000)).getChannelData(0); } catch { return { offset: 0, confidence: 0 }; }
  const ref = song8k.getChannelData(0).subarray(Math.round(start * 8000), Math.round((start + length) * 8000));
  if (ref.length < 8000 || clip.length < 8000) return { offset: 0, confidence: 0 };
  // Coarse, on 10 ms loudness, within ±0.6 s; then on the waveform, ±12 ms around it.
  const ea = envelope(ref, 80), eb = envelope(clip, 80);
  let coarse = 0, best = -2;
  for (let lag = -60; lag <= 60; lag++) { const c = corrAt(ea, eb, lag); if (c > best) { best = c; coarse = lag; } }
  const a = ref.subarray(0, Math.min(ref.length, 8000 * 6)), mid = coarse * 80;
  let fine = mid, score = -2;
  for (let lag = mid - 96; lag <= mid + 96; lag += 2) { const c = corrAt(a, clip, lag); if (c > score) { score = c; fine = lag; } }
  for (let lag = fine - 2; lag <= fine + 2; lag++) { const c = corrAt(a, clip, lag); if (c > score) { score = c; fine = lag; } }
  // `phrasing` is how well the loudness follows the song even when the model
  // sang the piece again instead of keeping it; its lag lines the phrases up.
  return {
    offset: Math.round((fine / 8000) * 1000) / 1000,
    confidence: Math.round(Math.max(0, score) * 100) / 100,
    phraseOffset: Math.round(coarse * 10) / 1000,
    phrasing: Math.round(Math.max(0, best) * 100) / 100
  };
}

// ---------- pictures ----------

const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '21:9': 21 / 9 };

function drawCover(ctx, img, w, h, zoom = 1) {
  const iw = img.width, ih = img.height, scale = Math.max(w / iw, h / ih) * zoom;
  const dw = iw * scale, dh = ih * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// The opening frame, cropped to the video's shape so the clip starts on it exactly.
async function frameFor(blob, aspect) {
  const img = await createImageBitmap(blob);
  const ratio = ASPECTS[aspect] || img.width / img.height;
  const long = Math.min(1536, Math.max(img.width, img.height));
  const w = Math.round(ratio >= 1 ? long : long * ratio), h = Math.round(ratio >= 1 ? long / ratio : long);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  drawCover(canvas.getContext('2d'), img, w, h);
  img.close?.();
  return canvas.toDataURL('image/jpeg', 0.92);
}

// ---------- putting it together ----------

let mediabunny;
const loadMediabunny = () => (mediabunny ||= import('./vendor/mediabunny.js'));

export function canStitch() {
  return typeof window !== 'undefined' && window.isSecureContext && typeof VideoEncoder === 'function' && typeof AudioEncoder === 'function';
}

// The clips, each trimmed to its shot and shifted by its measured offset, on
// one steady 24 fps timeline, with the song itself as the soundtrack. A shot
// without a clip shows its picture with a slow push-in, so the video is always
// whole.
export async function stitch({ song, shots, clips, stills, size, signal, onProgress = () => {} }) {
  const MB = await loadMediabunny();
  const width = size.width - (size.width % 2), height = size.height - (size.height % 2);
  const videoCodec = await MB.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width, height });
  if (!videoCodec) throw new Error('This browser cannot make video files. Use Chrome or Edge on a computer.');
  const audioCodec = await MB.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: song.numberOfChannels, sampleRate: song.sampleRate });
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
  const video = new MB.CanvasSource(canvas, { codec: videoCodec, bitrate: MB.QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: FPS });
  const audio = audioCodec ? new MB.AudioBufferSource({ codec: audioCodec, bitrate: MB.QUALITY_HIGH }) : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();

  // Sound goes in a second at a time, kept just ahead of the picture.
  let heard = 0;
  const hearUntil = async (t) => {
    while (audio && heard < Math.min(t, song.duration) - 1e-6) {
      const len = Math.min(1, song.duration - heard), from = Math.round(heard * song.sampleRate), n = Math.round(len * song.sampleRate);
      const part = new AudioBuffer({ length: n, numberOfChannels: song.numberOfChannels, sampleRate: song.sampleRate });
      for (let c = 0; c < song.numberOfChannels; c++) part.copyToChannel(song.getChannelData(c).subarray(from, from + n), c);
      await audio.add(part);
      heard += len;
    }
  };

  const total = Math.max(1, Math.round(song.duration * FPS));
  let done = 0;
  for (const [i, shot] of shots.entries()) {
    const first = Math.round(shot.start * FPS), last = i === shots.length - 1 ? total : Math.round(shot.end * FPS);
    const times = [];
    for (let f = first; f < last; f++) times.push(f / FPS);
    if (!times.length) continue;
    const put = async (t) => {
      if (signal?.aborted) throw abortError();
      await hearUntil(t + 1);
      await video.add(t, 1 / FPS);
      if (++done % 12 === 0) onProgress(done / total);
    };
    // The clip, if it opens; a clip that will not decode falls back to its picture.
    let track = null, input = null;
    if (clips[i]) {
      input = new MB.Input({ source: new MB.BlobSource(clips[i].blob), formats: MB.ALL_FORMATS });
      track = await input.getPrimaryVideoTrack().catch(() => null);
      if (track && !(await track.canDecode().catch(() => false))) track = null;
    }
    if (track) {
      try {
        const begin = await input.getFirstTimestamp([track]), end = await input.computeDuration([track]);
        const sink = new MB.CanvasSink(track, { width, height, fit: 'cover', poolSize: 2 });
        const offset = clips[i].offset || 0, rate = clips[i].rate || 1;
        const taus = times.map((t) => Math.min(Math.max(begin, rate * (t - shot.start) + offset), Math.max(begin, end - 0.5 / FPS)));
        let j = 0;
        for await (const frame of sink.canvasesAtTimestamps(taus)) {
          if (j >= times.length) break;
          if (frame) ctx.drawImage(frame.canvas, 0, 0, width, height);
          await put(times[j++]);
        }
        for (; j < times.length; j++) await put(times[j]);
      } finally {
        input.dispose?.();
      }
    } else {
      input?.dispose?.();
      const img = stills[i] ? await createImageBitmap(stills[i]).catch(() => null) : null;
      for (const t of times) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
        if (img) drawCover(ctx, img, width, height, 1 + 0.06 * ((t - shot.start) / Math.max(0.1, shot.end - shot.start)));
        await put(t);
      }
      img?.close?.();
    }
  }
  await hearUntil(song.duration);
  video.close();
  audio?.close();
  await output.finalize();
  onProgress(1);
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

// ---------- the dialog ----------

const CSS = `
#mvMaker { position: fixed; inset: 0; z-index: 140; display: none; align-items: flex-start; justify-content: center; padding: 24px; overflow-y: auto; background: var(--scrim); backdrop-filter: blur(6px); }
#mvMaker.open { display: flex; }
#mvMaker .mv-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 24px; box-shadow: var(--shadow-lg); width: min(820px, 96vw); margin: auto; padding: 24px 26px 22px; color: var(--text); font-family: var(--sans); }
#mvMaker .mv-head { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 18px; }
#mvMaker h2 { font: 900 24px/1.05 var(--sans); letter-spacing: -.03em; margin: 0 0 6px; }
#mvMaker .hint { font-size: 12.5px; color: var(--text-2); line-height: 1.5; }
#mvMaker .mv-x { all: unset; cursor: pointer; margin-left: auto; flex: none; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; color: var(--text-3); font-size: 13px; }
#mvMaker .mv-x:hover { background: var(--surface-2); color: var(--text); }
#mvMaker .mv-sec { margin-bottom: 18px; }
#mvMaker .mv-label { font-size: 10px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; color: var(--text-3); margin-bottom: 8px; display: flex; gap: 8px; align-items: baseline; }
#mvMaker .mv-label small { text-transform: none; letter-spacing: 0; font-weight: 600; font-size: 11.5px; }
#mvMaker textarea, #mvMaker input[type=text], #mvMaker select { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); color: var(--text); padding: 9px 12px; font: 500 13px/1.45 var(--sans); outline: none; }
#mvMaker textarea { resize: vertical; min-height: 40px; }
#mvMaker textarea:focus, #mvMaker input[type=text]:focus, #mvMaker select:focus { border-color: var(--border-strong); background: var(--surface); }
#mvMaker .mv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
#mvMaker .mv-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
#mvMaker .mv-field { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; font-weight: 700; color: var(--text-2); }
#mvMaker .mv-seg { display: inline-flex; gap: 4px; padding: 3px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); flex-wrap: wrap; }
#mvMaker .mv-seg button { all: unset; cursor: pointer; padding: 6px 13px; border-radius: 999px; font-size: 12.5px; font-weight: 700; color: var(--text-2); }
#mvMaker .mv-seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
#mvMaker .mv-chips { display: flex; flex-wrap: wrap; gap: 6px; }
#mvMaker .mv-chip { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 12px 0 4px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); font-size: 12.5px; font-weight: 700; color: var(--text-2); }
#mvMaker .mv-chip img, #mvMaker .mv-chip i { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; background: var(--surface-3); display: block; }
#mvMaker .mv-chip.on { border-color: var(--accent-2); background: var(--accent-soft); color: var(--text); }
#mvMaker .mv-songs { display: grid; gap: 6px; max-height: 220px; overflow-y: auto; }
#mvMaker .mv-song { all: unset; cursor: pointer; display: flex; gap: 10px; align-items: center; padding: 9px 12px; border-radius: 12px; border: 1px solid var(--border); font-size: 12.5px; }
#mvMaker .mv-song b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
#mvMaker .mv-song span { color: var(--text-3); font-weight: 600; }
#mvMaker .mv-song.on { border-color: var(--song); box-shadow: 0 0 0 2px var(--song-soft, rgba(107,75,216,.15)); }
#mvMaker details { border-top: 1px solid var(--border); padding-top: 12px; }
#mvMaker summary { cursor: pointer; font-size: 12px; font-weight: 800; color: var(--text-2); }
#mvMaker .mv-foot { display: flex; align-items: center; gap: 10px; position: sticky; bottom: 0; z-index: 2; margin: 18px -26px -22px; padding: 14px 26px 20px; border-top: 1px solid var(--border); background: var(--surface); border-radius: 0 0 24px 24px; }
#mvMaker .mv-cost { flex: 1; font-size: 12.5px; color: var(--text-2); line-height: 1.45; }
#mvMaker .mv-cost b { color: var(--text); }
#mvMaker .mv-btn { all: unset; cursor: pointer; padding: 9px 18px; border-radius: 999px; font-size: 13px; font-weight: 700; background: var(--surface-2); color: var(--text); }
#mvMaker .mv-btn:hover { background: var(--surface-3); }
#mvMaker .mv-btn.primary { background: var(--accent); color: var(--accent-ink); font-weight: 800; }
#mvMaker .mv-btn.primary:hover { background: var(--accent-2); }
#mvMaker .mv-btn[disabled] { opacity: .45; cursor: not-allowed; }
#mvMaker .mv-note { font-size: 12px; color: var(--text-2); background: var(--surface-2); border-radius: 12px; padding: 10px 12px; line-height: 1.5; margin-top: 10px; }
#mvMaker .mv-note.warn { background: var(--danger-soft); color: var(--text); }
#mvMaker .mv-steps { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-bottom: 16px; }
#mvMaker .mv-step { border: 1px solid var(--border); border-radius: 14px; padding: 10px 11px; font-size: 11.5px; color: var(--text-3); min-height: 54px; }
#mvMaker .mv-step b { display: block; font-size: 12.5px; color: var(--text-2); margin-bottom: 3px; }
#mvMaker .mv-step.now { border-color: var(--accent-2); background: var(--accent-soft); color: var(--text-2); }
#mvMaker .mv-step.now b, #mvMaker .mv-step.done b { color: var(--text); }
#mvMaker .mv-step.done b::before { content: '✓ '; color: var(--accent-hover); }
#mvMaker .mv-step.bad { border-color: var(--danger); }
#mvMaker .mv-bar { height: 4px; border-radius: 4px; background: var(--surface-3); overflow: hidden; margin-top: 7px; }
#mvMaker .mv-bar i { display: block; height: 100%; background: var(--accent-2); width: 0; transition: width .3s var(--ease); }
#mvMaker .mv-shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; max-height: 46vh; overflow-y: auto; padding: 2px; }
#mvMaker .mv-shot { position: relative; border-radius: 12px; overflow: hidden; background: var(--surface-2); border: 1px solid var(--border); font-size: 10.5px; }
#mvMaker .mv-shot .pic { aspect-ratio: var(--mv-aspect, 16 / 9); background: var(--surface-3) center / cover no-repeat; }
#mvMaker .mv-shot .cap { padding: 6px 8px 7px; line-height: 1.3; color: var(--text-2); }
#mvMaker .mv-shot .cap b { color: var(--text); font-weight: 800; }
#mvMaker .mv-shot .cap span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); }
#mvMaker .mv-shot .state { position: absolute; top: 6px; left: 6px; padding: 2px 7px; border-radius: 999px; background: var(--glass); color: #fff; font-size: 10px; font-weight: 800; }
#mvMaker .mv-shot.done .state { background: var(--accent); color: var(--accent-ink); }
#mvMaker .mv-shot.bad .state { background: var(--danger); }
#mvMaker .mv-shot .redo { all: unset; cursor: pointer; position: absolute; top: 6px; right: 6px; padding: 2px 8px; border-radius: 999px; background: var(--surface); color: var(--text); font-size: 10px; font-weight: 800; box-shadow: var(--shadow-md); display: none; }
#mvMaker .mv-shot:hover .redo { display: block; }
#mvMaker video { width: 100%; max-height: 56vh; border-radius: 16px; background: #000; display: block; }
#mvMaker .mv-hidden { display: none !important; }
#mvChip { all: unset; cursor: pointer; position: fixed; right: 18px; bottom: 18px; z-index: 139; display: none; align-items: center; gap: 8px; padding: 9px 15px; border-radius: 999px; background: var(--ink); color: var(--ink-text); font: 800 12.5px var(--sans); box-shadow: var(--shadow-lg); }
#mvChip.on { display: inline-flex; }
@media (max-width: 720px) {
  #mvMaker { padding: 10px; }
  #mvMaker .mv-panel { padding: 18px 16px; border-radius: 20px; }
  #mvMaker .mv-foot { margin: 16px -16px -18px; padding: 12px 16px 16px; flex-wrap: wrap; }
  #mvMaker .mv-grid, #mvMaker .mv-grid3 { grid-template-columns: 1fr; }
  #mvMaker .mv-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;

const LENGTHS = [
  { id: 'clip', label: 'About 30 seconds', seconds: 30 },
  { id: 'short', label: 'About 1 minute', seconds: 60 },
  { id: 'medium', label: 'About 2 minutes', seconds: 120 },
  { id: 'full', label: 'About 3 minutes', seconds: 180 }
];
const PACES = [{ id: 4, label: 'Quick cuts' }, { id: 6, label: 'Balanced' }, { id: 9, label: 'Long takes' }];
const STEPS = [
  { id: 'song', name: 'Song' },
  { id: 'board', name: 'Shot list' },
  { id: 'stills', name: 'Pictures' },
  { id: 'clips', name: 'Lip sync' },
  { id: 'video', name: 'Your video' }
];

let open = null; // the one maker per page

export function openMusicVideoMaker(ctx) {
  if (!open) open = createMaker();
  open.show(ctx);
  return open;
}

function createMaker() {
  if (!document.getElementById('mvMakerStyle')) {
    const style = document.createElement('style');
    style.id = 'mvMakerStyle';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = document.createElement('div');
  root.id = 'mvMaker';
  root.innerHTML = '<div class="mv-panel" role="dialog" aria-modal="true" aria-labelledby="mvTitle"></div>';
  document.body.appendChild(root);
  const panel = root.firstElementChild;
  const chip = document.createElement('button');
  chip.id = 'mvChip';
  chip.type = 'button';
  document.body.appendChild(chip);
  chip.onclick = () => { root.classList.add('open'); chip.classList.remove('on'); if (project) renderRun(); };

  let ctx = {};
  let state = null; // the studio's /api/state
  let view = 'setup'; // or 'run'
  let form = null; // the setup choices
  let project = null; // what is being made, saved as it goes
  let running = null; // { ctrl } while the pipeline runs
  let songs = []; // the library's songs, for "From your library"
  let uploadFile = null; // a song chosen with "Upload a song"
  const store = () => `justimagine:music-video:${state?.preferenceScope || 'local'}`;
  const save = () => { try { if (project) localStorage.setItem(store(), JSON.stringify({ ...project, resultUrl: undefined })); } catch { /* full; the run still works */ } };
  const loadSaved = () => { try { return JSON.parse(localStorage.getItem(store()) || 'null'); } catch { return null; } };

  const hide = () => {
    root.classList.remove('open');
    if (running || project?.status === 'done') { chip.classList.add('on'); chipText(); }
  };
  root.addEventListener('mousedown', (e) => { if (e.target === root && view === 'setup') hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.classList.contains('open')) hide(); });

  // ---------- what the studio offers ----------

  const cloud = () => document.body.dataset.studio === 'cloud';
  const hasKey = (m) => m.hasKey !== false;
  const lipSyncModels = () => (state.videoModels || []).filter((m) => P.isLipSyncModel(m) && hasKey(m) && (m.api === 'openlux' || m.adapter || state.audioRelay));
  const songModels = () => (state.songModels || []).filter(hasKey);
  const imageChoices = () => (state.apis || []).filter((a) => a.hasKey !== false && !a.voice).flatMap((a) => (a.models || []).filter((m) => !m.kind || m.kind === 'image').map((m) => ({ ...m, api: a.id, apiName: a.name })));
  const pickDefault = (list, tests) => { for (const t of tests) { const m = list.find(t); if (m) return m; } return list[0] || null; };
  const defaultLipSync = () => pickDefault(lipSyncModels(), [(m) => /seedance-2-0-fast/.test(m.id), (m) => /seedance-2\.0-fast/.test(m.id), (m) => /mini/.test(m.id)]);
  const defaultImage = () => pickDefault(imageChoices(), [(m) => /gemini-3\.1-flash-image(-preview)?$/.test(m.id), (m) => /gemini-3-pro-image/.test(m.id), (m) => /gemini.*image|banana/i.test(m.id)]);
  const storyboardReady = () => !!(state.storyboardReady ?? state.enhanceReady);
  const castById = (id) => (state.characters || []).find((c) => c.id === id);

  // ---------- the setup form ----------

  function defaults() {
    const lip = (ctx.model && lipSyncModels().find((m) => m.id === ctx.model && (!ctx.api || m.api === ctx.api))) || defaultLipSync();
    const img = defaultImage();
    return {
      source: ctx.song ? 'library' : 'new',
      librarySong: ctx.song ? { ...ctx.song, folder: ctx.song.folder || '' } : null,
      idea: '',
      lyrics: ctx.song ? '' : ctx.lyrics || '',
      style: ctx.musicStyle || '',
      vocals: ctx.vocals && ctx.vocals !== 'auto' ? ctx.vocals : '',
      length: 'medium',
      scene: ctx.prompt || '',
      cast: [...(ctx.picked || [])].filter(castById),
      aspect: ASPECTS[ctx.aspect] ? ctx.aspect : '16:9',
      pace: 6,
      lipModel: lip ? `${lip.api}|${lip.id}` : '',
      resolution: lip?.resolutions?.includes(ctx.resolution) ? ctx.resolution : lip?.resolutions?.includes('720p') ? '720p' : lip?.resolutions?.[0] || '720p',
      imageModel: img ? `${img.api}|${img.id}` : '',
      uploadName: '',
      modelsOpen: false
    };
  }
  const split = (v) => { const i = String(v || '').indexOf('|'); return i < 0 ? ['', String(v || '')] : [v.slice(0, i), v.slice(i + 1)]; };
  const lipOf = (f) => { const [api, id] = split(f.lipModel); return lipSyncModels().find((m) => m.id === id && m.api === api) || null; };
  const imageOf = (f) => { const [api, id] = split(f.imageModel); return imageChoices().find((m) => m.id === id && m.api === api) || null; };
  const songModelFor = (f) => {
    const list = songModels();
    return f.length === 'clip' ? list.find((m) => m.clipSeconds) || list[0] : list.find((m) => !m.clipSeconds) || list[0];
  };
  const sameSong = (a, b) => a && b && a.file === b.file && (a.folder || '') === (b.folder || '');

  async function loadSongs() {
    try {
      const r = await call('/api/items?folder=&deep=1&limit=500');
      songs = (r.items || []).filter((it) => it.kind === 'song').slice(0, 200);
    } catch { songs = []; }
    if (form?.librarySong && !songs.some((s) => sameSong(s, form.librarySong))) songs.unshift(form.librarySong);
  }

  function estimate(f, shots = null) {
    const lip = lipOf(f), img = imageOf(f);
    const seconds = f.source === 'new' ? LENGTHS.find((l) => l.id === f.length).seconds : f.librarySong?.duration || 120;
    const planned = shots || Array.from({ length: Math.max(1, Math.round(seconds / f.pace)) }, () => ({ clip: Math.ceil(f.pace * 1.08) }));
    const song = f.source === 'new' ? songModelFor(f)?.pricing : null;
    return { ...P.estimateCost({ shots: planned, songPricing: song, newSong: f.source === 'new', imagePricing: img?.pricing, videoPricing: lip?.pricing, resolution: f.resolution }), seconds };
  }

  const segmented = (name, options, value) => `<div class="mv-seg" data-seg="${name}">${options.map((o) => `<button type="button" data-v="${esc(o.id)}" class="${String(o.id) === String(value) ? 'on' : ''}">${esc(o.label)}</button>`).join('')}</div>`;

  function blockedReason(f) {
    if (!canStitch()) return 'Putting the video together needs a browser that can make video files, such as Chrome or Edge on a computer, on a secure page (https or localhost).';
    if (!lipSyncModels().length) {
      return cloud()
        ? 'Music videos need a lip sync model, and accounts do not have one yet. Use your own key to make one now.'
        : 'Music videos need a lip sync model: Seedance 2 on OpenRouter or OpenLux. Add a key in Settings.';
    }
    if (f.source === 'new' && !songModels().length) return 'A new song needs an OpenRouter key. Add one in Settings, or use a song you already have.';
    if (!imageChoices().length) return 'The pictures need an image model. Add a key in Settings.';
    return '';
  }

  function renderSetup() {
    view = 'setup';
    const f = form, lips = lipSyncModels(), images = imageChoices(), cast = state.characters || [], lip = lipOf(f);
    const blocked = blockedReason(f);
    panel.innerHTML = `
      <div class="mv-head">
        <div><h2 id="mvTitle">Make a music video</h2>
          <div class="hint">A whole song with your cast. We plan the shots, draw each one, lip sync every shot to the song and put it all together here in your browser.</div></div>
        <button class="mv-x" type="button" data-act="close" aria-label="Close">✕</button>
      </div>
      ${blocked ? `<div class="mv-note warn">${esc(blocked)}</div>` : ''}
      <div class="mv-sec">
        <div class="mv-label">The song</div>
        ${segmented('source', [{ id: 'new', label: 'New song' }, { id: 'library', label: 'From your library' }, { id: 'upload', label: 'Upload a song' }], f.source)}
        <div style="margin-top:10px">
          ${f.source === 'new' ? `
            <div class="mv-grid">
              <label class="mv-field">What is it about?<textarea data-f="idea" rows="2" placeholder="A bouncy anthem about a marshmallow crew who love the gym">${esc(f.idea)}</textarea></label>
              <label class="mv-field">Style<textarea data-f="style" rows="2" placeholder="Upbeat pop funk, slap bass, bright synth brass, handclaps">${esc(f.style)}</textarea></label>
            </div>
            <div class="mv-grid" style="margin-top:10px">
              <label class="mv-field">Lyrics<textarea data-f="lyrics" rows="4" placeholder="Leave empty and the song model writes them">${esc(f.lyrics)}</textarea></label>
              <div style="display:grid;gap:10px;align-content:start">
                <label class="mv-field">Length<select data-f="length">${LENGTHS.map((l) => `<option value="${l.id}" ${l.id === f.length ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}</select></label>
                <label class="mv-field">Voice<input type="text" data-f="vocals" value="${esc(f.vocals)}" placeholder="Warm, cheerful group vocals"></label>
              </div>
            </div>` : ''}
          ${f.source === 'library' ? (songs.length
            ? `<div class="mv-songs">${songs.map((s, i) => `<button type="button" class="mv-song ${sameSong(s, f.librarySong) ? 'on' : ''}" data-song="${i}"><b>${esc(s.prompt || s.file)}</b><span>${s.duration ? clock(s.duration) : ''}</span></button>`).join('')}</div>`
            : '<div class="mv-note">No songs in your library yet. Make a new one, or upload one.</div>') : ''}
          ${f.source === 'upload' ? `
            <div class="mv-grid">
              <label class="mv-field">Your song<input type="file" data-f="file" accept="audio/*">${f.uploadName ? `<small>${esc(f.uploadName)}</small>` : ''}</label>
              <label class="mv-field">Lyrics<textarea data-f="lyrics" rows="3" placeholder="Optional. Lines with [mm:ss] times line up best.">${esc(f.lyrics)}</textarea></label>
            </div>` : ''}
        </div>
      </div>
      <div class="mv-sec">
        <div class="mv-label">Who is in it <small>${cast.length ? 'Pick one or more. The singers come from here.' : 'Add characters in the Cast tab to star in your video.'}</small></div>
        <div class="mv-chips">${cast.map((c) => `<button type="button" class="mv-chip ${f.cast.includes(c.id) ? 'on' : ''}" data-cast="${esc(c.id)}">${c.cover ? `<img src="/charref/${enc(c.cover)}?c=${enc(c.id)}" alt="">` : '<i></i>'}${esc(c.name)}</button>`).join('')}</div>
      </div>
      <div class="mv-sec">
        <div class="mv-label">The look</div>
        <textarea data-f="scene" rows="2" placeholder="Where it happens, the mood and the story. A sunny gym, then a neon rooftop party at night.">${esc(f.scene)}</textarea>
        <div class="mv-grid" style="margin-top:10px">
          <div class="mv-field">Shape ${segmented('aspect', [{ id: '16:9', label: 'Wide 16:9' }, { id: '9:16', label: 'Tall 9:16' }, { id: '1:1', label: 'Square' }], f.aspect)}</div>
          <div class="mv-field">Cuts ${segmented('pace', PACES, f.pace)}</div>
        </div>
      </div>
      <details class="mv-sec" data-models ${f.modelsOpen ? 'open' : ''}>
        <summary>Models and quality</summary>
        <div class="mv-grid3" style="margin-top:10px">
          <label class="mv-field">Lip sync<select data-f="lipModel">${lips.map((m) => `<option value="${esc(m.api)}|${esc(m.id)}" ${`${m.api}|${m.id}` === f.lipModel ? 'selected' : ''}>${esc(m.name || m.id)}${lips.some((x) => x !== m && (x.name || x.id) === (m.name || m.id)) ? ` · ${esc(m.api)}` : ''}</option>`).join('')}</select></label>
          <label class="mv-field">Quality<select data-f="resolution">${(lip?.resolutions || ['720p']).filter((r) => r !== '4K').map((r) => `<option ${r === f.resolution ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
          <label class="mv-field">Pictures<select data-f="imageModel">${images.map((m) => `<option value="${esc(m.api)}|${esc(m.id)}" ${`${m.api}|${m.id}` === f.imageModel ? 'selected' : ''}>${esc(m.name || m.id)} · ${esc(m.apiName || m.api)}</option>`).join('')}</select></label>
        </div>
        ${lip && lip.api !== 'openlux' && !lip.adapter ? `<div class="mv-note">OpenRouter needs a web link to hear each piece of your song. Each piece is kept at a private link for about an hour, then deleted.${document.body.dataset.studio === 'own-key' ? ' Your key never leaves this browser.' : ''}</div>` : ''}
      </details>
      <div class="mv-foot">
        <div class="mv-cost" data-cost></div>
        <button class="mv-btn" type="button" data-act="close">Cancel</button>
        <button class="mv-btn primary" type="button" data-act="start" ${blocked ? 'disabled' : ''}>Make my video</button>
      </div>`;
    updateCost();
  }

  function updateCost() {
    const box = panel.querySelector('[data-cost]');
    if (!box || !form) return;
    const e = estimate(form);
    box.innerHTML = cloud()
      ? `${plural(e.shots, 'shot')}, about ${clock(e.seconds)} of video.`
      : `About <b>${money(e.usd)}</b>${e.complete ? '' : ', plus models with no listed price,'} for ${plural(e.shots, 'shot')} and ${clock(e.seconds)} of video. You pay your provider directly.`;
  }

  function clickSetup(t) {
    if (t.dataset.act === 'close') return hide();
    if (t.dataset.act === 'start') return start();
    if (t.dataset.song != null) { form.librarySong = songs[Number(t.dataset.song)] || null; renderSetup(); return; }
    if (t.dataset.cast) {
      const id = t.dataset.cast;
      form.cast = form.cast.includes(id) ? form.cast.filter((x) => x !== id) : [...form.cast, id];
      t.classList.toggle('on', form.cast.includes(id));
      return;
    }
    const seg = t.closest('[data-seg]');
    if (seg) {
      const name = seg.dataset.seg, v = t.dataset.v;
      form[name] = name === 'pace' ? Number(v) : v;
      if (name === 'source' && v === 'library' && !songs.length) { loadSongs().then(renderSetup); return; }
      renderSetup();
    }
  }
  panel.addEventListener('click', (e) => {
    const t = e.target.closest('button,a');
    if (!t) return;
    if (view === 'setup') clickSetup(t);
    else clickRun(t, e);
  });
  panel.addEventListener('input', (e) => {
    const k = e.target.dataset?.f;
    if (view !== 'setup' || !k || k === 'file') return;
    form[k] = e.target.value;
    if (k === 'lipModel') {
      const lip = lipOf(form);
      if (!lip?.resolutions?.includes(form.resolution)) form.resolution = lip?.resolutions?.includes('720p') ? '720p' : lip?.resolutions?.[0] || '720p';
      renderSetup();
      return;
    }
    if (['length', 'resolution', 'imageModel'].includes(k)) updateCost();
  });
  panel.addEventListener('toggle', (e) => { if (view === 'setup' && form && e.target.matches?.('[data-models]')) form.modelsOpen = e.target.open; }, true);
  panel.addEventListener('change', (e) => {
    if (view !== 'setup' || e.target.dataset?.f !== 'file') return;
    uploadFile = e.target.files?.[0] || null;
    form.uploadName = uploadFile?.name || '';
    updateCost();
  });

  // ---------- running ----------

  function start() {
    const f = form, lip = lipOf(f), img = imageOf(f);
    if (!lip || !img) return ctx.toast?.('Pick a lip sync model and a picture model first.');
    if (f.source === 'library' && !f.librarySong?.file) return ctx.toast?.('Pick a song from your library.');
    if (f.source === 'upload' && !uploadFile) return ctx.toast?.('Choose the song to upload.');
    if (f.source === 'new' && !f.idea.trim() && !f.lyrics.trim() && !f.style.trim()) return ctx.toast?.('Say what the song is about, or add its lyrics.');
    const title = titleOf(f.source === 'library' ? f.librarySong.prompt : f.source === 'upload' ? f.uploadName.replace(/\.[a-z0-9]+$/i, '') : f.idea || f.style);
    project = {
      v: 1, created: Date.now(), status: 'running', step: 'song', error: '',
      title, folder: `Music videos/${title} ${stampOf()}`,
      settings: { ...f, librarySong: undefined, lip: { id: lip.id, api: lip.api, name: lip.name, durations: lip.durations, pricing: lip.pricing }, image: { id: img.id, api: img.api, pricing: img.pricing } },
      estimate: estimate(f).usd,
      song: f.source === 'library' ? { ...f.librarySong } : null,
      shots: [], board: null, final: null, progress: {}
    };
    save();
    run();
  }

  async function run() {
    const ctrl = new AbortController();
    running = { ctrl };
    project.status = 'running';
    project.error = '';
    save();
    renderRun();
    try {
      await pipeline(ctrl.signal);
      project.status = 'done';
    } catch (e) {
      project.status = e.name === 'AbortError' ? 'stopped' : 'failed';
      project.error = e.name === 'AbortError' ? '' : e.message || String(e);
    } finally {
      running = null;
      save();
      if (view === 'run') renderRun();
      chipText();
      if (!root.classList.contains('open') && project?.status === 'done') chip.classList.add('on');
    }
  }

  const progress = (step, text, fraction) => {
    project.step = step;
    project.progress[step] = { text, fraction };
    save();
    updateSteps();
    chipText();
  };

  async function pipeline(signal) {
    const s = project.settings;

    // 1. The song.
    if (!project.song?.file) {
      if (s.source === 'upload') {
        if (!uploadFile) throw new Error('Choose the song again with "Start over". Its file is not kept between visits.');
        progress('song', 'Adding your song', 0);
        project.song = await upload(uploadFile, { folder: project.folder, name: s.uploadName, kind: 'song', meta: { lyrics: s.lyrics || undefined, prompt: project.title }, signal, onProgress: (p) => progress('song', 'Adding your song', p) });
      } else {
        const model = songModelFor(s);
        if (!model) throw new Error('No song model is available.');
        progress('song', 'Writing the song', 0.1);
        const prompt = [s.idea.trim(), s.style.trim()].filter(Boolean).join('. ');
        if (!project.song?.job) {
          const [job] = await submit([{ kind: 'song', model: model.id, prompt: prompt || project.title, lyrics: s.lyrics.trim() || undefined, vocals: s.vocals.trim() || undefined, length: model.clipSeconds ? undefined : s.length, folder: project.folder, count: 1 }], signal);
          project.song = { job };
          save();
        }
        const done = (await settle([project.song.job], { signal, onJob: (j) => progress('song', j.status === 'running' ? 'Writing the song' : 'Waiting its turn', 0.35) })).get(project.song.job);
        if (done?.status !== 'done' || !done.item) { project.song = null; throw new Error(`The song did not come out: ${done?.error || 'no reason given'}`); }
        project.song = done.item;
      }
      save();
    }
    // 2. The shot list, cut at the song's own timings.
    const songBytes = await (await bytesOf(project.song, signal)).arrayBuffer();
    const song = await decode(songBytes.slice(0));
    const song8k = await decode(songBytes.slice(0), 8000);
    progress('song', `Ready · ${clock(song.duration)}`, 1);
    if (!project.shots.length) {
      const parsed = P.parseTimedLyrics(project.song.sung || project.song.lyrics || s.lyrics || '');
      let lines = parsed.timed ? parsed.lines : null;
      // Listen for when each word is sung. Lyrics with no times (Lyria 3 Pro
      // gives none, nor does a song brought in) are lined up with that, and
      // the words line up any clip that sings its piece again later on.
      if (state.transcribeReady !== false && !project.words) {
        progress('song', 'Timing the lyrics', 0.95);
        try {
          project.words = (await call('/api/transcribe', { folder: project.song.folder || '', file: project.song.file }, { signal })).words || [];
          save();
        } catch (e) {
          if (e.name === 'AbortError') throw e;
        }
      }
      if (!lines && project.words?.length) {
        const aligned = parsed.lines.length ? P.alignLyrics(parsed.lines, project.words, song.duration) : null;
        lines = aligned?.lines || (project.words.length >= 4 ? P.linesFromWords(project.words) : null);
        project.timing = aligned ? { heard: aligned.heard } : lines ? { fromWords: true } : null;
      }
      if (!lines) lines = P.spreadLines(parsed.lines, song.duration);
      progress('song', `Ready · ${clock(song.duration)}`, 1);
      const shots = P.planShots({ duration: song.duration, lines, durations: s.lip.durations || [4, 5, 6, 7, 8, 9, 10, 11, 12], pace: s.pace });
      const cost = P.estimateCost({ shots, imagePricing: s.image.pricing, videoPricing: s.lip.pricing, resolution: s.resolution, newSong: false }).usd;
      // A song that came out much longer than asked for costs more; say so first.
      if (!cloud() && project.estimate && cost > project.estimate * 1.3 + 0.5 && !project.approvedCost) {
        if (!confirm(`The song is ${clock(song.duration)}, longer than planned. The video will cost about ${money(cost)}. Keep going?`)) throw abortError();
        project.approvedCost = cost;
      }
      project.shots = shots.map((x) => ({ ...x }));
      save();
      renderRun();
    }
    const shots = project.shots;

    if (!project.board) {
      progress('board', `Planning ${plural(shots.length, 'shot')}`, 0.3);
      let board = null;
      if (storyboardReady()) {
        try {
          board = (await call('/api/enhance', { kind: 'storyboard', song: { title: project.title, style: s.style || project.song.prompt || '' }, shots, characters: s.cast, idea: s.scene, aspect: s.aspect }, { signal })).board;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
        }
      }
      const cast = s.cast.map(castById).filter(Boolean).map((c) => ({ name: c.name, description: c.description }));
      project.board = board || P.fallbackStoryboard({ shots, cast, idea: s.scene, title: project.title });
      save();
      renderRun();
    }
    progress('board', `${plural(shots.length, 'shot')} planned`, 1);
    const boardShot = (x) => project.board.shots.find((y) => y.n === x.n) || {};

    // 3. One opening picture per shot, with the cast who are in it.
    const idOf = (name) => (state.characters || []).find((c) => c.name === name)?.id;
    await makeAll('stills', shots, {
      label: (n, total) => (n === total ? `${plural(total, 'picture')} ready` : `${n} of ${total} drawn`),
      has: (x) => !!x.still,
      spec: (x) => {
        const b = boardShot(x);
        const cast = (b.cast || []).map(idOf).filter(Boolean);
        return { kind: 'image', api: s.image.api, model: s.image.id, prompt: P.keyframePrompt(b, project.board, s.aspect), characters: cast.length ? cast : s.cast, folder: project.folder, count: 1 };
      },
      keep: (x, item) => { x.still = { folder: item.folder, file: item.file }; }
    }, signal);

    // 4. Each picture, lip synced to its own piece of the song.
    await makeAll('clips', shots, {
      label: (n, total) => (n === total ? `${plural(total, 'shot')} lip synced` : `${n} of ${total} lip synced`),
      has: (x) => !!x.take,
      prepare: async (x) => {
        if (!x.frame) x.frame = (await call('/api/context', { dataUrl: await frameFor(await bytesOf(x.still, signal), s.aspect) }, { signal })).file;
        if (!x.piece) {
          const w = P.audioWindow(x);
          x.piece = (await call('/api/context', { dataUrl: await blobDataUrl(wavOf(song, w.start, w.length)) }, { signal })).file;
        }
      },
      spec: (x) => ({ kind: 'video', api: s.lip.api, model: s.lip.id, prompt: P.motionPrompt(boardShot(x)), images: [x.frame], firstFrame: true, audioRef: x.piece, duration: x.clip, resolution: s.resolution, aspectRatio: s.aspect, audio: true, folder: project.folder, count: 1 }),
      keep: (x, item) => { x.take = { folder: item.folder, file: item.file }; x.offset = undefined; x.sync = undefined; }
    }, signal);

    // 5. Line every clip up against the song, and put it together.
    progress('video', 'Lining up each shot', 0);
    const clips = [], stills = [];
    for (const [i, x] of shots.entries()) {
      if (x.take) {
        const blob = await bytesOf(x.take, signal);
        if (x.offset === undefined) {
          const m = await measureOffset(blob, song8k, x.start, P.audioWindow(x).length);
          Object.assign(x, { sync: m.confidence, phrasing: m.phrasing, rate: 1 });
          if (m.confidence >= 0.3) Object.assign(x, { offset: m.offset, aligned: 'sound' });
          else {
            // The model sang the piece again: line its words up with the song's.
            const shift = project.words?.length ? await wordsShift(blob, x, signal) : null;
            if (shift) Object.assign(x, { offset: shift.offset, rate: shift.rate, aligned: 'words', pairs: shift.pairs });
            else Object.assign(x, { offset: m.phrasing >= 0.4 ? m.phraseOffset : 0, aligned: m.phrasing >= 0.4 ? 'phrasing' : '' });
          }
          save();
        }
        clips[i] = { blob, offset: x.offset, rate: x.rate || 1 };
      } else if (x.still) stills[i] = await bytesOf(x.still, signal).catch(() => null);
      progress('video', 'Lining up each shot', ((i + 1) / shots.length) * 0.1);
    }
    renderShots();
    const first = clips.find(Boolean);
    const size = first ? await sizeOf(first.blob) : sizeFor(s.aspect, s.resolution);
    const out = await stitch({ song, shots, clips, stills, size, signal, onProgress: (p) => progress('video', `Putting it together · ${Math.round(p * 100)}%`, 0.1 + p * 0.8) });
    progress('video', 'Saving', 0.92);
    const title = project.board.title || project.title;
    const meta = {
      prompt: `${title}, a music video`, title, workflow: 'music-video-song',
      duration: song.duration, aspectRatio: s.aspect, resolution: s.resolution, model: s.lip.id,
      lyrics: project.song.lyrics, characters: s.cast.map(castById).filter(Boolean).map((c) => c.name),
      song: { folder: project.song.folder || '', file: project.song.file },
      shots: shots.map((x) => ({ n: x.n, start: x.start, end: x.end, clip: x.take?.file, still: x.still?.file, singer: boardShot(x).singer || undefined, offset: x.offset, rate: x.rate, aligned: x.aligned || undefined }))
    };
    project.final = await upload(out, { folder: project.folder, name: `${title}.mp4`, meta, signal, onProgress: (p) => progress('video', `Saving · ${Math.round(p * 100)}%`, 0.92 + p * 0.08) });
    project.resultUrl = URL.createObjectURL(out);
    progress('video', `${clock(song.duration)} · ${plural(shots.length, 'shot')}`, 1);
    ctx.refresh?.(project.folder);
  }

  // What a clip sings, and where: its sound, heard, against the song's words
  // for the same stretch. Null when too little of it lines up to trust.
  async function wordsShift(blob, x, signal) {
    try {
      const sound = await decode(await blob.arrayBuffer(), 16000);
      const heard = (await call('/api/transcribe', { dataUrl: await blobDataUrl(wavOf(sound, 0, sound.duration)) }, { signal })).words || [];
      const end = x.start + P.audioWindow(x).length;
      const songWords = project.words.filter((w) => w.start >= x.start - 0.2 && w.start < end).map((w) => ({ word: w.word, start: w.start - x.start }));
      const shift = P.wordShift(songWords, heard);
      return shift && shift.pairs >= 2 && shift.error <= 0.3 ? shift : null;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return null;
    }
  }

  // Queue everything a step still needs, retry what fails once, and wait.
  async function makeAll(step, shots, { label, has, prepare, spec, keep }, signal) {
    const total = shots.length, jobKey = `${step}Job`;
    const count = () => shots.filter(has).length;
    progress(step, label(count(), total), count() / total);
    for (let attempt = 0; attempt < 2; attempt++) {
      const todo = shots.filter((x) => !has(x));
      if (!todo.length) break;
      // Jobs already queued (a reload mid-step) are waited on, not queued again.
      const fresh = todo.filter((x) => !x[jobKey]);
      for (const x of fresh) {
        if (prepare) await prepare(x);
        x.error = '';
      }
      save();
      if (fresh.length) {
        const ids = await submit(fresh.map(spec), signal);
        fresh.forEach((x, i) => { x[jobKey] = ids[i]; });
        save();
      }
      const results = await settle(todo.map((x) => x[jobKey]), {
        signal,
        onJob: (j) => {
          const x = shots.find((y) => y[jobKey] === j.id);
          if (!x) return;
          // Each one counts the moment it lands, not when the whole step does.
          if (j.status === 'done' && j.item && !has(x)) {
            keep(x, j.item);
            x.phase = '';
            save();
            renderShots();
            progress(step, label(count(), total), count() / total);
            return;
          }
          const phase = j.status === 'running' ? j.phase || 'working' : j.status === 'queued' ? 'waiting its turn' : '';
          if (phase !== x.phase) { x.phase = phase; renderShots(); }
        }
      });
      for (const x of todo) {
        const r = results.get(x[jobKey]);
        x[jobKey] = undefined;
        x.phase = '';
        if (has(x)) continue;
        if (r?.status === 'done' && r.item) keep(x, r.item);
        else x.error = r?.error || 'It did not come back.';
      }
      save();
      renderShots();
      progress(step, label(count(), total), count() / total);
      if (results.size && [...results.values()].every((r) => r.status === 'cancelled')) throw abortError();
    }
    const missing = shots.filter((x) => !has(x));
    // A shot with no clip still shows its picture; a shot with no picture stops the run.
    if (missing.length && (step === 'stills' || missing.length === shots.length)) {
      throw new Error(`${plural(missing.length, 'shot')} could not be made. ${missing[0].error}`);
    }
  }

  async function sizeOf(blob) {
    const MB = await loadMediabunny();
    const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
    try {
      const t = await input.getPrimaryVideoTrack();
      return { width: await t.getDisplayWidth(), height: await t.getDisplayHeight() };
    } finally { input.dispose?.(); }
  }
  const sizeFor = (aspect, res) => {
    const px = { '480p': 480, '720p': 720, '1080p': 1080 }[res] || 720, r = ASPECTS[aspect] || 16 / 9;
    return r >= 1 ? { width: Math.round((px * r) / 2) * 2, height: px } : { width: px, height: Math.round(px / r / 2) * 2 };
  };

  // ---------- the running view ----------

  function chipText() {
    if (!project) return;
    const now = STEPS.find((x) => x.id === project.step), p = project.progress?.[project.step];
    chip.textContent = running
      ? `Music video · ${now?.name || ''}${p?.fraction != null ? ` ${Math.round(p.fraction * 100)}%` : ''}`
      : project.status === 'done' ? 'Your music video is ready' : 'Music video';
  }

  const headline = () => project.status === 'done'
    ? 'Your music video is ready and saved in your library.'
    : project.status === 'failed' ? 'Something went wrong. Everything made so far is kept, so keeping going only makes what is missing.'
      : project.status === 'stopped' ? 'Stopped. Everything made so far is kept.'
        : 'You can close this window. It keeps going while this tab stays open.';

  function renderRun() {
    if (!project) return;
    view = 'run';
    panel.style.setProperty('--mv-aspect', String(project.settings.aspect || '16:9').replace(':', ' / '));
    const done = project.status === 'done';
    const src = project.resultUrl || (project.final ? mediaUrl(project.final, '') : '');
    panel.innerHTML = `
      <div class="mv-head">
        <div><h2 id="mvTitle">${esc(project.board?.title || project.title)}</h2><div class="hint" data-headline>${esc(headline())}</div></div>
        <button class="mv-x" type="button" data-act="hide" aria-label="Close">✕</button>
      </div>
      <div class="mv-steps" data-steps></div>
      <div data-error></div>
      ${done && src ? `<video src="${esc(src)}" controls playsinline></video>` : ''}
      <div class="mv-shots" data-shots style="${done ? 'margin-top:14px;max-height:30vh' : ''}"></div>
      <div class="mv-foot" data-foot></div>`;
    updateSteps();
    renderShots();
  }

  function updateSteps() {
    if (view !== 'run' || !project) return;
    const box = panel.querySelector('[data-steps]');
    if (!box) return;
    const at = STEPS.findIndex((x) => x.id === project.step), done = project.status === 'done';
    box.innerHTML = STEPS.map((x, i) => {
      const p = project.progress?.[x.id];
      const cls = done || i < at ? 'done' : i === at ? (project.status === 'failed' ? 'bad' : 'now') : '';
      return `<div class="mv-step ${cls}"><b>${esc(x.name)}</b>${esc(p?.text || '')}${i === at && !done && p?.fraction != null ? `<div class="mv-bar"><i style="width:${Math.round(p.fraction * 100)}%"></i></div>` : ''}</div>`;
    }).join('');
    panel.querySelector('[data-headline]').textContent = headline();
    panel.querySelector('[data-error]').innerHTML = project.error ? `<div class="mv-note warn">${esc(project.error)}</div>` : '';
    const dl = project.resultUrl || (project.final ? mediaUrl(project.final, '&dl=1') : '');
    panel.querySelector('[data-foot]').innerHTML = `
      <div class="mv-cost">${done && project.final ? `Saved in <b>${esc(project.final.folder)}</b>` : project.shots.length ? plural(project.shots.length, 'shot') : ''}</div>
      ${running ? '<button class="mv-btn" type="button" data-act="stop">Stop</button>' : ''}
      ${!running && !done ? '<button class="mv-btn" type="button" data-act="new">Start over</button><button class="mv-btn primary" type="button" data-act="resume">Keep going</button>' : ''}
      ${done ? `<button class="mv-btn" type="button" data-act="new">Make another</button>${ctx.show && project.final ? '<button class="mv-btn" type="button" data-act="library">Show in library</button>' : ''}${dl ? `<a class="mv-btn primary" href="${esc(dl)}" download="${esc((project.board?.title || project.title).replace(/[\\/:*?"<>|]+/g, ' '))}.mp4">Download</a>` : ''}` : ''}`;
  }

  function renderShots() {
    const box = view === 'run' && panel.querySelector('[data-shots]');
    if (!box || !project) return;
    box.innerHTML = project.shots.map((x) => {
      const b = project.board?.shots?.find((y) => y.n === x.n) || {};
      const label = x.take ? (x.offset !== undefined && !x.aligned ? 'Check the sync' : 'Done') : x.error ? 'Failed' : x.phase ? x.phase : x.still ? 'Picture ready' : 'Waiting';
      const cls = x.take ? 'done' : x.error ? 'bad' : '';
      const pic = x.still ? ` style="background-image:url('${esc(mediaUrl(x.still, ''))}')"` : '';
      return `<div class="mv-shot ${cls}" title="${esc(x.error || '')}"><div class="pic"${pic}></div><span class="state">${esc(label)}</span>${!running && x.still ? `<button type="button" class="redo" data-redo="${x.n}" title="Make this shot's clip again">Redo</button>` : ''}
        <div class="cap"><b>${clock(x.start)}–${clock(x.end)}</b>${b.singer ? ` · ${esc(b.singer)}` : ''}<span>${esc(x.lines.join(' / ') || 'Music')}</span></div></div>`;
    }).join('');
  }

  function clickRun(t) {
    const act = t.dataset.act;
    if (act === 'hide') return hide();
    if (act === 'library') { hide(); ctx.show?.(project.final.folder); return; }
    if (act === 'stop' && running) {
      running.ctrl.abort();
      const ids = project.shots.flatMap((x) => [x.stillsJob, x.clipsJob]).filter(Boolean);
      if (project.song?.job) ids.push(project.song.job);
      if (ids.length) call('/api/cancel', { ids }).catch(() => {});
      return;
    }
    if (act === 'resume' && !running) return run();
    if (act === 'new' && !running) {
      if (project?.resultUrl) URL.revokeObjectURL(project.resultUrl);
      project = null;
      try { localStorage.removeItem(store()); } catch { /* ignore */ }
      form = defaults();
      renderSetup();
      return;
    }
    if (t.dataset.redo && !running) {
      const x = project.shots.find((y) => y.n === Number(t.dataset.redo));
      if (!x) return;
      // A new take of this clip; the picture stays. Then it is all put together again.
      Object.assign(x, { take: undefined, offset: undefined, sync: undefined, rate: undefined, aligned: undefined, error: '' });
      if (project.resultUrl) URL.revokeObjectURL(project.resultUrl);
      Object.assign(project, { final: null, resultUrl: undefined, status: 'running' });
      delete project.progress.video;
      run();
    }
  }

  // ---------- opening ----------

  async function show(next = {}) {
    ctx = next;
    root.classList.add('open');
    chip.classList.remove('on');
    if (running) return renderRun();
    view = 'loading';
    panel.innerHTML = '<div class="hint" style="padding:30px 4px">Getting ready…</div>';
    try {
      state = await call('/api/state');
    } catch (e) {
      panel.innerHTML = `<div class="mv-head"><div class="mv-note warn">${esc(e.message)}</div><button class="mv-x" type="button" data-act="close" aria-label="Close">✕</button></div>`;
      view = 'setup';
      return;
    }
    // An unfinished video comes back first, unless a song was picked to start a new one.
    const saved = project?.status === 'done' && !ctx.song ? project : !ctx.song && loadSaved();
    if (saved && saved.v === 1 && (saved.status !== 'done' || saved === project)) {
      project = saved;
      return renderRun();
    }
    project = null;
    form = defaults();
    if (form.source === 'library') await loadSongs();
    renderSetup();
  }

  return { show };
}
