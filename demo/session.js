// Minimal cookie sessions stored in the sessions table (no extra dependencies).
import crypto from 'node:crypto';

export const COOKIE = 'jotter_sid';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Sets req.user ({ id, email, name, plan, bio } or null) from the session cookie. */
export function loadUser(db) {
  return (req, _res, next) => {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    req.sessionId = sid;
    req.user = sid
      ? (db.get(
          'SELECT u.id, u.email, u.name, u.plan, u.bio FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
          [sid],
        ) ?? null)
      : null;
    next();
  };
}

export function startSession(db, res, userId) {
  const sid = crypto.randomBytes(24).toString('base64url');
  db.run('INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)', [sid, userId, new Date().toISOString()]);
  res.setHeader('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
}

export function endSession(db, req, res) {
  if (req.sessionId) db.run('DELETE FROM sessions WHERE id = ?', [req.sessionId]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Pages: guests are redirected to /login (and come back after logging in). */
export function requireLogin(req, res, next) {
  if (req.user) return next();
  res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
}

/** API: guests get 401 JSON. */
export function requireLoginApi(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'login required' });
}

/** Only same-site relative paths are allowed as a post-login redirect. */
export function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/notes';
}
