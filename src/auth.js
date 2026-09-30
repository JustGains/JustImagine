import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AUTH_COOKIE = 'justimagine_auth';

export function createAuth({ token = '', tokenFile = '', required = true } = {}) {
  let current = token || '';
  if (!current && tokenFile) {
    try { current = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (required && !current) {
    current = crypto.randomBytes(32).toString('base64url');
    if (tokenFile) {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      try {
        fs.writeFileSync(tokenFile, `${current}\n`, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        current = fs.readFileSync(tokenFile, 'utf8').trim();
        if (!current) throw new Error('The authentication token file is empty.');
      }
    }
  }
  const enabled = required !== false;
  const matches = (value) => {
    if (!enabled || !current || typeof value !== 'string') return false;
    const a = Buffer.from(current);
    const b = Buffer.from(value);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const headerToken = (req) => {
    const auth = String(req.headers.authorization || '');
    if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    const cookie = String(req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${AUTH_COOKIE}=`));
    try { return cookie ? decodeURIComponent(cookie.slice(AUTH_COOKIE.length + 1)) : ''; }
    catch { return ''; }
  };
  return {
    enabled,
    token: current,
    tokenFile,
    authorize: (req) => !enabled || matches(headerToken(req)),
    tokenFromRequest: headerToken,
    matches,
    challenge: () => ({ 'www-authenticate': 'Bearer realm="JustImagine"' })
  };
}

export function authTokenFromUrl(url) {
  return url.searchParams.get('token') || '';
}

export function authCookie(token) {
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
}
