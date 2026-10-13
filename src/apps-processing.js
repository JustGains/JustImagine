import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

export function hasFfmpeg() {
  return ['ffmpeg', 'ffprobe'].every((command) => spawnSync(command, ['-version'], { stdio: 'ignore', timeout: 2500, windowsHide: true }).status === 0);
}

function run(command, args, { signal, timeout = 15 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(command, args, { signal, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => child.kill(), timeout);
    timer.unref?.();
    child.stderr.on('data', (part) => { stderr = (stderr + part).slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(signal?.aborted ? 'Stopped.' : stderr.trim().split('\n').slice(-2).join(' ') || `${command} exited with ${code}.`));
    });
  });
}

export async function probeMedia(file, signal) {
  const result = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { signal, windowsHide: true });
    const timer = setTimeout(() => child.kill(), 15_000);
    timer.unref?.();
    child.stdout.on('data', (part) => { stdout = (stdout + part).slice(0, 100_000); });
    child.stderr.on('data', (part) => { stderr = (stderr + part).slice(-1000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr || 'Could not read that media file.')); });
  });
  return JSON.parse(result);
}

// The model must never hear the source audio. Keep the original prepared MP4
// locally for the final soundtrack, and remux only its video track for sharing.
export async function silentSceneReference({ source, output, signal }) {
  if (!hasFfmpeg()) throw new Error('FFmpeg is needed to make a silent model reference.');
  const info = await probeMedia(source, signal);
  if (!info.streams?.some((stream) => stream.codec_type === 'video')) throw new Error('The prepared clip has no video track.');
  const temp = `${output}.tmp.mp4`;
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source,
      '-map', '0:v:0', '-c:v', 'copy', '-an', '-movflags', '+faststart', temp], { signal, timeout: 60_000 });
    const silent = await probeMedia(temp, signal);
    if (!silent.streams?.some((stream) => stream.codec_type === 'video') || silent.streams?.some((stream) => stream.codec_type === 'audio')) {
      throw new Error('Could not remove audio from the model reference.');
    }
    fs.renameSync(temp, output);
    return { duration: Number(silent.format?.duration), bytes: fs.statSync(output).size };
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export async function processAppMedia({ app, input, output, values = {}, signal }) {
  if (!hasFfmpeg()) throw new Error('FFmpeg is needed for this app. Install it and restart JustImagine.');
  const info = await probeMedia(input, signal);
  const stream = (type) => info.streams?.find((s) => s.codec_type === type);
  const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  let args;
  if (app === 'video-trim') {
    if (!stream('video')) throw new Error('Choose a video file to trim.');
    const duration = Number(info.format?.duration);
    const start = Number(values.start);
    const end = Number(values.end);
    if (![duration, start, end].every(Number.isFinite) || start < 0 || end <= start || end > duration + 0.1 || end - start < 0.1) {
      throw new Error('Choose a start and end time inside the clip.');
    }
    args = [...common, '-i', input, '-ss', String(start), '-t', String(end - start), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', output];
  } else if (app === 'ugc-audio-fixer') {
    if (!stream('video') || !stream('audio')) throw new Error('Choose a video that has an audio track.');
    const preset = ['speech', 'gentle'].includes(values.preset) ? values.preset : 'speech';
    const filter = preset === 'speech'
      ? 'highpass=f=80,lowpass=f=14000,afftdn=nr=12:nf=-40,loudnorm=I=-16:TP=-1.5:LRA=11'
      : 'highpass=f=45,afftdn=nr=6:nf=-45,loudnorm=I=-16:TP=-1.5:LRA=11';
    args = [...common, '-i', input, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-af', filter, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output];
  } else if (app === 'upscaler') {
    const image = stream('video'); // ffprobe calls still images video streams.
    if (!image?.width || !image?.height) throw new Error('Choose an image to upscale.');
    const factor = Number(values.factor);
    if (![2, 3, 4].includes(factor)) throw new Error('Choose 2×, 3×, or 4×.');
    if (image.width * image.height * factor * factor > 100_000_000) throw new Error('That output would be over 100 megapixels. Choose a smaller factor.');
    const detail = values.detail === 'soft' ? '' : ',unsharp=5:5:0.35:3:3:0.15';
    args = [...common, '-i', input, '-vf', `scale=iw*${factor}:ih*${factor}:flags=lanczos${detail}`, '-frames:v', '1', output];
  } else {
    throw new Error('Unknown local workflow.');
  }
  try {
    await run('ffmpeg', args, { signal });
    if (!fs.statSync(output).size) throw new Error('FFmpeg produced an empty file.');
    return { info };
  } catch (error) {
    fs.rmSync(output, { force: true });
    throw error;
  }
}

// A generated video is picture only for this workflow. Keep the complete audio
// from the locally prepared clip and fail if the model changed the timing too
// much to make a faithful export.
export async function restoreSceneAudio({ generated, source, output, signal }) {
  if (!hasFfmpeg()) throw new Error('FFmpeg is needed to restore the original audio.');
  const [made, original] = await Promise.all([probeMedia(generated, signal), probeMedia(source, signal)]);
  const seconds = Number(original.format?.duration);
  const madeSeconds = Number(made.format?.duration);
  if (!original.streams?.some((stream) => stream.codec_type === 'audio')) throw new Error('The prepared clip has no audio track to restore.');
  if (!made.streams?.some((stream) => stream.codec_type === 'video')) throw new Error('The model did not return a video track.');
  if (!Number.isFinite(seconds) || !Number.isFinite(madeSeconds) || Math.abs(seconds - madeSeconds) > 0.5) {
    throw new Error('The generated clip differs from the prepared clip by more than half a second. Original audio was not cut or stretched.');
  }
  const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  try {
    await run('ffmpeg', [...common, '-i', generated, '-i', source, '-map', '0:v:0', '-map', '1:a:0',
      '-vf', `tpad=stop_mode=clone:stop_duration=0.5,trim=duration=${seconds},setpts=PTS-STARTPTS`,
      '-t', String(seconds), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart', output], { signal });
    if (!fs.statSync(output).size) throw new Error('The export is empty.');
  } catch (error) {
    fs.rmSync(output, { force: true });
    throw error;
  }
}

const color = (value, fallback = '#171717') => /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : fallback;
const escapeXml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(-4096, Math.min(4096, Number(value))) : fallback;

// The text model describes simple shapes as JSON. We serialize only known SVG
// elements and attributes, so an upstream reply never becomes executable markup.
export function vectorJsonToSvg(document) {
  if (!document || !Array.isArray(document.shapes) || !document.shapes.length || document.shapes.length > 160) {
    throw new Error('The vector model did not return a usable drawing. Try a simpler description.');
  }
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="${escapeXml(String(document.title || 'Vector illustration').slice(0, 120))}">`];
  if (document.background) out.push(`<rect width="1024" height="1024" fill="${color(document.background, '#f4f1ea')}"/>`);
  for (const shape of document.shapes) {
    if (!shape || typeof shape !== 'object') continue;
    const fill = color(shape.fill, '#171717');
    const stroke = shape.stroke ? ` stroke="${color(shape.stroke)}" stroke-width="${number(shape.strokeWidth, 2)}" stroke-linecap="round" stroke-linejoin="round"` : '';
    if (shape.type === 'rect') out.push(`<rect x="${number(shape.x)}" y="${number(shape.y)}" width="${Math.max(0, number(shape.width))}" height="${Math.max(0, number(shape.height))}" rx="${Math.max(0, number(shape.radius))}" fill="${fill}"${stroke}/>`);
    if (shape.type === 'circle') out.push(`<circle cx="${number(shape.cx)}" cy="${number(shape.cy)}" r="${Math.max(0, number(shape.r))}" fill="${fill}"${stroke}/>`);
    if (shape.type === 'ellipse') out.push(`<ellipse cx="${number(shape.cx)}" cy="${number(shape.cy)}" rx="${Math.max(0, number(shape.rx))}" ry="${Math.max(0, number(shape.ry))}" fill="${fill}"${stroke}/>`);
    if (shape.type === 'path' && typeof shape.d === 'string' && shape.d.length <= 8000 && /^[\d\s.,+\-eE MmLlHhVvCcSsQqTtAaZz]+$/.test(shape.d)) out.push(`<path d="${escapeXml(shape.d)}" fill="${fill}"${stroke}/>`);
    if (shape.type === 'text' && typeof shape.text === 'string') out.push(`<text x="${number(shape.x)}" y="${number(shape.y)}" fill="${fill}" font-family="Arial, sans-serif" font-size="${Math.max(8, Math.min(180, number(shape.size, 48)))}" font-weight="${shape.bold ? '700' : '400'}">${escapeXml(shape.text.slice(0, 160))}</text>`);
  }
  out.push('</svg>');
  if (out.length < 3) throw new Error('The vector model returned no supported shapes. Try again.');
  return out.join('');
}

export async function generateVector({ apiKey, chatUrl, model, prompt, signal }) {
  const body = { model, temperature: 0.5, response_format: { type: 'json_object' }, messages: [
    { role: 'system', content: 'Draw one clean flat vector illustration as JSON. Output only an object with title, optional background (#RRGGBB), and shapes (at most 80). Canvas is 1024 by 1024. Each shape may be rect {x,y,width,height,radius,fill}, circle {cx,cy,r,fill}, ellipse {cx,cy,rx,ry,fill}, path {d,fill,stroke,strokeWidth}, or text {x,y,text,size,fill,bold}. Colors must be #RRGGBB. Use smooth paths, confident silhouettes, limited colors, and generous spacing. No raster images, URLs, HTML, or SVG strings.' },
    { role: 'user', content: String(prompt).slice(0, 1200) }
  ] };
  const send = (payload) => fetch(chatUrl, { method: 'POST', signal, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  let response = await send(body);
  let raw = await response.json().catch(() => ({}));
  if (!response.ok && [400, 422].includes(response.status) && /response.format|json.object/i.test(raw.error?.message || '')) {
    const { response_format, ...plain } = body;
    response = await send(plain);
    raw = await response.json().catch(() => ({}));
  }
  if (!response.ok) throw new Error(raw.error?.message || `Vector model answered ${response.status}.`);
  const content = raw.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part.text || '').join('') : '';
  const candidate = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let data;
  try { data = JSON.parse(candidate); } catch { throw new Error('The vector model did not return a drawing. Try again.'); }
  return vectorJsonToSvg(data);
}
