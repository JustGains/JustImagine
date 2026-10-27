import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_REFS,
  addCandidate,
  addRef,
  addRefFromDataUrl,
  characterDir,
  characterShots,
  clearCandidates,
  composePrompt,
  createCharacter,
  createVersion,
  deleteCharacter,
  deleteRef,
  deleteVersion,
  exportCast,
  getCharacter,
  getLook,
  importCast,
  idFor,
  keepCandidates,
  listCharacters,
  mergeIntoVersion,
  resolveCandidate,
  resolveCharacters,
  splitKey,
  updateCharacter,
  updateVersion,
  versionShots,
  versionSuggestions
} from './justimagine-characters.js';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-cast-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const img = (seed) => Buffer.from(`fake-png-${seed}`);
const dataUrl = (seed) => 'data:image/png;base64,' + img(seed).toString('base64');

// ---------- ids ----------

test('a character id is a readable slug of its name', () => {
  expect(idFor('Nora')).toBe('nora');
  expect(idFor('The Real Pup!')).toBe('the-real-pup');
  expect(idFor('  Kai  Ito  ')).toBe('kai-ito');
  expect(idFor('***')).toBe('');
});

test('a character id can never address anything outside the library', () => {
  for (const bad of ['..', '../escape', 'a/b', '.hidden', '', '   ']) {
    expect(() => characterDir(root, bad)).toThrow(/Invalid character id/);
  }
  expect(characterDir(root, 'nora')).toBe(path.join(root, 'nora'));
});

// ---------- crud ----------

test('creating a character makes a self-contained folder in the library', () => {
  const c = createCharacter(root, { name: 'Nora', description: 'short dark curly hair, freckles' });
  expect(c).toMatchObject({ id: 'nora', name: 'Nora', description: 'short dark curly hair, freckles', refs: [], cover: '' });
  expect(fs.existsSync(path.join(root, 'nora', 'character.json'))).toBe(true);
  expect(listCharacters(root).map((x) => x.id)).toEqual(['nora']);
  expect(() => createCharacter(root, { name: '***' })).toThrow(/empty/);
});

test('two characters with the same name get distinct ids', () => {
  expect(createCharacter(root, { name: 'Nora' }).id).toBe('nora');
  expect(createCharacter(root, { name: 'Nora' }).id).toBe('nora-2');
  expect(createCharacter(root, { name: 'Nora' }).id).toBe('nora-3');
  expect(listCharacters(root).length).toBe(3);
});

test('the list is sorted by name so the picker is stable', () => {
  for (const n of ['Zed', 'ana', 'Kai']) createCharacter(root, { name: n });
  expect(listCharacters(root).map((c) => c.name)).toEqual(['ana', 'Kai', 'Zed']);
});

test('renaming moves the folder and carries the references with it', () => {
  createCharacter(root, { name: 'Nora' });
  addRefFromDataUrl(root, 'nora', dataUrl(1));

  const renamed = updateCharacter(root, 'nora', { name: 'Nora Vale' });
  expect(renamed.id).toBe('nora-vale');
  expect(renamed.name).toBe('Nora Vale');
  expect(renamed.refs.length).toBe(1);
  expect(fs.existsSync(path.join(root, 'nora'))).toBe(false);
  expect(getCharacter(root, 'nora')).toBe(null);
});

test('editing only the description leaves the id alone', () => {
  createCharacter(root, { name: 'Nora', description: 'old' });
  const c = updateCharacter(root, 'nora', { description: 'new description' });
  expect(c.id).toBe('nora');
  expect(c.description).toBe('new description');
  expect(c.name).toBe('Nora');
  expect(() => updateCharacter(root, 'nobody', { name: 'x' })).toThrow(/No character/);
});

