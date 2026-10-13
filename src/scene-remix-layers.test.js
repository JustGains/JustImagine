import { expect, test } from 'bun:test';
import { compositePersonDepth } from './scene-remix-layers.js';
import { demoGuideKey } from './scene-remix-cache.js';

test('person depth keeps background pixels and covers the subject', () => {
  const source = { data: new Uint8ClampedArray(7 * 7 * 4).fill(210) };
  const depth = { data: new Uint8ClampedArray(7 * 7 * 4).fill(30) };
  const values = new Float32Array(49);
  values[3 * 7 + 3] = 1;
  const mask = { width: 7, height: 7, getAsFloat32Array: () => values };
  const { coverage } = compositePersonDepth(source, depth, mask, 7, 7);
  expect(coverage).toBeGreaterThan(0);
  expect(depth.data[0]).toBe(210);
  expect(depth.data[(3 * 7 + 3) * 4]).toBe(30);
});

test('demo guide cache key changes with source and settings', () => {
  const base = { version: 'a', start: 0, seconds: 8, mode: 'person-mask', aspectRatio: '16:9', expectedFaces: 2 };
  expect(demoGuideKey(base)).toBe(demoGuideKey({ ...base }));
  expect(demoGuideKey(base)).not.toBe(demoGuideKey({ ...base, version: 'b' }));
  expect(demoGuideKey(base)).not.toBe(demoGuideKey({ ...base, mode: 'depth-only' }));
  expect(demoGuideKey(base)).not.toBe(demoGuideKey({ ...base, expectedFaces: 1 }));
});
