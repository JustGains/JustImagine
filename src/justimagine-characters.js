import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BRO_DIR } from './config.js';
import { EXT_BY_TYPE, IMAGE_TYPES, extOf, safeName } from './justimagine-store.js';

// A repeatable cast. A character is a name, a written description, and a small
// set of reference images — saved once and picked per generation, which is the
// reference-driven half of what Higgsfield calls an avatar. (Its Soul
// Characters are a *trained* identity model; nothing here trains anything, so
// consistency comes from the references and the prompt, and is very good on
// reference-driven models rather than perfect.)
//
// The library is global — one cast, every gallery and the background service —
// and each character owns its reference images rather than pointing into a
// gallery's context folder, so deleting a gallery never guts your cast.
//
//   ~/.bro/justimagine/characters/
//     nora/
//       character.json      { name, description, cover, voice, ts, versions }
//       refs/<sha>.png      the reference images themselves
//       versions/spooky/refs/<sha>.png
//
// A version is another look of the same person (Spooky, Cartoon, Mystery…)
// with its own description and reference images, and the same name and voice.
// A look is addressed by a key: "nora" is the main look (shown as Reference)
// and "nora:spooky" a version, so everything that takes a character id —
// picking, references, drawing a set — takes a version the same way.

export const CHARACTERS_DIR = path.join(BRO_DIR, 'characters');
export const MAX_REFS = 8;
export const MAX_VERSIONS = 12;
// What the main look is called beside its versions.
export const BASE_LOOK = 'Reference';
// Names a version cannot take, because they mean the main look.
const MAIN_NAMES = new Set(['reference', 'base', 'default', 'main', 'original']);
const VERSION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

// "nora:spooky" → { id: "nora", version: "spooky" }; "nora" → the main look.
export function splitKey(key) {
  const s = String(key ?? '').trim();
  const at = s.indexOf(':');
  return at < 0 ? { id: s, version: '' } : { id: s.slice(0, at), version: s.slice(at + 1) };
}
export const lookKey = (id, version) => (version ? `${id}:${version}` : String(id ?? ''));