test('deleting a character removes it and its references', () => {
  createCharacter(root, { name: 'Nora' });
  addRefFromDataUrl(root, 'nora', dataUrl(1));
  expect(deleteCharacter(root, 'nora')).toBe(true);
  expect(fs.existsSync(path.join(root, 'nora'))).toBe(false);
  expect(listCharacters(root)).toEqual([]);
  expect(deleteCharacter(root, 'nora')).toBe(false);
});

// ---------- references ----------

test('references dedupe by content and pick the first as the cover', () => {
  createCharacter(root, { name: 'Nora' });
  const first = addRefFromDataUrl(root, 'nora', dataUrl(1));
  expect(first.existed).toBe(false);
  expect(addRefFromDataUrl(root, 'nora', dataUrl(1)).existed).toBe(true);
  addRefFromDataUrl(root, 'nora', dataUrl(2));

  const c = getCharacter(root, 'nora');
  expect(c.refs.length).toBe(2);
  expect(c.cover).toBe(c.refs[0]);
  expect(() => addRefFromDataUrl(root, 'nora', 'not-a-data-url')).toThrow();
  expect(() => addRef(root, 'nobody', img(9))).toThrow(/No character/);
});

test('a character holds at most MAX_REFS references', () => {
  createCharacter(root, { name: 'Nora' });
  for (let i = 0; i < MAX_REFS; i++) addRefFromDataUrl(root, 'nora', dataUrl(i));
  expect(getCharacter(root, 'nora').refs.length).toBe(MAX_REFS);
  expect(() => addRefFromDataUrl(root, 'nora', dataUrl(99))).toThrow(/at most/);
  // re-adding one it already holds is still fine
  expect(addRefFromDataUrl(root, 'nora', dataUrl(0)).existed).toBe(true);
});

test('an explicit cover is kept, and falls back when that reference is deleted', () => {
  createCharacter(root, { name: 'Nora' });
  const a = addRefFromDataUrl(root, 'nora', dataUrl(1)).file;
  const b = addRefFromDataUrl(root, 'nora', dataUrl(2)).file;
  const chosen = getCharacter(root, 'nora').refs.find((f) => f !== getCharacter(root, 'nora').refs[0]);

  expect(updateCharacter(root, 'nora', { cover: chosen }).cover).toBe(chosen);
  expect(deleteRef(root, 'nora', chosen)).toBe(true);
  const after = getCharacter(root, 'nora');
  expect(after.refs.length).toBe(1);
  expect(after.cover).toBe(after.refs[0]); // no longer pointing at a deleted file
  expect([a, b]).toContain(after.cover);
  expect(deleteRef(root, 'nora', 'not-there.png')).toBe(false);
});

// ---------- generated candidates ----------

test('a generated shot lands as a candidate, not a reference', () => {
  createCharacter(root, { name: 'Nora' });
  const file = addCandidate(root, 'nora', img(1));
  const c = getCharacter(root, 'nora');
  expect(c.candidates).toEqual([file]);
  expect(c.refs).toEqual([]);
  expect(c.cover).toBe(''); // a candidate never represents the character
  expect(() => addCandidate(root, 'nobody', img(1))).toThrow(/No character/);
  expect(() => addCandidate(root, 'nora', Buffer.alloc(0))).toThrow(/Empty/);
});

test('keeping promotes the picked shots and leaves the rest as candidates', () => {
  createCharacter(root, { name: 'Nora' });
  const a = addCandidate(root, 'nora', img(1));
  const b = addCandidate(root, 'nora', img(2));
  const c = addCandidate(root, 'nora', img(3));

  const r = keepCandidates(root, 'nora', [a, c]);
  expect(r.kept).toEqual([a, c]);
  expect(r.character.refs.sort()).toEqual([a, c].sort());
  expect(r.character.candidates).toEqual([b]);
  expect(r.character.cover).toBe(r.character.refs[0]); // now it has a face
});

test('keeping ignores names that are not candidates of this character', () => {
  createCharacter(root, { name: 'Nora' });
  const a = addCandidate(root, 'nora', img(1));
  const r = keepCandidates(root, 'nora', [a, 'nope.png', '../escape.png', '']);
  expect(r.kept).toEqual([a]);
  expect(r.character.refs).toEqual([a]);
});

