import { audioDuration } from './credit-audio.js';
// Shared account pricing. Copied into SuperServer by sync-credit-catalog.mjs.
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function requestCost(catalog, provider, path, payload) {
  if (provider === 'elevenlabs' && path === '/v1/text-to-voice' && payload.generated_voice_id) return 0;
  const id = payload.model || payload.model_id;
  const model = catalog.models.find(m => m.provider === provider && m.id === id);
  const p = model?.pricing;
  if (!p) throw new HttpError(503, 'This model has no account credit price yet. Choose another model.');
  if (p.perAudioSecond != null) {
    const seconds = audioDuration(Buffer.from(payload.input_audio?.data || '', 'base64'));
    if (!seconds || seconds > 3600) throw new HttpError(400, 'Use an MP3 or WAV clip up to one hour for transcription.');
    return Math.ceil(seconds) * p.perAudioSecond;
  }
  const n = Number(payload.n ?? 1);
  if (!Number.isSafeInteger(n) || n < 1 || n > 4) throw new HttpError(400, 'Generate between one and four items per request.');
  if (p.per1kCharacters != null) {
    const chars = String(payload.text || '').length + (payload.inputs || []).reduce((sum, line) => sum + String(line.text || '').length, 0);
    if (!chars || chars > 100_000) throw new HttpError(400, 'Write between 1 and 100,000 characters.');
    return chars / 1000 * p.per1kCharacters;
  }
  if (p.perCall != null) return p.perCall * n;
  if (model.kind === 'video') {
    const asked = Number(payload.seconds ?? payload.duration);
    // Adaptive edits can only be quoted after seeing their source; hold the model's
    // maximum supported duration until the provider reports the actual cost.
    const seconds = asked > 0 ? asked : Math.max(...(model.durations || [30]));
    if (!Number.isFinite(seconds) || seconds > 120) throw new HttpError(400, 'Use a video duration of at most 120 seconds.');
    const perSecond = payload.generate_audio === false ? p.perSecond : p.perSecondAudio ?? p.perSecond;
    if (perSecond != null) return perSecond * seconds * n;
    if (p.perClip != null) return p.perClip * n;
  }
  if (p.perSong != null || p.perClip != null) return (p.perSong ?? p.perClip) * n;
  if (p.perImage != null) return p.perImage * n;
  if (p.prompt != null && p.completion != null) {
    // A UTF-8 byte is an upper bound on a text token. Bound output before sending.
    const input = Buffer.byteLength(JSON.stringify(payload.messages || []));
    const output = Number(payload.max_completion_tokens ?? payload.max_tokens ?? 4096);
    if (!Number.isSafeInteger(output) || output < 1 || output > 32768) throw new HttpError(400, 'Use an output limit between 1 and 32,768 tokens.');
    return (input * p.prompt + output * p.completion) / 1e6;
  }
  throw new HttpError(503, 'This request has no account credit price yet.');
}

export function providerResult(data) {
  const layers = [data, data?.data, data?.data?.data].filter(v => v && typeof v === 'object');
  const first = pick => layers.map(pick).find(v => v !== undefined && v !== null && v !== '');
  const status = String(first(v => v.status ?? v.task_status) || '').toLowerCase();
  const code = data?.code;
  const failed = ['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled', 'expired'].includes(status)
    || !!data?.error || code !== undefined && ![0, '0', 200, '200', 'success'].includes(code);
  return { failed, done: ['done', 'completed', 'succeeded', 'succeed', 'success', 'video_generation_completed'].includes(status), pending: !failed && ['queued', 'pending', 'running', 'processing', 'in_progress', 'submitted', 'starting'].includes(status), id: first(v => v.task_id ?? v.id ?? v.request_id), usd: first(v => v.usage?.cost ?? v.cost) };
}