// The voice a character speaks with. It lives in ElevenLabs — the id is all
// that is needed to speak — and the rest is what the cast list shows without
// asking ElevenLabs again. Delivery settings travel with it, so a character
// who whispers keeps whispering in every line they are given.
export function cleanVoice(voice) {
  if (voice == null || voice === '') return null;
  if (typeof voice !== 'object' || Array.isArray(voice)) throw new Error('A voice is { id, name }.');
  const id = String(voice.id ?? '').trim();
  if (!id || id.length > 100 || !/^[\w-]+$/.test(id)) throw new Error('That is not an ElevenLabs voice id.');
  const out = { id, name: String(voice.name ?? '').trim().slice(0, 100) || id };
  if (['library', 'designed', 'cloned'].includes(voice.source)) out.source = voice.source;
  if (typeof voice.previewUrl === 'string' && /^https:\/\//.test(voice.previewUrl) && voice.previewUrl.length < 1000) out.previewUrl = voice.previewUrl;
  if (typeof voice.description === 'string' && voice.description.trim()) out.description = voice.description.trim().slice(0, 1000);
  const settings = {};
  for (const k of ['stability', 'similarity', 'style', 'speed']) {
    const n = Number(voice.settings?.[k]);
    if (voice.settings?.[k] !== '' && voice.settings?.[k] != null && Number.isFinite(n)) settings[k] = n;
  }
  if (Object.keys(settings).length) out.settings = settings;
  return out;
}

const metaPath = (dir) => path.join(dir, 'character.json');
const refsDir = (dir) => path.join(dir, 'refs');
// Generated shots waiting to be kept or thrown away. They live on disk rather
// than in memory so closing the editor — or reloading the page — does not lose
// a set you just paid to generate.
const candidatesDir = (dir) => path.join(dir, 'candidates');
const versionDir = (dir, version) => path.join(dir, 'versions', version);

// Character ids double as their directory name, so the library stays legible
// when you open it in a file manager.
export function characterDir(root, id) {
  const clean = String(id ?? '').trim();
  if (!clean || clean !== path.basename(clean) || clean.startsWith('.') || clean.includes('..') || clean.includes(':')) {
    throw new Error(`Invalid character id: ${id}`);
  }
  return path.join(root, clean);
}

export const idFor = (name) =>
  safeName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export function ensureLibrary(root = CHARACTERS_DIR) {
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

const versionsIn = (meta) => (Array.isArray(meta?.versions) ? meta.versions : []).filter((v) => v && VERSION_ID.test(String(v.id)));

function readCharacter(root, id) {
  const dir = characterDir(root, id);
  const meta = readMeta(dir);
  if (!meta) return null;
  const refs = imagesIn(refsDir(dir));
  return {
    id,
    name: meta.name || id,
    description: meta.description || '',
    // The cover is whichever reference represents the character in the picker;
    // it falls back to the first so the list is never blank.
    cover: refs.includes(meta.cover) ? meta.cover : refs[0] || '',
    voice: meta.voice && meta.voice.id ? meta.voice : null,
    refs,
    candidates: imagesIn(candidatesDir(dir)),
    versions: versionsIn(meta).map((v) => {
      const home = versionDir(dir, v.id);
      const vrefs = imagesIn(refsDir(home));
      return {
        id: v.id,
        key: lookKey(id, v.id),
        name: v.name || v.id,
        description: v.description || '',
        cover: vrefs.includes(v.cover) ? v.cover : vrefs[0] || '',
        refs: vrefs,
        candidates: imagesIn(candidatesDir(home)),
        ts: v.ts || 0
      };
    }),
    ts: meta.ts || 0
  };
}

// One look of a character and the folder its pictures live in.
function lookOf(root, key) {
  const { id, version } = splitKey(key);
  const character = readCharacter(root, id);
  if (!character) throw new Error(`No character "${id}"`);
  const dir = characterDir(root, id);
  if (!version) return { character, version: null, home: dir, refs: character.refs, candidates: character.candidates, cover: character.cover };
  const v = character.versions.find((x) => x.id === version);
  if (!v) throw new Error(`${character.name} has no "${version}" version.`);
  return { character, version: v, home: versionDir(dir, v.id), refs: v.refs, candidates: v.candidates, cover: v.cover };
}

// A look as the generators want it: who it is, what it looks like in words
// (a version without its own description borrows the main one) and its pictures.
export function getLook(root, key) {
  let look;
  try {
    look = lookOf(root, key);
  } catch {
    return null;
  }
  const { character: c, version: v } = look;
  return {
    key: v ? v.key : c.id,
    id: c.id,
    version: v ? v.id : '',
    name: c.name,
    versionName: v ? v.name : BASE_LOOK,
    label: v ? `${c.name} (${v.name})` : c.name,
    description: (v && v.description) || c.description,
    refs: look.refs,
    candidates: look.candidates,
    cover: look.cover,
    baseRefs: c.refs,
    baseCover: c.cover
  };
}

function imagesIn(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && IMAGE_TYPES[extOf(e.name)])
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // a character with nothing here yet is still a character
  }
}

export function listCharacters(root = CHARACTERS_DIR) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => readCharacter(root, e.name))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export const getCharacter = (root, id) => readCharacter(root, id);

function writeMeta(dir, meta) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2));
}

export function createCharacter(root, { name, description = '', voice = null } = {}) {
  ensureLibrary(root);
  const base = idFor(name);
  if (!base) throw new Error('Character name is empty');
  const cleanedVoice = cleanVoice(voice);
  let id = base;
  for (let i = 2; fs.existsSync(path.join(root, id)); i++) id = `${base}-${i}`;
  const dir = characterDir(root, id);
  fs.mkdirSync(refsDir(dir), { recursive: true });
  writeMeta(dir, { name: safeName(name), description: String(description || '').slice(0, 2000), cover: '', voice: cleanedVoice, ts: Date.now() });
  return readCharacter(root, id);
}

