import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { cleanupS3References, readS3Settings, removeS3Settings, saveS3Settings, s3SettingsStatus, uploadS3Reference, validateS3Settings } from './scene-remix-s3.js';

const input = { endpoint: 'https://t3.storage.dev', region: 'auto', bucket: 'justimagine-tests', prefix: 'justimagine/remix', accessKeyId: 'example-access-id', secretAccessKey: 'example-secret' };

test('S3 settings keep credentials server-side and reject unsafe endpoints', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-s3-settings-'));
  const configPath = path.join(root, 'config.json');
  let stored = Buffer.alloc(0);
  const commands = [];
  const client = {
    send: async (command) => {
      commands.push(command);
      if (command instanceof PutObjectCommand) stored = Buffer.from(command.input.Body);
      return {};
    }, destroy() {}
  };
  try {
    expect(() => validateS3Settings({ ...input, endpoint: 'http://127.0.0.1:9000' })).toThrow('public HTTPS');
    expect(() => validateS3Settings({ ...input, prefix: '../private' })).toThrow('folder prefix');
    const status = await saveS3Settings(configPath, input, { client, sign: async (_, command, options) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(options.expiresIn).toBe(7200);
      return 'https://t3.storage.dev/justimagine-tests/check';
    }, fetcher: async () => new Response(stored, { status: 206 }) });
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(input.secretAccessKey);
    expect(status.accessKeyPreview.endsWith('s-id')).toBe(true);
    expect(commands.some((command) => command instanceof PutObjectCommand)).toBe(true);
    expect(commands.some((command) => command instanceof DeleteObjectCommand)).toBe(true);
    expect(readS3Settings(configPath).secretAccessKey).toBe(input.secretAccessKey);
    expect(s3SettingsStatus(configPath).secretAccessKey).toBeUndefined();
    expect(validateS3Settings({ secretAccessKey: '' }, readS3Settings(configPath)).secretAccessKey).toBe(input.secretAccessKey);
    await removeS3Settings(configPath);
    expect(s3SettingsStatus(configPath).configured).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('S3 upload makes a signed private MP4 link and records cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-s3-upload-'));
  const configPath = path.join(root, 'config.json'), clip = path.join(root, 'silent.mp4');
  fs.writeFileSync(path.join(root, 'scene-remix-s3.json'), JSON.stringify(input));
  fs.writeFileSync(clip, Buffer.from('000000206674797069736f6d00000200', 'hex'));
  let uploaded = Buffer.alloc(0), removed = 0;
  const client = {
    send: async (command) => {
      if (command instanceof PutObjectCommand) {
        expect(command.input.ContentType).toBe('video/mp4');
        for await (const part of command.input.Body) uploaded = Buffer.concat([uploaded, part]);
      }
      if (command instanceof DeleteObjectCommand) removed++;
      return {};
    }
  };
  try {
    const shared = await uploadS3Reference(configPath, clip, { client, sign: async () => 'https://t3.storage.dev/signed.mp4',
      fetcher: async () => new Response(uploaded, { status: 206 }) });
    expect(shared.url).toBe('https://t3.storage.dev/signed.mp4');
    expect(shared.expiresIn).toBe(7200);
    expect(uploaded.equals(fs.readFileSync(clip))).toBe(true);
    expect(await cleanupS3References(configPath, { all: true, client })).toBe(1);
    expect(removed).toBe(1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
