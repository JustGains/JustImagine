// A prepared demo is deterministic for a source version and guide settings.
// CacheStorage keeps its large MP4 out of localStorage and survives page reloads.
const CACHE = 'justimagine-scene-remix-guides-v3';
const BASE = '/api/apps/scene-remix/prepared-demo-cache/';
const DESCRIPTION_VERSION = 2;

export function demoGuideKey({ version, start, seconds, mode, aspectRatio, expectedFaces = 1 }) {
  if (!version) return '';
  return `${BASE}${encodeURIComponent(version)}-${encodeURIComponent(start)}-${seconds}-${encodeURIComponent(mode)}-${encodeURIComponent(aspectRatio)}-${expectedFaces}`;
}

export async function loadDemoGuide(key) {
  if (!key || !('caches' in window)) return null;
  try {
    const cache = await caches.open(CACHE);
    const [video, details] = await Promise.all([cache.match(`${key}.mp4`), cache.match(`${key}.json`)]);
    if (!video || !details) return null;
    const meta = await details.json();
    const blob = await video.blob();
    if (!blob.size || !meta?.stats?.frames || !meta?.stats?.seconds) return null;
    return { blob, poster: meta.poster || '', stats: meta.stats, sceneFrames: meta.sceneFrames || [],
      description: meta.descriptionVersion === DESCRIPTION_VERSION ? meta.description || '' : '' };
  } catch { return null; }
}

export async function saveDemoGuide(key, guide) {
  if (!key || !('caches' in window) || !guide?.blob?.size) return;
  try {
    const cache = await caches.open(CACHE);
    const { poster, stats, sceneFrames, description = '' } = guide;
    await Promise.all([
      cache.put(`${key}.mp4`, new Response(guide.blob, { headers: { 'content-type': 'video/mp4' } })),
      cache.put(`${key}.json`, new Response(JSON.stringify({ poster, stats, sceneFrames, description, descriptionVersion: DESCRIPTION_VERSION }), { headers: { 'content-type': 'application/json' } }))
    ]);
  } catch { /* Storage can be disabled or full; preparation still works. */ }
}

export async function saveDemoDescription(key, description) {
  if (!key || !description || !('caches' in window)) return;
  try {
    const cache = await caches.open(CACHE);
    const details = await cache.match(`${key}.json`);
    if (!details) return;
    const meta = await details.json();
    await cache.put(`${key}.json`, new Response(JSON.stringify({ ...meta, description, descriptionVersion: DESCRIPTION_VERSION }), { headers: { 'content-type': 'application/json' } }));
  } catch { /* Cache is optional. */ }
}
