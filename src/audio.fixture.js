// Test fixtures for audio. Excluded from the package by src/.npmignore.

// A constant-bitrate MPEG-1 Layer III stream: 128 kbps, 44.1 kHz, stereo.
// Each frame is 417 bytes; `seconds` worth of them, behind an ID3 tag.
export function fakeMp3(seconds = 2, { id3 = true } = {}) {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const frame = Buffer.concat([header, Buffer.alloc(413)]);
  const frames = Math.round((seconds * 44100) / 1152);
  const body = Buffer.concat(Array.from({ length: frames }, () => frame));
  if (!id3) return body;
  const tag = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 20]), Buffer.alloc(20)]);
  return Buffer.concat([tag, body]);
}