test('keeping a shot the character already holds drops the duplicate', () => {
  createCharacter(root, { name: 'Nora' });
  addRef(root, 'nora', img(1)); // same bytes, so the same content hash
  const dupe = addCandidate(root, 'nora', img(1));
  const r = keepCandidates(root, 'nora', [dupe]);
  expect(r.character.refs.length).toBe(1);
  expect(r.character.candidates).toEqual([]);
});

test('keeping stops at the reference cap instead of silently dropping shots', () => {
  createCharacter(root, { name: 'Nora' });
  for (let i = 0; i < MAX_REFS; i++) addRef(root, 'nora', img('ref' + i));
  const extra = addCandidate(root, 'nora', img('extra'));
  expect(() => keepCandidates(root, 'nora', [extra])).toThrow(/at most/);
  // and the shot is still there to keep after making room
  expect(getCharacter(root, 'nora').candidates).toEqual([extra]);
});

test('discarding clears the named shots, or all of them', () => {
  createCharacter(root, { name: 'Nora' });
  const a = addCandidate(root, 'nora', img(1));
  const b = addCandidate(root, 'nora', img(2));

  expect(clearCandidates(root, 'nora', [a]).candidates).toEqual([b]);
  expect(clearCandidates(root, 'nora').candidates).toEqual([]);
  // clearing an empty set is not an error
  expect(clearCandidates(root, 'nora').candidates).toEqual([]);
});

test('one route resolves a shot whether it is still a candidate or already kept', () => {
  createCharacter(root, { name: 'Nora' });
  const file = addCandidate(root, 'nora', img(1));
  expect(resolveCandidate(root, 'nora', file)).toContain('candidates');
  keepCandidates(root, 'nora', [file]);
  expect(resolveCandidate(root, 'nora', file)).toContain('refs');
  expect(resolveCandidate(root, 'nora', 'missing.png')).toBe(null);
  expect(resolveCandidate(root, 'nora', '')).toBe(null);
});

test('deleting a character takes its unkept shots with it', () => {
  createCharacter(root, { name: 'Nora' });
  addCandidate(root, 'nora', img(1));
  deleteCharacter(root, 'nora');
  expect(fs.existsSync(path.join(root, 'nora'))).toBe(false);
});

// ---------- the shot briefs ----------

test('the set is one seed plus variations that all point back at it', () => {
  const shots = characterShots({ name: 'Nora', description: 'freckles, green jacket' }, 5);
  expect(shots.variations.length).toBe(4); // the seed is the fifth
  expect(shots.seed).toContain('freckles, green jacket');
  expect(shots.seed).toContain('Front-facing');
  for (const v of shots.variations) {
    // this is what stops five generations becoming five different people
    expect(v).toContain('Using the attached reference image');
    expect(v).toContain('identical to the reference');
    expect(v).toContain('Nora');
    // plain backgrounds: these are identity references, not finished pictures
    expect(v).toContain('Plain flat mid-grey studio background');
  }
  // every shot is a different angle or expression
  expect(new Set(shots.variations).size).toBe(4);
});

test('a seeded character can use the whole variation set', () => {
  expect(characterShots({ name: 'Nora' }, 6).variations.length).toBe(5);
  // and it never asks for more shots than there are briefs
  expect(characterShots({ name: 'Nora' }, 99).variations.length).toBe(5);
  expect(characterShots({ name: 'Nora' }, 1).variations.length).toBe(0);
  expect(characterShots({ name: 'Nora' }, 0).variations.length).toBe(4); // 0 falls back to 5
});

test('a character with no description still gets a usable brief from its name', () => {
  const shots = characterShots({ name: 'The Real Pup' }, 5);
  expect(shots.seed).toContain('The Real Pup');
  expect(shots.variations[0]).toContain('The Real Pup');
});

