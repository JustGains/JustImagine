import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const localClip = path.resolve(here, '..', '.artifacts', 'remix-tests', 'hotel-lobby-50s-58s.mp4');
const videoUrl = 'https://www.youtube.com/watch?v=x9yop0nYR9g';
const downloads = new Map();

const cacheDir = (root) => path.join(root, '.scene-remix-demo');
const cachedClip = (root) => path.join(cacheDir(root), 'hotel-lobby-50s-58s.mp4');
const validClip = (file) => { try { return fs.statSync(file).size > 100_000; } catch { return false; } };

export function demoClipPath(root) {
  if (validClip(localClip)) return localClip;
  const cached = cachedClip(root);
  return validClip(cached) ? cached : null;
}

export function demoClipVersion(file) {
  const stat = fs.statSync(file);
  return `${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}`;
}

function command(name, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(name, args, { windowsHide: true });
    let detail = '';
    const append = (chunk) => { detail = (detail + String(chunk)).slice(-4000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`${name} could not start: ${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${name} failed${detail ? `: ${detail.trim()}` : ` (exit ${code})`}`));
    });
  });
}

export function ensureDemoClip(root) {
  const existing = demoClipPath(root);
  if (existing) return Promise.resolve(existing);
  return downloadDemoClip(root);
}

export function downloadDemoClip(root) {
  const target = cachedClip(root);
  if (validClip(target)) return Promise.resolve(target);
  if (!downloads.has(target)) downloads.set(target, (async () => {
    const dir = cacheDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const sourcePattern = path.join(dir, 'source.%(ext)s');
    await command('yt-dlp', ['--no-playlist', '-f', 'bv*[height<=720]+ba/b[height<=720]', '--merge-output-format', 'mp4', '-o', sourcePattern, videoUrl], 180_000);
    const source = fs.readdirSync(dir).map((name) => path.join(dir, name)).find((file) => /^source\.(?:mp4|mkv|webm)$/.test(path.basename(file)));
    if (!source) throw new Error('The demo video downloaded, but no video file was found.');
    const temp = path.join(dir, 'hotel-lobby-50s-58s.tmp.mp4');
    await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '00:00:50', '-i', source, '-t', '8', '-vf', 'scale=960:-2,fps=24', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', temp], 180_000);
    if (!validClip(temp)) throw new Error('The demo clip was empty after trimming.');
    fs.renameSync(temp, target);
    fs.unlinkSync(source);
    return target;
  })().finally(() => downloads.delete(target)));
  return downloads.get(target);
}
