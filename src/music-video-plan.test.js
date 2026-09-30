import { expect, test } from 'bun:test';
import {
  parseTimedLyrics, spreadLines, planShots, clipFor, audioWindow, isLipSyncModel, storyboardRequest,
  parseStoryboard, fallbackStoryboard, keyframePrompt, motionPrompt, estimateCost
} from './music-video-plan.js';

const SEEDANCE = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const ANTHEM = '[4.0:8.0] Headbands on, we are rolling in\n[8.0:12.0] Soft on the outside, strong within\n[12.0:16.0] JUST GAINS, JUST GAINS\n[16.0:20.0] MARSHMALLOW CREW\n[20.0:24.0] JUST GAINS, JUST GAINS\n[24.0:28.0] MARSHMALLOW CREW';

test('reads Lyria timings, LRC and plain lyrics', () => {
  const lyria = parseTimedLyrics(ANTHEM);
  expect(lyria.timed).toBe(true);
  expect(lyria.lines).toHaveLength(6);
  expect(lyria.lines[0]).toEqual({ start: 4, end: 8, text: 'Headbands on, we are rolling in' });

  const lrc = parseTimedLyrics('[00:05.00] First line\n[00:09.50][01:10.00] Chorus line\n[Chorus]\n[00:14.00] Last line');
  expect(lrc.timed).toBe(true);
  expect(lrc.lines.map((l) => [l.start, l.text])).toEqual([[5, 'First line'], [9.5, 'Chorus line'], [14, 'Last line'], [70, 'Chorus line']]);
  expect(lrc.lines[0].end).toBe(9.5);
  expect(lrc.lines[3].end).toBe(74); // the last line lasts a few seconds, not forever

  const plain = parseTimedLyrics('[Verse 1]\nWe light the night\n(ooh)\nWe own the dawn\n');
  expect(plain).toEqual({ timed: false, lines: [{ start: null, end: null, text: 'We light the night' }, { start: null, end: null, text: 'We own the dawn' }] });
  const spread = spreadLines(plain.lines, 100);
  expect(spread[0].start).toBe(6);
  expect(spread[1].end).toBe(96);
});

test('cuts a song into shots at line starts that fit the clip lengths', () => {
  const { lines } = parseTimedLyrics(ANTHEM);
  const shots = planShots({ duration: 30.8, lines, durations: SEEDANCE, pace: 6 });
  // The shots cover the song exactly, end to end, with no gaps.
  expect(shots[0].start).toBe(0);
  expect(shots.at(-1).end).toBe(30.8);
  for (let i = 1; i < shots.length; i++) expect(shots[i].start).toBe(shots[i - 1].end);
  for (const s of shots) {
    expect(s.clip).toBeGreaterThanOrEqual(s.end - s.start - 1e-9);
    expect(SEEDANCE).toContain(s.clip);
  }
  // Every cut lands where a line starts or the song ends.
  const starts = new Set([0, ...lines.map((l) => l.start), 30.8]);
  for (const s of shots) expect(starts.has(s.start)).toBe(true);
  // Lines go with the shots they are sung in; the intro has none.
  expect(shots.flatMap((s) => s.lines)).toHaveLength(6);
  expect(shots.filter((s) => s.vocal).length).toBeGreaterThanOrEqual(3);
  // Nothing much is paid for beyond the song.
  const paid = shots.reduce((n, s) => n + s.clip, 0);
  expect(paid - 30.8).toBeLessThan(2.5);
});

test('long lines, long gaps and models with few clip lengths still plan', () => {
  const lines = [{ start: 2, end: 22, text: 'one very long held note' }, { start: 40, end: 44, text: 'after the solo' }];
  const shots = planShots({ duration: 60, lines, durations: [5, 10], pace: 6 });
  expect(shots[0].start).toBe(0);
  expect(shots.at(-1).end).toBe(60);
  for (const s of shots) expect([5, 10]).toContain(s.clip);
  for (const s of shots) expect(s.end - s.start).toBeLessThanOrEqual(10);
  // A song with no lyrics is cut on a steady grid.
  const bare = planShots({ duration: 47, durations: SEEDANCE, pace: 6 });
  expect(bare.every((s) => !s.vocal)).toBe(true);
  expect(bare.every((s) => s.end - s.start >= 2 && s.end - s.start <= 15)).toBe(true);
  expect(bare.at(-1).end).toBe(47);
  // A tiny song is one shot.
  expect(planShots({ duration: 1.5, durations: SEEDANCE })).toEqual([{ n: 1, start: 0, end: 1.5, clip: 4, lines: [], vocal: false }]);
  expect(() => planShots({ duration: 0 })).toThrow();
  expect(() => planShots({ duration: 10, durations: [30] })).toThrow();
  expect(clipFor(4.0, SEEDANCE)).toBe(4);
  expect(clipFor(4.01, SEEDANCE)).toBe(5);
  expect(audioWindow({ start: 12, clip: 8 })).toEqual({ start: 12, length: 8 });
});