// ---------- resolving for a generation ----------

test('resolving loads the reference bytes and skips ids nobody knows', () => {
  createCharacter(root, { name: 'Nora', description: 'freckles' });
  addRefFromDataUrl(root, 'nora', dataUrl(1));

  const cast = resolveCharacters(root, ['nora', 'nobody', '../escape', '']);
  expect(cast.length).toBe(1);
  expect(cast[0]).toMatchObject({ id: 'nora', name: 'Nora', description: 'freckles' });
  expect(cast[0].resolved.length).toBe(1);
  expect(cast[0].resolved[0].buf.toString()).toBe('fake-png-1');
  expect(cast[0].resolved[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  expect(resolveCharacters(root, undefined)).toEqual([]);
});

test('a character with no references still resolves, just without pictures', () => {
  createCharacter(root, { name: 'Nora', description: 'described only' });
  const [c] = resolveCharacters(root, ['nora']);
  expect(c.resolved).toEqual([]);
  expect(c.description).toBe('described only');
});

// ---------- prompt composition ----------

const nora = { id: 'nora', name: 'Nora', description: 'early 30s, short dark curly hair, green field jacket' };
const kai = { id: 'kai', name: 'Kai', description: '' };

test('a picked character is named in the prompt and described after it', () => {
  const out = composePrompt('at a market stall, dusk', [nora]);
  expect(out).toContain('at a market stall, dusk');
  expect(out).toContain('The reference images are this character');
  expect(out).toContain('- Nora: early 30s, short dark curly hair, green field jacket');
});

test('an @mention is normalised so the sentence still reads naturally', () => {
  expect(composePrompt('@Nora at a market stall', [nora]).split('\n')[0]).toBe('Nora at a market stall');
  // the id spelling works too, and matching is case-insensitive
  expect(composePrompt('@nora and @NORA', [nora]).split('\n')[0]).toBe('Nora and Nora');
  // a bare @ that is not a character is left alone
  expect(composePrompt('email @someone about it', [nora]).split('\n')[0]).toBe('email @someone about it');
});

test('several characters are listed together and the wording agrees', () => {
  const out = composePrompt('@Nora and @Kai share a bench', [nora, kai]);
  expect(out.split('\n')[0]).toBe('Nora and Kai share a bench');
  expect(out).toContain('these characters');
  expect(out).toContain('- Kai'); // no description, so just the name
  expect(out).not.toContain('- Kai —');
});

test('with no characters picked the prompt is passed through untouched', () => {
  expect(composePrompt('a plain landscape', [])).toBe('a plain landscape');
  expect(composePrompt('a plain landscape')).toBe('a plain landscape');
  expect(composePrompt('', [nora])).toContain('- Nora');
});

test('a name with regex characters does not break the mention rewrite', () => {
  const odd = { id: 'c-3po', name: 'C-3PO', description: '' };
  expect(composePrompt('@C-3PO waves', [odd]).split('\n')[0]).toBe('C-3PO waves');
});

test('a cast exports to one file and imports alongside what is there, never over it', () => {
  const png = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, n]);
  const nora = createCharacter(root, { name: 'Nora', description: 'short dark curly hair', voice: { id: 'voice_1', name: 'Warm' } });
  addRef(root, nora.id, png(1), 'image/png');
  const second = addRef(root, nora.id, png(2), 'image/png');
  updateCharacter(root, nora.id, { cover: second.file });
  createCharacter(root, { name: 'Sam' });

  const file = exportCast(root);
  expect(file.format).toBe('justimagine-cast');
  expect(file.characters.map((c) => c.name)).toEqual(['Nora', 'Sam']);
  expect(file.characters[0].refs).toHaveLength(2);
  expect(exportCast(root, [nora.id]).characters).toHaveLength(1);

  const imported = importCast(root, JSON.parse(JSON.stringify(file)));
  expect(imported.map((c) => c.name)).toEqual(['Nora 2', 'Sam 2']);
  expect(imported[0].refs).toEqual(getCharacter(root, nora.id).refs);
  expect(imported[0].cover).toBe(second.file);
  expect(imported[0].voice.id).toBe('voice_1');
  expect(listCharacters(root)).toHaveLength(4);

  // Elsewhere: a fresh library takes the names as they are.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-cast-'));
  try {
    expect(importCast(other, file).map((c) => c.name)).toEqual(['Nora', 'Sam']);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
  expect(() => importCast(root, { characters: [] })).toThrow(/not a JustImagine cast/);
  expect(() => importCast(root, { format: 'justimagine-cast', characters: [{ name: '' }] })).toThrow(/no name/);
});

// ---------- versions ----------

test('a version is another look of the same character, with its own pictures', () => {
  const nora = createCharacter(root, { name: 'Nora', description: 'short dark curly hair', voice: { id: 'voice_1', name: 'Warm' } });
  addRef(root, nora.id, img('main'));
  const { version, character } = createVersion(root, nora.id, { name: 'Spooky', description: 'a pale Halloween ghoul' });
  expect(version).toMatchObject({ id: 'spooky', key: 'nora:spooky', name: 'Spooky', description: 'a pale Halloween ghoul', refs: [] });
  expect(character.versions.map((v) => v.key)).toEqual(['nora:spooky']);
  expect(fs.existsSync(path.join(root, 'nora', 'versions', 'spooky', 'refs'))).toBe(true);

  // References go to the look the key names; the main look is untouched.
  const added = addRef(root, 'nora:spooky', img('ghoul'));
  expect(added.version.refs).toEqual([added.file]);
  expect(added.version.cover).toBe(added.file);
  expect(added.character.refs).toHaveLength(1);
  expect(addRef(root, 'nora:spooky', img('ghoul')).existed).toBe(true);
  expect(splitKey('nora:spooky')).toEqual({ id: 'nora', version: 'spooky' });
  expect(splitKey('nora')).toEqual({ id: 'nora', version: '' });

  // Editing the person keeps their versions; renaming moves them along.
  const renamed = updateCharacter(root, nora.id, { name: 'Nora Vale' });
  expect(renamed.versions.map((v) => v.key)).toEqual(['nora-vale:spooky']);
  expect(renamed.versions[0].refs).toEqual([added.file]);
  expect(renamed.voice.id).toBe('voice_1');
});

test('version names are plain words, unique per character, and never the main look', () => {
  createCharacter(root, { name: 'Nora' });
  createVersion(root, 'nora', { name: 'Spooky' });
  expect(() => createVersion(root, 'nora', { name: 'spooky' })).toThrow(/already has a spooky version/);
  expect(() => createVersion(root, 'nora', { name: 'Reference' })).toThrow(/main look/);
  expect(() => createVersion(root, 'nora', { name: '()' })).toThrow(/Give the version a name/);
  expect(() => createVersion(root, 'ghost', { name: 'Spooky' })).toThrow(/No character/);
  // Brackets would break "@Nora (Pixel art)", so they go.
  expect(createVersion(root, 'nora', { name: 'Pixel (art)' }).version).toMatchObject({ id: 'pixel-art', name: 'Pixel art' });
});

test('renaming a version moves its folder; deleting one removes only it', () => {
  createCharacter(root, { name: 'Nora' });
  addRef(root, 'nora', img('main'));
  createVersion(root, 'nora', { name: 'Spooky' });
  const shot = addRef(root, 'nora:spooky', img('ghoul')).file;
  const { version } = updateVersion(root, 'nora', 'spooky', { name: 'Halloween', description: 'a ghoul' });
  expect(version).toMatchObject({ key: 'nora:halloween', name: 'Halloween', description: 'a ghoul', refs: [shot] });
  expect(fs.existsSync(path.join(root, 'nora', 'versions', 'spooky'))).toBe(false);
  createVersion(root, 'nora', { name: 'Cartoon' });
  expect(() => updateVersion(root, 'nora', 'cartoon', { name: 'Halloween' })).toThrow(/already has/);

  expect(deleteVersion(root, 'nora', 'halloween').removed).toBe(true);
  const after = getCharacter(root, 'nora');
  expect(after.versions.map((v) => v.id)).toEqual(['cartoon']);
  expect(after.refs).toHaveLength(1);
  expect(fs.existsSync(path.join(root, 'nora', 'versions', 'halloween'))).toBe(false);
});

test('a version has its own cover and candidates, kept and served like the main look', () => {
  createCharacter(root, { name: 'Nora' });
  createVersion(root, 'nora', { name: 'Spooky' });
  const a = addRef(root, 'nora:spooky', img('a')).file;
  const b = addRef(root, 'nora:spooky', img('b')).file;
  expect(updateVersion(root, 'nora', 'spooky', { cover: b }).version.cover).toBe(b);
  expect(getCharacter(root, 'nora').cover).toBe('');
  deleteRef(root, 'nora:spooky', b);
  expect(getCharacter(root, 'nora').versions[0].cover).toBe(a);

  const cand = addCandidate(root, 'nora:spooky', img('cand'));
  expect(getCharacter(root, 'nora').candidates).toEqual([]);
  expect(getCharacter(root, 'nora').versions[0].candidates).toEqual([cand]);
  expect(resolveCandidate(root, 'nora:spooky', cand)).toBe(path.join(root, 'nora', 'versions', 'spooky', 'candidates', cand));
  expect(resolveCandidate(root, 'nora', cand)).toBe(null);
  expect(resolveCandidate(root, 'nora:nope', cand)).toBe(null);
  const kept = keepCandidates(root, 'nora:spooky', [cand]);
  expect(kept.kept).toEqual([cand]);
  expect(kept.version.refs).toContain(cand);
  addCandidate(root, 'nora:spooky', img('other'));
  expect(clearCandidates(root, 'nora:spooky').versions[0].candidates).toEqual([]);
});

test('picking a version sends its pictures and description, under the person’s name', () => {
  createCharacter(root, { name: 'Nora', description: 'short dark curly hair' });
  addRef(root, 'nora', img('main'));
  createVersion(root, 'nora', { name: 'Spooky', description: 'a pale Halloween ghoul' });

  // No pictures of its own yet: it borrows the main look's, with its own words.
  let [spooky] = resolveCharacters(root, ['nora:spooky']);
  expect(spooky).toMatchObject({ id: 'nora', key: 'nora:spooky', name: 'Nora', label: 'Nora (Spooky)', versionName: 'Spooky', description: 'a pale Halloween ghoul' });
  expect(spooky.resolved.map((r) => r.buf.toString())).toEqual(['fake-png-main']);

  addRef(root, 'nora:spooky', img('ghoul'));
  [spooky] = resolveCharacters(root, ['nora:spooky', 'nora:spooky', 'nora:missing']);
  expect(spooky.resolved.map((r) => r.buf.toString())).toEqual(['fake-png-ghoul']);
  expect(resolveCharacters(root, ['nora:spooky', 'nora:spooky'])).toHaveLength(1);
  expect(getLook(root, 'nora:missing')).toBe(null);
  expect(getLook(root, 'nora').versionName).toBe('Reference');

  // An empty version description falls back to the person's.
  updateVersion(root, 'nora', 'spooky', { description: '' });
  expect(resolveCharacters(root, ['nora:spooky'])[0].description).toBe('short dark curly hair');
});

test('a version mention reads as the person, and two looks of one person are told apart', () => {
  createCharacter(root, { name: 'Nora', description: 'curly hair' });
  createVersion(root, 'nora', { name: 'Spooky', description: 'a ghoul' });
  const [spooky] = resolveCharacters(root, ['nora:spooky']);
  expect(composePrompt('@Nora (Spooky) in a graveyard', [spooky]).split('\n')[0]).toBe('Nora in a graveyard');
  expect(composePrompt('@nora:spooky in a graveyard', [spooky]).split('\n')[0]).toBe('Nora in a graveyard');
  expect(composePrompt('@Nora in a graveyard', [spooky])).toContain('- Nora: a ghoul');

  const both = resolveCharacters(root, ['nora', 'nora:spooky']);
  const out = composePrompt('@Nora meets @Nora (Spooky)', both);
  expect(out.split('\n')[0]).toBe('Nora meets Nora');
  expect(out).toContain('- Nora: curly hair');
  expect(out).toContain('- Nora (Spooky): a ghoul');
});

test('a new version is first drawn from the main look, in its own description', () => {
  const shots = versionShots({ name: 'Nora', versionName: 'Spooky', description: 'a pale Halloween ghoul' }, 4);
  expect(shots).toHaveLength(4);
  for (const s of shots) {
    expect(s).toContain('attached reference images of Nora');
    expect(s).toContain('a pale Halloween ghoul');
    expect(s).toContain('"Spooky"');
  }
  expect(new Set(shots).size).toBe(4);
  expect(versionShots({ name: 'Nora', versionName: 'Cartoon' }, 9)).toHaveLength(4);
  expect(versionShots({ name: 'Nora', versionName: 'Cartoon' }, 1)[0]).toContain('a cartoon version of themselves');
});

test('characters saved as "Name (Style)" are found and folded into versions', () => {
  const nora = createCharacter(root, { name: 'Nora', description: 'curly hair' });
  addRef(root, nora.id, img('main'));
  const mystery = createCharacter(root, { name: 'Nora (Mystery)', description: 'curly hair, as a 1969 mystery cartoon', voice: { id: 'v2', name: 'Other' } });
  const a = addRef(root, mystery.id, img('m1')).file;
  const b = addRef(root, mystery.id, img('m2')).file;
  updateCharacter(root, mystery.id, { cover: b });
  addCandidate(root, mystery.id, img('m3'));
  createCharacter(root, { name: 'Kai (Robot)' }); // no Kai, so not a look of anyone

  expect(versionSuggestions(listCharacters(root))).toEqual([{ from: 'nora-mystery', into: 'nora', name: 'Mystery' }]);
  const { version, character } = mergeIntoVersion(root, mystery.id, nora.id);
  expect(version).toMatchObject({ key: 'nora:mystery', name: 'Mystery', description: 'curly hair, as a 1969 mystery cartoon', cover: b });
  expect(version.refs.sort()).toEqual([a, b].sort());
  expect(version.candidates).toHaveLength(1);
  expect(character.refs).toHaveLength(1);
  expect(character.voice).toBe(null); // the person's own voice, not the copy's
  expect(getCharacter(root, mystery.id)).toBe(null);
  expect(versionSuggestions(listCharacters(root))).toEqual([]);
  expect(() => mergeIntoVersion(root, nora.id, nora.id)).toThrow(/itself/);
});

test('versions travel with an exported cast', () => {
  createCharacter(root, { name: 'Nora', description: 'curly hair' });
  addRef(root, 'nora', img('main'));
  createVersion(root, 'nora', { name: 'Spooky', description: 'a ghoul' });
  addRef(root, 'nora:spooky', img('g1'));
  const g2 = addRef(root, 'nora:spooky', img('g2')).file;
  updateVersion(root, 'nora', 'spooky', { cover: g2 });

  const file = JSON.parse(JSON.stringify(exportCast(root)));
  expect(file.characters[0].versions).toHaveLength(1);
  const [copy] = importCast(root, file);
  expect(copy.name).toBe('Nora 2');
  expect(copy.versions).toHaveLength(1);
  expect(copy.versions[0]).toMatchObject({ key: 'nora-2:spooky', name: 'Spooky', description: 'a ghoul', cover: g2 });
  expect(copy.versions[0].refs).toHaveLength(2);
});
