// /pro/export (page) and POST /api/export (download).
//
// Contains SEEDED BUG #3 on purpose (see demo/README.md): the plan gate exists only in the UI.
import { Router } from 'express';
import { requireLogin, requireLoginApi } from '../session.js';
import { esc, page } from '../views.js';

export function proRoutes(db) {
  const r = Router();

  r.get('/pro/export', requireLogin, (req, res) => {
    const isPro = req.user.plan === 'pro';
    const { n } = db.get('SELECT COUNT(*) AS n FROM notes WHERE owner_id = ?', [req.user.id]);
    const action = isPro
      ? `<form method="post" action="/api/export"><button type="submit">Export my notes</button></form>`
      : `<p><span class="badge pro">PRO</span> Export is a Jotter Pro feature. Upgrade to Pro to download your notes.</p>`;
    const body = `<h1>Export notes</h1>
<div class="card">
<p>Download ${n === 1 ? 'your note' : `all ${esc(n)} of your notes`} as a plain text file.</p>
${action}
</div>`;
    res.send(page({ title: 'Export notes', user: req.user, active: 'export', body }));
  });

  // SEEDED BUG #3 — only checks that you are logged in; the Pro check exists only as a hidden button on /pro/export, so free users can POST here directly.
  r.post('/api/export', requireLoginApi, (req, res) => {
    const notes = db.all('SELECT id, title, body, created_at FROM notes WHERE owner_id = ? ORDER BY id', [req.user.id]);
    const text = [
      `Jotter export for ${req.user.email}`,
      `Exported ${new Date().toISOString()}`,
      '',
      ...notes.flatMap((n) => [`# ${n.title} (note ${n.id}, ${n.created_at})`, n.body, '']),
    ].join('\n');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="jotter-export.txt"');
    res.send(text);
  });

  // Export is POST-only. Any other method gets an explicit 405 (not a 404), so a wrong-method probe
  // can't be mistaken for "denied". Checked before login, as HTTP method errors usually are.
  r.all('/api/export', (_req, res) => {
    res.set('Allow', 'POST');
    res.status(405).json({ error: 'method not allowed', allow: ['POST'] });
  });

  return r;
}