// Renaming moves the directory so the library keeps matching what you see in
// the UI; the id follows the name, and callers re-point their selection.
export function updateCharacter(root, id, { name, description, cover, voice } = {}) {
  const current = readCharacter(root, id);
  if (!current) throw new Error(`No character "${id}"`);
  // Checked before anything moves, so a bad voice never half-applies a rename.
  const nextVoice = voice !== undefined ? cleanVoice(voice) : current.voice;
  let nextId = id;
  if (name != null && safeName(name) && safeName(name) !== current.name) {
    const base = idFor(name);
    if (!base) throw new Error('Character name is empty');
    if (base !== id) {
      let candidate = base;
      for (let i = 2; fs.existsSync(path.join(root, candidate)); i++) candidate = `${base}-${i}`;
      fs.renameSync(characterDir(root, id), characterDir(root, candidate));
      nextId = candidate;
    }
  }
  const dir = characterDir(root, nextId);
  writeMeta(dir, {
    // Whatever else the file holds (its versions) stays as it was.
    ...readMeta(dir),
    name: name != null && safeName(name) ? safeName(name) : current.name,
    description: description != null ? String(description).slice(0, 2000) : current.description,
    cover: cover != null ? path.basename(String(cover)) : current.cover,
    voice: nextVoice,
    ts: Date.now()
  });
  return readCharacter(root, nextId);
}

