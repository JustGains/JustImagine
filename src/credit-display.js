// Provider prices remain in USD for estimates. Account mode changes every visible unit.
export const creditAmount = (usd, billing) => Math.max(0, Math.ceil(Number(usd) * billing.creditsPerUsd - 1e-9));
export const creditLabel = amount => `${amount.toLocaleString()} credit${amount === 1 ? '' : 's'}`;

export function presentCreditModel(model, kind, billing, prices = []) {
  if (billing?.mode !== 'credits') return model;
  const priced = prices.find(m => m.id === model.id && m.provider === (model.api || (kind === 'voice' ? 'elevenlabs' : 'openrouter')));
  const pricing = priced?.pricing || model.pricing || {};
  let usd, unit;
  if (kind === 'voice') { usd = pricing.per1kCharacters ?? pricing.perCall; unit = pricing.perCall != null ? '/take' : '/1k characters'; }
  else if (kind === 'video') { usd = pricing.perSecondAudio ?? pricing.perSecond ?? pricing.perClip; unit = pricing.perSecond != null ? '/s' : '/clip'; }
  else if (kind === 'song') { usd = pricing.perSong ?? pricing.perClip; unit = '/song'; }
  else { usd = pricing.perImage; unit = '/image'; }
  const amount = Number.isFinite(usd) ? creditAmount(usd, billing) : null;
  return {
    ...model, description: String(model.description || '').replace(/\$\s*\d[\d,.]*|\d[\d,.]*\s*[¢]/g, 'account credits'), pricing,
    accountPricing: { mode: 'credits', creditsPerUsd: billing.creditsPerUsd, per1kCharacters: pricing.per1kCharacters, perCall: pricing.perCall },
    facts: { ...model.facts, cost: amount === null ? null : { rating: model.facts?.cost?.rating || 1, label: `${amount.toLocaleString()} cr${unit}`, title: `${creditLabel(amount)}${unit.replace('/', ' per ')} from your shared account.` } },
    detail: { ...model.detail, costNote: amount === null ? 'An account credit price is not available for this model.' : '', blurb: String(model.detail?.blurb || '').replace(/\$\s*\d[\d,.]*(?:\s*\/\s*\w+)?|\d[\d,.]*\s*[¢]/g, 'account credits') }
  };
}
