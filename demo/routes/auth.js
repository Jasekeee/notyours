// /signup, /login, /logout
import { Router } from 'express';
import { hashPassword, verifyPassword } from '../db.js';
import { endSession, safeNext, startSession } from '../session.js';
import { errorBox, esc, page } from '../views.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function authForm({ kind, error = '', email = '', next = '' }) {
  const signup = kind === 'signup';
  const action = signup ? '/signup' : `/login${next ? `?next=${encodeURIComponent(next)}` : ''}`;
  return `<div class="narrow">
<h1>${signup ? 'Create your Jotter account' : 'Log in to Jotter'}</h1>
<div class="card">
<form class="stack" method="post" action="${esc(action)}">
${errorBox(error)}
${signup ? '<label>Name<input name="name" autocomplete="name" required></label>' : ''}
<label>Email<input name="email" type="email" autocomplete="email" value="${esc(email)}" required></label>
<label>Password<input name="password" type="password" autocomplete="${signup ? 'new' : 'current'}-password" ${signup ? 'minlength="8" ' : ''}required></label>
<button type="submit">${signup ? 'Sign up' : 'Log in'}</button>
</form>
</div>
<p class="muted">${signup ? 'Already have an account? <a href="/login">Log in</a>' : 'New here? <a href="/signup">Create an account</a>'}</p>
</div>`;
}

export function authRoutes(db) {
  const r = Router();

  r.get('/signup', (req, res) => {
    if (req.user) return res.redirect(302, '/notes');
    res.send(page({ title: 'Sign up', active: 'signup', body: authForm({ kind: 'signup' }) }));
  });

  r.post('/signup', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    let error = '';
    if (!name) error = 'Please enter your name.';
    else if (!EMAIL_RE.test(email)) error = 'Please enter a valid email address.';
    else if (password.length < 8) error = 'Password must be at least 8 characters.';
    else if (db.get('SELECT 1 FROM users WHERE email = ?', [email])) error = 'An account with that email already exists.';
    if (error) {
      return res.status(400).send(page({ title: 'Sign up', active: 'signup', body: authForm({ kind: 'signup', error, email }) }));
    }
    const [user] = db.run(
      "INSERT INTO users (email, name, pw_hash, plan, bio) VALUES (?, ?, ?, 'free', '') RETURNING id",
      [email, name, hashPassword(password)],
    );
    startSession(db, res, user.id);
    res.redirect(302, '/notes');
  });

  r.get('/login', (req, res) => {
    const next = typeof req.query.next === 'string' ? req.query.next : '';
    if (req.user) return res.redirect(302, safeNext(next));
    res.send(page({ title: 'Log in', active: 'login', body: authForm({ kind: 'login', next }) }));
  });

  r.post('/login', (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const next = typeof req.query.next === 'string' ? req.query.next : '';
    const user = db.get('SELECT id, pw_hash FROM users WHERE email = ?', [email]);
    if (!user || !verifyPassword(password, user.pw_hash)) {
      const body = authForm({ kind: 'login', error: 'Wrong email or password.', email, next });
      return res.status(401).send(page({ title: 'Log in', active: 'login', body }));
    }
    startSession(db, res, user.id);
    res.redirect(302, safeNext(next));
  });

  const logout = (req, res) => {
    endSession(db, req, res);
    res.redirect(302, '/login');
  };
  r.get('/logout', logout);
  r.post('/logout', logout);

  return r;
}