test('only models that lip sync to a reference song qualify', () => {
  for (const id of ['bytedance/seedance-2.0', 'bytedance/seedance-2.0-fast', 'bytedance/seedance-2.5', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-5-260628']) {
    expect(isLipSyncModel({ id, audio: true })).toBe(true);
  }
  for (const id of ['bytedance/seedance-1-5-pro', 'kwaivgi/kling-v3.0-pro', 'google/veo-3.1', 'heygen/avatar-iv']) expect(isLipSyncModel({ id, audio: true })).toBe(false);
  expect(isLipSyncModel({ id: 'bytedance/seedance-2.0', audio: false })).toBe(false);
});

test('the storyboard asks for every shot and is checked against the cast', () => {
  // Quick cuts, so the instrumental intro is a shot of its own.
  const shots = planShots({ duration: 30.8, lines: parseTimedLyrics(ANTHEM).lines, durations: SEEDANCE, pace: 4 });
  expect(shots[0]).toMatchObject({ start: 0, end: 4, vocal: false });
  const cast = [{ name: 'Mal', description: 'white marshmallow, yellow headband' }, { name: 'Toast', description: 'golden marshmallow, red headband' }];
  const req = storyboardRequest({ title: 'Just Gains', idea: 'A sunny gym', style: 'pop funk', shots, cast, aspect: '9:16' });
  expect(req.messages[0].content).toContain('"singer"');
  const sent = JSON.parse(req.messages[1].content);
  expect(sent.shots).toHaveLength(shots.length);
  expect(sent.cast.map((c) => c.name)).toEqual(['Mal', 'Toast']);
  expect(sent.frame).toBe('9:16');
  expect(req.response_format).toEqual({ type: 'json_object' });

  const vocal = shots.find((s) => s.vocal), quiet = shots.find((s) => !s.vocal);
  const reply = '```json\n' + JSON.stringify({
    title: 'Soft and Strong', look: 'Warm gym light',
    shots: [
      { n: vocal.n, cast: ['mal', 'Nobody'], singer: '@Mal', image: 'Mal sings at the squat rack', motion: 'He bounces. Slow push in.' },
      { n: quiet.n, cast: ['Toast'], singer: 'Toast', image: 'Toast lifts', motion: 'Pull back.' }
    ]
  }) + '\n```';
  const board = parseStoryboard(reply, shots, cast);
  expect(board.written).toBe(true);
  expect(board.title).toBe('Soft and Strong');
  const v = board.shots.find((s) => s.n === vocal.n), q = board.shots.find((s) => s.n === quiet.n);
  expect(v).toMatchObject({ singer: 'Mal', cast: ['Mal'], image: 'Mal sings at the squat rack' });
  expect(q.singer).toBe(null); // no lyrics, so nobody sings, whatever the model said
  // Shots the model skipped come from the template, still with a singer where there are lyrics.
  expect(board.shots).toHaveLength(shots.length);
  for (const s of board.shots) if (shots[s.n - 1].vocal) expect(['Mal', 'Toast']).toContain(s.singer);
  // Garbage falls back entirely.
  expect(parseStoryboard('sorry, I cannot', shots, cast).written).toBe(false);
});

test('template storyboard and prompts', () => {
  const shots = [{ n: 1, start: 0, end: 4, clip: 4, lines: [], vocal: false }, { n: 2, start: 4, end: 12, clip: 8, lines: ['a', 'b'], vocal: true }, { n: 3, start: 12, end: 20, clip: 8, lines: ['c'], vocal: true }];
  const board = fallbackStoryboard({ shots, cast: [{ name: 'Mal' }, { name: 'Toast' }], idea: 'A neon gym' });
  expect(board.shots.map((s) => s.singer)).toEqual([null, 'Mal', 'Toast']);
  const still = keyframePrompt(board.shots[1], board, '9:16');
  expect(still).toStartWith('Tall 9:16 vertical frame.');
  expect(still).toContain('Mal singing');
  expect(still).toContain('No text');
  expect(still).not.toContain('..');
  expect(motionPrompt(board.shots[1])).toContain('Mal sings the song in the reference audio');
  expect(motionPrompt(board.shots[0])).toContain('Nobody sings');
  const none = fallbackStoryboard({ shots, cast: [] });
  expect(none.shots[1].singer).toBe(null);
  expect(none.shots[1].image).toContain('The singer');
});

test('cost adds the song, a picture and a clip per shot', () => {
  const shots = [{ clip: 8 }, { clip: 4 }];
  const est = estimateCost({ shots, songPricing: { perSong: 0.08 }, imagePricing: { perImage: 0.07 }, videoPricing: { perSecond: 0.09 }, resolution: '480p' });
  expect(est.seconds).toBe(12);
  expect(est.parts.clips).toBeCloseTo(0.09 * 0.445 * 12, 6);
  expect(est.usd).toBeCloseTo(0.08 + 0.14 + 0.09 * 0.445 * 12 + 0.01, 6);
  expect(est.complete).toBe(true);
  expect(estimateCost({ shots, newSong: false, imagePricing: { perImage: 0.07 }, videoPricing: { perSecond: 0.09 } }).parts.song).toBe(0);
  expect(estimateCost({ shots }).complete).toBe(false);
});

test('Lyria 3 Pro lyrics carry no times, and are lined up by ear', async () => {
  const { alignLyrics, linesFromWords } = await import('./music-video-plan.js');
  const pro = '[[A0]]\n[:] (Doo-doo!)\n[:] Let\'s go!\n[[B1]]\n[:] We stepped into the gym, we\'re fluffy and we\'re white,\n[:] We\'re ready to get fit and feel the burn tonight!\n[[C2]]\n[:] We\'re soft but we are tough\n[:] We\'re soft but we are tough';
  const parsed = parseTimedLyrics(pro);
  expect(parsed.timed).toBe(false);
  expect(parsed.lines.map((l) => l.text)).toEqual(["Let's go!", "We stepped into the gym, we're fluffy and we're white,", "We're ready to get fit and feel the burn tonight!", "We're soft but we are tough", "We're soft but we are tough"]);
  // What a speech model heard: slightly wrong words, fillers, and the last line never sung.
  const heard = [];
  const say = (text, at, gap = 0.4) => { for (const w of text.split(' ')) { heard.push({ word: w, start: at, end: at + gap * 0.8 }); at += gap; } return at; };
  let t = say('♪ lets go ♪', 2);
  t = say('we stepped in to the gym were fluffy and were white', 4.5);
  t = say('uh', t + 0.2);
  t = say("we're ready to get fit and feel the bern tonight", 8.3);
  t = say('were soft but we are tuff', 12.2);
  const a = alignLyrics(parsed.lines, heard, 20);
  expect(a.heard).toBeGreaterThan(0.6);
  expect(a.lines).toHaveLength(4); // the unsung repeat is dropped
  expect(a.lines[1].start).toBeCloseTo(4.5, 1);
  expect(a.lines[2].start).toBeCloseTo(8.3, 1);
  expect(a.lines[3].start).toBeCloseTo(12.2, 1);
  for (let i = 1; i < a.lines.length; i++) expect(a.lines[i].start).toBeGreaterThanOrEqual(a.lines[i - 1].start);
  expect(alignLyrics(parsed.lines, [], 20)).toBe(null);
  expect(alignLyrics([{ text: 'completely different words here' }], heard, 20)).toBe(null);
  // A song with no lyrics at all gets lines from what was heard, one per pause.
  const lines = linesFromWords(heard);
  expect(lines.length).toBeGreaterThanOrEqual(3);
  expect(lines[0].start).toBe(2.4); // the ♪ marks are not words
});
