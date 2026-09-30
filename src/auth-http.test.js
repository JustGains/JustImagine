import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from './auth.js';
import { createServer, listenOnFreePort } from './justimagine-server.js';
import { probe } from './justimagine-service.js';

test('auth gates every gallery route and exchanges browser credentials without leaking paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-http-auth-'));
  const auth = createAuth({ token: 'test-only-token' });
  const server = createServer({ root, charactersRoot: path.join(root, 'cast'), apis: [], auth });
  const port = await listenOnFreePort(server, 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const route of ['/', '/api/state', '/api/config', '/api/events', '/media/private.png', '/thumb/private.png', '/context/private.png', '/charref/private.png']) {
      const response = await fetch(base + route);
      expect(response.status).toBe(401);
      await response.text();
    }
    const health = await fetch(base + '/health').then(r => r.json());
    expect(health).toEqual({ ok: true, title: 'JustImagine', service: 'justimagine' });
    expect(await probe(port)).toEqual({ root: undefined, title: 'JustImagine' });
    const rejected = await fetch(base + '/api/folder', { method: 'POST', body: '{"name":"private"}' });
    expect(rejected.status).toBe(401);
    expect(fs.existsSync(path.join(root, 'private'))).toBe(false);

    const login = await fetch(base + '/?token=test-only-token', { redirect: 'manual' });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/');
    expect(login.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const headers = { cookie: cookie.split(';')[0] };
    expect((await fetch(base + '/api/state', { headers })).status).toBe(200);
    expect((await fetch(base + '/api/state', { headers: { authorization: 'Bearer test-only-token' } })).status).toBe(200);
    expect((await fetch(base + '/api/state?token=test-only-token')).status).toBe(401);
    expect((await fetch(base + '/api/state', { headers: { cookie: 'justimagine_auth=%invalid' } })).status).toBe(401);
    expect((await fetch(base + '/api/folder', { method: 'POST', headers: { ...headers, origin: 'https://other.example' }, body: '{"name":"blocked"}' })).status).toBe(403);
  } finally {
    server.jobs.closeAll();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Bro host policy serves the gallery without creating an authentication token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-host-'));
  const server = createServer({ root, charactersRoot: path.join(root, 'cast'), apis: [], auth: false });
  const port = await listenOnFreePort(server, 0);
  try {
    expect((await fetch(`http://127.0.0.1:${port}/api/state`)).status).toBe(200);
    expect(fs.existsSync(path.join(root, 'auth.token'))).toBe(false);
  } finally {
    server.jobs.closeAll();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
