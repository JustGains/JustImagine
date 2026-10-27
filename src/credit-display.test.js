import { test, expect } from 'bun:test';
import { presentCreditModel } from './credit-display.js';

test('account model facts use credits for images, video, songs and speech', () => {
  const billing = { mode: 'credits', creditsPerUsd: 100 };
  for (const [kind, pricing, label] of [
    ['image', { perImage: 0.025 }, '3 cr/image'], ['video', { perSecond: 0.05 }, '5 cr/s'],
    ['song', { perSong: 0.08 }, '8 cr/song'], ['voice', { per1kCharacters: 0.1 }, '10 cr/1k characters']
  ]) {
    const shown = presentCreditModel({ id: 'test', pricing, facts: { cost: { label: '5¢', title: '$0.05' } }, detail: { costNote: '$0.05', blurb: 'Costs $0.05 per request.' } }, kind, billing);
    expect(shown.facts.cost.label).toBe(label);
    expect(shown.facts.cost.title).not.toMatch(/¢|\$/);
    expect(shown.detail.blurb).not.toMatch(/¢|\$/);
    expect(shown.detail.costNote).not.toMatch(/¢|\$/);
  }
  const local = { id: 'own-key', facts: { cost: { label: '5¢' } } };
  expect(presentCreditModel(local, 'image', null)).toBe(local);
});
