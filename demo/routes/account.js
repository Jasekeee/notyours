// /account: plan + profile bio (correct: always the logged-in user's own account).
import { Router } from 'express';
import { requireLogin } from '../session.js';
import { esc, page, planBadge } from '../views.js';

export function accountRoutes(db) {
  const r = Router();

  r.get('/account', requireLogin, (req, res) => {
    const u = req.user;
    const saved = req.query.saved === '1' ? '<p class="muted" role="status">Bio saved.</p>' : '';
    const body = `<h1>Account</h1>
<div class="card">
<dl>
<dt>Name</dt><dd>${esc(u.name)}</dd>
<dt>Email</dt><dd>${esc(u.email)}</dd>
<dt>Plan</dt><dd>${planBadge(u.plan)} ${u.plan === 'pro' ? 'Jotter Pro' : 'Jotter Free'}</dd>
<dt>Bio</dt><dd class="bio">${u.bio ? esc(u.bio) : '<span class="muted">No bio yet.</span>'}</dd>
</dl>
</div>
<div class="card">
<form class="stack" method="post" action="/account">
${saved}
<label>Edit bio<textarea name="bio" maxlength="500">${esc(u.bio)}</textarea></label>
<div><button type="submit">Save bio</button></div>
</form>
</div>`;
    res.send(page({ title: 'Account', user: u, active: 'account', body }));
  });

  r.post('/account', requireLogin, (req, res) => {
    const bio = String(req.body?.bio ?? '').slice(0, 500);
    db.run('UPDATE users SET bio = ? WHERE id = ?', [bio, req.user.id]);
    res.redirect(302, '/account?saved=1');
  });

  return r;
}
