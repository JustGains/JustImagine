import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from './auth.js';

test('auth generates and persists a token across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-auth-'));
  const file = path.join(dir, 'auth.token');
  const first = createAuth({ tokenFile: file });
  const second = createAuth({ tokenFile: file });
  expect(first.enabled).toBe(true);
  expect(first.token).toHaveLength(43);
  expect(second.token).toBe(first.token);
  expect(first.authorize({ headers: { authorization: `Bearer ${first.token}` } })).toBe(true);
  expect(first.authorize({ headers: {} })).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auth false is an explicit host-owned boundary', () => {
  const auth = createAuth({ required: false });
  expect(auth.enabled).toBe(false);
  expect(auth.authorize({ headers: {} })).toBe(true);
});
