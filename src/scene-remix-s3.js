import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const REMIX_URL_SECONDS = 2 * 60 * 60;
const DELETE_AFTER_MS = (REMIX_URL_SECONDS + 15 * 60) * 1000;
const DEFAULT_PREFIX = 'justimagine/remix';

const settingsFile = (configPath) => configPath ? path.join(path.dirname(configPath), 'scene-remix-s3.json') : '';
const leaseDir = (configPath) => path.join(path.dirname(configPath), 'scene-remix-s3-uploads');
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

export function validateS3Settings(values, previous = {}) {
  const endpointText = String(values.endpoint ?? previous.endpoint ?? '').trim().replace(/\/+$/, '');
  let endpoint = '';
  if (endpointText) {
    let url;
    try { url = new URL(endpointText); } catch { throw invalid('Enter an HTTPS S3 endpoint.'); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        host === 'localhost' || host.endsWith('.local') || net.isIP(host)) throw invalid('Use a public HTTPS S3 endpoint.');
    endpoint = url.origin;
  }
  const region = String(values.region ?? previous.region ?? '').trim();
  const bucket = String(values.bucket ?? previous.bucket ?? '').trim();
  const prefix = String(values.prefix ?? previous.prefix ?? DEFAULT_PREFIX).trim().replace(/^\/+|\/+$/g, '');
  const accessKeyId = String(values.accessKeyId ?? previous.accessKeyId ?? '').trim();
  const secretAccessKey = String(values.secretAccessKey || previous.secretAccessKey || '').trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) throw invalid('Enter a valid S3 bucket name.');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(region) || (!endpoint && region === 'auto')) throw invalid('Enter the bucket region. Use auto with a custom endpoint such as Tigris.');
  if (!prefix || prefix.length > 100 || !/^[a-zA-Z0-9/_-]+$/.test(prefix) || prefix.split('/').some((part) => !part || part === '..')) throw invalid('Use a simple folder prefix, such as justimagine/remix.');
  if (!accessKeyId || accessKeyId.length > 500 || !secretAccessKey || secretAccessKey.length > 500) throw invalid('Enter the S3 access key and secret.');
  return { endpoint, region, bucket, prefix, accessKeyId, secretAccessKey };
}

export function readS3Settings(configPath) {
  const file = settingsFile(configPath);
  if (!file) return null;
  try { return validateS3Settings(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

export function s3SettingsStatus(configPath, canEdit = false) {
  const saved = readS3Settings(configPath);
  return {
    configured: !!saved, canEdit,
    endpoint: saved?.endpoint || '', region: saved?.region || 'auto', bucket: saved?.bucket || '',
    prefix: saved?.prefix || DEFAULT_PREFIX,
    accessKeyPreview: saved ? `••••${saved.accessKeyId.slice(-4)}` : '', secretSaved: !!saved?.secretAccessKey,
    linkHours: REMIX_URL_SECONDS / 3600
  };
}

function clientFor(config) {
  return new S3Client({
    region: config.region, endpoint: config.endpoint || undefined, forcePathStyle: !!config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 2
  });
}

function objectKey(config) {
  return `${config.prefix}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.mp4`;
}

async function signedRead(client, config, key, sign = getSignedUrl) {
  const url = await sign(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: REMIX_URL_SECONDS });
  if (!/^https:\/\//.test(url)) throw new Error('S3 did not return an HTTPS download link.');
  return url;
}

async function verifyRead(url, expected, fetcher = fetch) {
  const response = await fetcher(url, { headers: { range: `bytes=0-${Math.max(0, expected.length - 1)}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`The signed S3 link could not be opened (${response.status}). Check bucket access and endpoint.`);
  const received = Buffer.from(await response.arrayBuffer());
  if (!received.subarray(0, expected.length).equals(expected)) throw new Error('The signed S3 link returned the wrong file.');
}

export async function testS3Settings(config, { client = clientFor(config), sign = getSignedUrl, fetcher = fetch } = {}) {
  const key = objectKey(config);
  const marker = Buffer.from(`justimagine-s3-check-${crypto.randomUUID()}`);
  let uploaded = false;
  try {
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: marker, ContentType: 'text/plain', ContentLength: marker.length }));
    uploaded = true;
    await verifyRead(await signedRead(client, config, key, sign), marker, fetcher);
  } finally {
    try { if (uploaded) await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })); } finally { client.destroy?.(); }
  }
}

function recordLease(configPath, config, key) {
  const dir = leaseDir(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ endpoint: config.endpoint, region: config.region, bucket: config.bucket, key, deleteAfter: Date.now() + DELETE_AFTER_MS }), { flag: 'wx', mode: 0o600 });
}

export async function uploadS3Reference(configPath, file, { client, sign = getSignedUrl, fetcher = fetch } = {}) {
  const config = readS3Settings(configPath);
  if (!config) throw invalid('Set up S3 hosting before sharing the clip.');
  const storage = client || clientFor(config);
  const key = objectKey(config);
  const size = fs.statSync(file).size;
  if (!size) throw invalid('The silent model reference is empty.');
  let uploaded = false;
  try {
    await storage.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: fs.createReadStream(file), ContentLength: size, ContentType: 'video/mp4', CacheControl: 'private, no-store' }));
    uploaded = true;
    const url = await signedRead(storage, config, key, sign);
    const head = Buffer.alloc(Math.min(16, size));
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
    await verifyRead(url, head, fetcher);
    recordLease(configPath, config, key);
    return { url, expiresIn: REMIX_URL_SECONDS };
  } catch (error) {
    if (uploaded) await storage.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })).catch(() => {});
    throw error;
  } finally { if (!client) storage.destroy?.(); }
}

export async function cleanupS3References(configPath, { all = false, client } = {}) {
  const config = readS3Settings(configPath);
  if (!config) return 0;
  const dir = leaseDir(configPath);
  let files;
  try { files = fs.readdirSync(dir).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)); } catch { return 0; }
  const storage = client || clientFor(config);
  let removed = 0, failed = 0;
  try {
    for (const name of files) {
      const file = path.join(dir, name);
      let lease;
      try { lease = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!all && lease.deleteAfter > Date.now()) continue;
      if (lease.endpoint !== config.endpoint || lease.region !== config.region || lease.bucket !== config.bucket || !String(lease.key).startsWith(config.prefix + '/')) {
        if (all) failed++;
        continue;
      }
      try {
        await storage.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: lease.key }));
        fs.rmSync(file, { force: true }); removed++;
      } catch { failed++; /* retry on the next sweep */ }
    }
  } finally { if (!client) storage.destroy?.(); }
  if (all && failed) throw new Error(`Could not remove ${failed} hosted reference${failed === 1 ? '' : 's'}. Try again before changing S3 settings.`);
  return removed;
}

export async function saveS3Settings(configPath, values, options = {}) {
  if (!configPath) throw invalid('This gallery cannot save S3 settings.');
  const previous = readS3Settings(configPath);
  const config = validateS3Settings(values, previous || {});
  await testS3Settings(config, options);
  if (previous && Object.keys(config).some((key) => config[key] !== previous[key])) await cleanupS3References(configPath, { all: true });
  const file = settingsFile(configPath), temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temp, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return s3SettingsStatus(configPath, true);
}

export async function removeS3Settings(configPath) {
  if (!configPath) throw invalid('This gallery cannot save S3 settings.');
  await cleanupS3References(configPath, { all: true });
  fs.rmSync(settingsFile(configPath), { force: true });
  return s3SettingsStatus(configPath, true);
}
