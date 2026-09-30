import { expect, test } from 'bun:test';
import { createJobs, LIMIT_MAX, LIMITS, resolveLimits } from './justimagine-server.js';

// A low cap mostly made images wait in our own queue while the provider sat
// idle; these pin the raised defaults and the `limits` config override.

test('the default caps are high enough that a busy gallery does not queue on our side', () => {
  expect(LIMITS).toEqual({ image: 32, video: 12, song: 8, voice: 6 });
  expect(resolveLimits()).toEqual(LIMITS);
});

test('a configured cap is used, clamped, and a bad one falls back to the default', () => {
  expect(resolveLimits({ image: 50, video: 4 })).toEqual({ ...LIMITS, image: 50, video: 4 });
  expect(resolveLimits({ image: '16' })).toEqual({ ...LIMITS, image: 16 });
  expect(resolveLimits({ song: 2, voice: 99 })).toEqual({ ...LIMITS, song: 2, voice: 32 });
  expect(resolveLimits({ image: 10_000, video: 1e9 })).toMatchObject({ image: LIMIT_MAX.image, video: LIMIT_MAX.video });
  expect(resolveLimits({ image: 10_000, video: 1e9, song: 1e9, voice: 1e9 })).toEqual(LIMIT_MAX);
  expect(resolveLimits({ image: 0, video: -3 })).toEqual(LIMITS);
  expect(resolveLimits({ image: 'lots', video: null })).toEqual(LIMITS);
  expect(resolveLimits({ image: 7.9 })).toMatchObject({ image: 7 });
});

test('that many generations really run at once, and the rest wait their turn', async () => {
  const jobs = createJobs({ limits: resolveLimits({ image: 32 }) });
  expect(jobs.limits.image).toBe(32);
  const release = [];
  let inFlight = 0;
  let peak = 0;
  const ids = Array.from({ length: 40 }, () =>
    jobs.add({
      kind: 'image',
      prompt: 'p',
      run: () =>
        new Promise((resolve) => {
          peak = Math.max(peak, ++inFlight);
          release.push(() => {
            inFlight--;
            resolve({ file: 'x.png' });
          });
        })
    })
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(peak).toBe(32);
  expect(jobs.read(ids).jobs.filter((j) => j.status === 'queued').length).toBe(8);
  // As each finishes the next queued one starts, until all forty are done.
  while (release.length) {
    release.shift()();
    await new Promise((r) => setTimeout(r, 1));
  }
  expect(await jobs.wait(ids, 2000)).toBe(true);
  expect(peak).toBe(32);
});

test('a cap learned from the provider only ever lowers that one kind', () => {
  const jobs = createJobs({ limits: resolveLimits({ voice: 6 }) });
  expect(jobs.capAt('voice', 3)).toBe(true);
  expect(jobs.limits.voice).toBe(3);
  expect(jobs.capAt('voice', 10)).toBe(false); // never raised by a later, larger number
  expect(jobs.limits.voice).toBe(3);
  jobs.capAt('voice', 0);
  expect(jobs.limits.voice).toBe(1); // never below one
  expect(jobs.limits.image).toBe(LIMITS.image);
});
