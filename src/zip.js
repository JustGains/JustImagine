// A stored (uncompressed) ZIP written straight to a response. Results are PNGs,
// which deflate cannot shrink, so storing them keeps "Download all" instant.
import fs from 'node:fs';
import zlib from 'node:zlib';

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export const crc32 = zlib.crc32 || ((buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
});

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// entries: [{ name, path }]. Names must already be unique; each file is read
// whole, one at a time.
export async function writeZip(out, entries) {
  const central = [];
  let offset = 0;
  const write = (buf) => new Promise((resolve, reject) => {
    out.write(buf, (error) => (error ? reject(error) : resolve()));
    offset += buf.length;
  });
  for (const entry of entries) {
    const data = fs.readFileSync(entry.path);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const { time, day } = dosTime(fs.statSync(entry.path).mtime);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(0, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(day, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    const at = offset;
    await write(head); await write(name); await write(data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(time, 12); dir.writeUInt16LE(day, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(at, 42);
    central.push(Buffer.concat([dir, name]));
  }
  const start = offset;
  const directory = Buffer.concat(central);
  await write(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(start, 16);
  await write(end);
}
