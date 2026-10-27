// Generated from justimagine-audio.js by sync-credit-catalog.mjs.
export function audioExt(buf) {
  if (!buf || buf.length < 12) return 'mp3';
  const head = buf.toString('latin1', 0, 4);
  if (head.startsWith('ID3')) return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (head === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (head === 'fLaC') return 'flac';
  if (head === 'OggS') return 'ogg';
  if (buf.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  return 'mp3';
}

const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// How long a clip runs, in seconds, read from the file itself so the gallery
// can label a tile without decoding it. WAV is exact; MP3 is exact when the
// encoder wrote a Xing/Info or VBRI frame count, and a constant-bitrate
// estimate otherwise. Anything else is left unknown rather than guessed.
export function audioDuration(buf) {
  if (!buf || buf.length < 64) return null;
  const ext = audioExt(buf);
  if (ext === 'wav') {
    let i = 12;
    let byteRate = 0;
    while (i + 8 <= buf.length) {
      const id = buf.toString('latin1', i, i + 4);
      const size = buf.readUInt32LE(i + 4);
      if (id === 'fmt ' && i + 16 <= buf.length) byteRate = buf.readUInt32LE(i + 16);
      if (id === 'data') return byteRate ? round(Math.min(size, buf.length - i - 8) / byteRate) : null;
      i += 8 + size + (size % 2);
    }
    return null;
  }
  if (ext !== 'mp3') return null;
  let start = 0;
  if (buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  // The first real frame header: a sync, Layer III, and indices that mean something.
  for (let i = start; i + 4 < Math.min(buf.length, start + 64 * 1024); i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (buf[i + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (buf[i + 1] >> 1) & 3; // 1 = Layer III
    const bitrateIdx = buf[i + 2] >> 4;
    const rateIdx = (buf[i + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) continue;
    const mpeg1 = version === 3;
    const bitrate = MP3_BITRATES[mpeg1 ? 1 : 2][bitrateIdx] * 1000;
    const sampleRate = MP3_RATES[version][rateIdx];
    const samples = mpeg1 ? 1152 : 576;
    const mono = buf[i + 3] >> 6 === 3;
    const side = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const xing = i + 4 + side;
    const tag = buf.toString('latin1', xing, xing + 4);
    if ((tag === 'Xing' || tag === 'Info') && buf.readUInt32BE(xing + 4) & 1) {
      return round((buf.readUInt32BE(xing + 8) * samples) / sampleRate);
    }
    if (buf.toString('latin1', i + 36, i + 40) === 'VBRI') {
      return round((buf.readUInt32BE(i + 36 + 14) * samples) / sampleRate);
    }
    return round(((buf.length - i) * 8) / bitrate);
  }
  return null;
}

const round = (s) => (Number.isFinite(s) && s > 0 ? Math.round(s * 10) / 10 : null);