export function deleteCharacter(root, id) {
  const dir = characterDir(root, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// References are stored under the hash of their bytes, so adding the same
// picture twice is a no-op and a character never accumulates duplicates.
// `key` is a character id, or "id:version" for one of its versions.
export function addRef(root, key, buf, type = 'image/png') {
  const look = lookOf(root, key);
  if (!buf?.length) throw new Error('Empty image.');
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const file = `${hash}.${EXT_BY_TYPE[type.toLowerCase()] || 'png'}`;
  const full = path.join(refsDir(look.home), file);
  const existed = fs.existsSync(full);
  if (!existed) {
    if (look.refs.length >= MAX_REFS) throw new Error(`${look.version ? 'A version' : 'A character'} holds at most ${MAX_REFS} reference images.`);
    fs.mkdirSync(refsDir(look.home), { recursive: true });
    fs.writeFileSync(full, buf);
  }
  return { file, existed, ...afterChange(root, key) };
}

// The character after a change, and the version it was made to (if any).
function afterChange(root, key) {
  const { id, version } = splitKey(key);
  const character = readCharacter(root, id);
  return version ? { character, version: character?.versions.find((v) => v.id === version) } : { character };
}

export function addRefFromDataUrl(root, key, dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/is);
  if (!m) throw new Error('Expected a base64 image data URL.');
  return addRef(root, key, Buffer.from(m[2], 'base64'), m[1].toLowerCase());
}

export function deleteRef(root, key, file) {
  const name = path.basename(String(file ?? ''));
  if (!name) return false;
  let look;
  try {
    look = lookOf(root, key);
    fs.unlinkSync(path.join(refsDir(look.home), name));
  } catch {
    return false;
  }
  // The cover pointed at a file that no longer exists; readCharacter falls back
  // on its own, but persist it so the metadata does not stay stale.
  const after = lookOf(root, key);
  const dir = characterDir(root, look.character.id);
  const meta = readMeta(dir) || {};
  if (look.version) writeMeta(dir, { ...meta, versions: versionsIn(meta).map((v) => (v.id === look.version.id ? { ...v, cover: after.cover } : v)) });
  else writeMeta(dir, { ...meta, cover: after.cover, ts: Date.now() });
  return true;
}

// ---------- versions ----------

// A version's name reads inside a mention ("@Nora (Spooky)"), so it keeps to
// plain words: no brackets, and never one of the main look's own names.
function versionName(name, owner) {
  const label = safeName(String(name ?? '').replace(/[()[\]{}@#]/g, ' ')).slice(0, 40).trim();
  const id = idFor(label);
  if (!id) throw new Error('Give the version a name, like Spooky or Cartoon.');
  if (MAIN_NAMES.has(id)) throw new Error(`"${label}" is what ${owner}'s main look is called. Pick another name for the version.`);
  return { label, id };
}

export function createVersion(root, id, { name, description = '' } = {}) {
  const dir = characterDir(root, id);
  const meta = readMeta(dir);
  if (!meta) throw new Error(`No character "${id}"`);
  const owner = meta.name || id;
  const { label, id: vid } = versionName(name, owner);
  const versions = versionsIn(meta);
  if (versions.some((v) => v.id === vid)) throw new Error(`${owner} already has a ${label} version.`);
  if (versions.length >= MAX_VERSIONS) throw new Error(`A character holds at most ${MAX_VERSIONS} versions.`);
  fs.mkdirSync(refsDir(versionDir(dir, vid)), { recursive: true });
  const now = Date.now();
  writeMeta(dir, { ...meta, versions: [...versions, { id: vid, name: label, description: String(description || '').trim().slice(0, 2000), cover: '', ts: now }], ts: now });
  return afterChange(root, lookKey(id, vid));
}

// Renaming moves the version's folder, like renaming a character does; the
// key follows the name.
export function updateVersion(root, id, version, { name, description, cover } = {}) {
  const dir = characterDir(root, id);
  const meta = readMeta(dir);
  if (!meta) throw new Error(`No character "${id}"`);
  const versions = versionsIn(meta);
  const at = versions.findIndex((v) => v.id === version);
  if (at < 0) throw new Error(`${meta.name || id} has no "${version}" version.`);
  const next = { ...versions[at] };
  if (name != null && String(name).trim()) {
    const { label, id: vid } = versionName(name, meta.name || id);
    if (vid !== next.id) {
      if (versions.some((v) => v.id === vid)) throw new Error(`${meta.name || id} already has a ${label} version.`);
      const from = versionDir(dir, next.id);
      if (fs.existsSync(from)) fs.renameSync(from, versionDir(dir, vid));
      next.id = vid;
    }
    next.name = label;
  }
  if (description != null) next.description = String(description).trim().slice(0, 2000);
  if (cover != null) next.cover = path.basename(String(cover));
  next.ts = Date.now();
  versions[at] = next;
  writeMeta(dir, { ...meta, versions, ts: Date.now() });
  return afterChange(root, lookKey(id, next.id));
}

export function deleteVersion(root, id, version) {
  const dir = characterDir(root, id);
  const meta = readMeta(dir);
  if (!meta) throw new Error(`No character "${id}"`);
  const versions = versionsIn(meta);
  if (!versions.some((v) => v.id === version)) return { removed: false, character: readCharacter(root, id) };
  fs.rmSync(versionDir(dir, version), { recursive: true, force: true });
  writeMeta(dir, { ...meta, versions: versions.filter((v) => v.id !== version), ts: Date.now() });
  return { removed: true, character: readCharacter(root, id) };
}

// "Nora (Spooky)" is how another look of Nora was saved before versions: as a
// character of its own. Given the cast, which of them are looks of someone else.
export function versionSuggestions(characters = []) {
  const byName = new Map(characters.map((c) => [String(c.name).toLowerCase(), c]));
  const out = [];
  for (const c of characters) {
    const m = String(c.name).match(/^(.*\S)\s*\(([^()]+)\)\s*$/);
    const into = m && byName.get(m[1].toLowerCase());
    if (!into || into.id === c.id || (c.versions || []).length) continue;
    out.push({ from: c.id, into: into.id, name: m[2].trim() });
  }
  return out;
}

// Turn such a character into a version of the person it is a look of: its
// description and pictures move across, and the separate character goes. Its
// voice stays with the person, whose voice every version shares.
export function mergeIntoVersion(root, fromId, intoId, name) {
  if (String(fromId) === String(intoId)) throw new Error('A character cannot become a version of itself.');
  const from = readCharacter(root, fromId);
  if (!from) throw new Error(`No character "${fromId}"`);
  const into = readCharacter(root, intoId);
  if (!into) throw new Error(`No character "${intoId}"`);
  if (from.versions.length) throw new Error(`${from.name} has versions of its own, so it cannot become one.`);
  const suggested = versionSuggestions([from, into]).find((s) => s.from === from.id)?.name;
  const { version } = createVersion(root, into.id, { name: name || suggested || from.name, description: from.description });
  const fromDir = characterDir(root, from.id);
  const home = versionDir(characterDir(root, into.id), version.id);
  for (const sub of ['refs', 'candidates']) {
    const files = imagesIn(path.join(fromDir, sub));
    if (files.length) fs.mkdirSync(path.join(home, sub), { recursive: true });
    for (const file of files) fs.renameSync(path.join(fromDir, sub, file), path.join(home, sub, file));
  }
  if (from.cover) updateVersion(root, into.id, version.id, { cover: from.cover });
  deleteCharacter(root, from.id);
  return afterChange(root, lookKey(into.id, version.id));
}

// ---------- generated candidates ----------

// Where a generated shot goes to be looked at before it counts. Same content
// hashing as references, so keeping one is a rename rather than a rewrite.
export function addCandidate(root, key, buf, type = 'image/png') {
  const look = lookOf(root, key);
  if (!buf?.length) throw new Error('Empty image.');
  const dir = candidatesDir(look.home);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const file = `${hash}.${EXT_BY_TYPE[type.toLowerCase()] || 'png'}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buf);
  return file;
}

// Promote chosen shots into the real references, stopping at the cap rather
// than silently dropping the overflow.
export function keepCandidates(root, key, files) {
  const look = lookOf(root, key);
  const dir = look.home;
  let room = MAX_REFS - look.refs.length;
  const kept = [];
  for (const raw of Array.isArray(files) ? files : []) {
    const name = path.basename(String(raw ?? ''));
    if (!name || !look.candidates.includes(name)) continue;
    if (room <= 0) throw new Error(`${look.version ? 'A version' : 'A character'} holds at most ${MAX_REFS} reference images. Kept ${kept.length}.`);
    fs.mkdirSync(refsDir(dir), { recursive: true });
    const target = path.join(refsDir(dir), name);
    // Already a reference: the shot is a duplicate, so just drop the candidate.
    if (fs.existsSync(target)) fs.rmSync(path.join(candidatesDir(dir), name), { force: true });
    else {
      fs.renameSync(path.join(candidatesDir(dir), name), target);
      room--;
    }
    kept.push(name);
  }
  return { kept, ...afterChange(root, key) };
}

// Throw away the ones that were not kept — all of them when no list is given.
export function clearCandidates(root, key, files) {
  const look = lookOf(root, key);
  const dir = candidatesDir(look.home);
  if (!Array.isArray(files)) fs.rmSync(dir, { recursive: true, force: true });
  else {
    for (const raw of files) {
      const name = path.basename(String(raw ?? ''));
      if (name) fs.rmSync(path.join(dir, name), { force: true });
    }
  }
  return readCharacter(root, look.character.id);
}

export function resolveCandidate(root, key, file) {
  const name = path.basename(String(file ?? ''));
  if (!name) return null;
  let look;
  try {
    look = lookOf(root, key);
  } catch {
    return null;
  }
  // One name, two possible homes — a kept shot keeps its filename.
  for (const full of [path.join(refsDir(look.home), name), path.join(candidatesDir(look.home), name)]) {
    if (fs.existsSync(full)) return full;
  }
  return null;
}

// ---------- generating a reference set ----------

// Five independent generations from one description produce five different
// people, which is useless as an identity reference. So the first shot is the
// seed and every other shot is conditioned on it — that is what makes the set
// one character seen from several angles rather than a casting call.
//
// Backgrounds are deliberately plain: these are identity references, not
// finished pictures, and scenery only gives the model something to copy later.
const VARIATION_SHOTS = [
  'a three-quarter view head-and-shoulders portrait, neutral expression',
  'a full-length standing shot, arms relaxed at their sides, facing the camera',
  'a side profile head-and-shoulders portrait, neutral expression',
  'a head-and-shoulders portrait with a warm natural smile, head turned slightly',
  'a head-and-shoulders portrait looking slightly up and away from the camera'
];

const PLAIN = 'Plain flat mid-grey studio background, soft even lighting, no props, no text, sharp focus.';

export function characterShots({ name, description } = {}, count = 5) {
  const n = Math.min(Math.max(Number(count) || 5, 1), VARIATION_SHOTS.length + 1);
  const who = [description, name ? `The character is called ${name}.` : ''].filter(Boolean).join(' ');
  return {
    // Generated only when the character has no reference to seed from.
    seed: `A reference sheet portrait of a single character: ${description || name}. Front-facing head-and-shoulders, neutral expression, looking straight at the camera. ${PLAIN}`,
    variations: VARIATION_SHOTS.slice(0, n - 1).map(
      (shot) =>
        `Using the attached reference image, draw the exact same character again as ${shot}. ` +
        `Keep their face, hair, build, colouring and clothing identical to the reference. Only the angle and expression change. ` +
        `${who ? who + ' ' : ''}${PLAIN}`
    )
  };
}

// The first pictures of a new version. Each take redraws the main look's
// references in the version's description, so it is still recognisably them;
// they differ in framing so the takes are worth choosing between. Whichever
// you keep becomes the version's seed, and "draw more angles" builds on that.
const TAKE_FRAMING = [
  'Front-facing head-and-shoulders, neutral expression, looking straight at the camera.',
  'A three-quarter view head-and-shoulders portrait, a slight smile.',
  'A waist-up portrait, relaxed pose, facing the camera.',
  'Front-facing head-and-shoulders, a confident expression.'
];

export function versionShots({ name, versionName, description } = {}, count = 4) {
  const n = Math.min(Math.max(Number(count) || 4, 1), TAKE_FRAMING.length);
  const look = String(description || '').trim() || `a ${String(versionName || 'new').toLowerCase()} version of themselves`;
  const who = name || 'this character';
  return TAKE_FRAMING.slice(0, n).map(
    (framing) =>
      `Using the attached reference images of ${who}, draw the same character again in a new look${versionName ? ` called "${versionName}"` : ''}: ${look}. ` +
      `Keep them recognisably the same person: the same face, features, build and proportions. Where the new look asks for a different art style, outfit or colouring, follow the new look instead of the references. ` +
      `${framing} ${PLAIN}`
  );
}

// Read the looks' references into the shape the upstream calls want. Each
// entry is a character id or "id:version"; the result is the character with
// that look's description and pictures, and its `label` ("Nora (Spooky)").
export function resolveCharacters(root, ids) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const look = getLook(root, raw); // unknown ids and versions are simply skipped
    if (!look || seen.has(look.key)) continue;
    seen.add(look.key);
    const character = readCharacter(root, look.id);
    // A version with no pictures of its own yet borrows the main look's, so
    // the person is still recognisable while the description sets the look.
    const own = look.refs.length > 0 || !look.version;
    const home = own && look.version ? versionDir(characterDir(root, look.id), look.version) : characterDir(root, look.id);
    const dir = refsDir(home);
    const refs = [];
    for (const file of own ? look.refs : look.baseRefs) {
      let buf;
      try {
        buf = fs.readFileSync(path.join(dir, file));
      } catch {
        continue;
      }
      const type = IMAGE_TYPES[extOf(file)] || 'image/png';
      refs.push({ file, buf, type, ext: EXT_BY_TYPE[type] || 'png', dataUrl: `data:${type};base64,${buf.toString('base64')}` });
    }
    out.push({
      ...character,
      key: look.key,
      version: look.version,
      versionName: look.versionName,
      label: look.label,
      description: look.description,
      cover: look.cover,
      refs: look.refs,
      candidates: look.candidates,
      resolved: refs
    });
  }
  return out;
}

// ---------- export / import ----------

// The whole cast as one portable file: every character's name, description,
// voice and reference images (base64). Importing adds characters — it never
// overwrites one — so a second "Nora" arrives as "Nora 2". A voice id only
// speaks on the ElevenLabs account that owns it (or anywhere, for the premade
// library voices); it travels as-is.
export const CAST_FORMAT = 'justimagine-cast';
export const CAST_MAX = 200;

export function exportCast(root, ids = []) {
  const wanted = ids.length ? new Set(ids) : null;
  const characters = [];
  const read = (dir, files) => {
    const refs = [];
    for (const file of files) {
      try {
        refs.push({ file, type: IMAGE_TYPES[extOf(file)] || 'image/png', data: fs.readFileSync(path.join(dir, file)).toString('base64') });
      } catch {
        /* removed while exporting */
      }
    }
    return refs;
  };
  for (const c of listCharacters(root)) {
    if (wanted && !wanted.has(c.id)) continue;
    const dir = characterDir(root, c.id);
    const versions = c.versions.map((v) => ({ name: v.name, description: v.description, cover: v.cover, refs: read(refsDir(versionDir(dir, v.id)), v.refs) }));
    characters.push({ name: c.name, description: c.description, voice: c.voice, cover: c.cover, refs: read(refsDir(dir), c.refs), ...(versions.length ? { versions } : {}) });
  }
  return { format: CAST_FORMAT, version: 1, exportedAt: new Date().toISOString(), characters };
}

// Reference images from an export, added to one look; returns the file the
// export's cover became.
function importRefs(root, key, refs, cover) {
  let kept = '';
  for (const ref of (Array.isArray(refs) ? refs : []).slice(0, MAX_REFS)) {
    const type = String(ref?.type || '').toLowerCase();
    if (typeof ref?.data !== 'string' || !IMAGE_TYPES[EXT_BY_TYPE[type]]) continue;
    const added = addRef(root, key, Buffer.from(ref.data, 'base64'), type);
    if (ref.file === cover) kept = added.file;
  }
  return kept;
}

export function importCast(root, cast) {
  if (cast?.format !== CAST_FORMAT || !Array.isArray(cast.characters)) throw new Error('That file is not a JustImagine cast export.');
  if (cast.characters.length > CAST_MAX) throw new Error(`A cast file holds at most ${CAST_MAX} characters.`);
  const names = new Set(listCharacters(root).map((c) => c.name.toLowerCase()));
  const imported = [];
  cast.characters.forEach((entry, i) => {
    const base = safeName(entry?.name);
    if (!base) throw new Error(`characters[${i}] has no name.`);
    let name = base;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    names.add(name.toLowerCase());
    let voice = null;
    try {
      voice = cleanVoice(entry.voice);
    } catch {
      voice = null; // an unreadable voice is dropped, not the character
    }
    const character = createCharacter(root, { name, description: entry.description, voice });
    const cover = importRefs(root, character.id, entry.refs, entry.cover);
    if (cover) updateCharacter(root, character.id, { cover });
    for (const v of (Array.isArray(entry.versions) ? entry.versions : []).slice(0, MAX_VERSIONS)) {
      let version;
      try {
        ({ version } = createVersion(root, character.id, { name: v?.name, description: v?.description }));
      } catch {
        continue; // a nameless or repeated version is dropped, not the character
      }
      const vcover = importRefs(root, version.key, v.refs, v.cover);
      if (vcover) updateVersion(root, character.id, version.id, { cover: vcover });
    }
    imported.push(getCharacter(root, character.id));
  });
  return imported;
}

// ---------- prompt composition ----------

// The picked characters are named in the prompt and described after it, so the
// model is told both who is in the shot and that the attached references are
// them. `@Nora` typed in the prompt is normalised to plain `Nora`, which lets
// the mention read naturally in the sentence the user actually wrote, and so
// is a version's `@Nora (Spooky)`: the description below carries the look.
export function composePrompt(prompt, characters = []) {
  let text = String(prompt || '');
  // Versions first, or "@Nora (Spooky)" would lose only its "@Nora".
  for (const c of characters) {
    if (!c?.name || !c.version) continue;
    if (c.versionName) text = text.replace(new RegExp(`@${escapeRe(c.name)} \\(${escapeRe(c.versionName)}\\)`, 'gi'), c.name);
    if (c.id) text = text.replace(new RegExp(`@${escapeRe(c.id)}:${escapeRe(c.version)}\\b`, 'gi'), c.name);
  }
  for (const c of characters) {
    if (!c?.name) continue;
    text = text.replace(new RegExp(`@${escapeRe(c.name)}\\b`, 'gi'), c.name);
    if (c.id) text = text.replace(new RegExp(`@${escapeRe(c.id)}\\b`, 'gi'), c.name);
  }
  const named = characters.filter((c) => c?.name);
  if (!named.length) return text;

  // Two looks of one person in a shot are told apart by their version.
  const twice = (c) => c.id && named.filter((x) => x.id === c.id).length > 1;
  const lines = named.map((c) => `- ${twice(c) ? c.label || c.name : c.name}${c.description ? `: ${c.description}` : ''}`);
  const who = named.length === 1 ? 'this character' : 'these characters';
  return [
    text,
    '',
    `The reference images are ${who}. Keep their face, hair, build and clothing consistent with the references:`,
    ...lines
  ].join('\n');
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
