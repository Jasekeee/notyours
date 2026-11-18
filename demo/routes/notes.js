// /notes, /notes/new, /notes/:id and GET /api/notes/:id
//
// Contains SEEDED BUG #1 and #2 on purpose (see demo/README.md). They are the kind of
// authorization mistake coding agents often ship: the route checks that you are logged in,
// but never checks that the note is yours.
import { Router } from 'express';
import { requireLogin, requireLoginApi } from '../session.js';
import { errorBox, esc, formatDate, page } from '../views.js';

const NOTE_SELECT = `SELECT n.id, n.owner_id, u.email AS owner_email, n.title, n.body, n.created_at
  FROM notes n JOIN users u ON u.id = n.owner_id`;

function parseId(raw) {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

function newNoteForm({ error = '', title = '', body = '' } = {}) {
  return `<h1>New note</h1>
<div class="card">
<form class="stack" method="post" action="/notes/new">
${errorBox(error)}
<label>Title<input name="title" value="${esc(title)}" maxlength="200" required></label>
<label>Note<textarea name="body" maxlength="20000" required>${esc(body)}</textarea></label>
<div><button type="submit">Save note</button></div>
</form>
</div>`;
}

export function notesRoutes(db) {
  const r = Router();

  // Own notes only: this list is correct.
  r.get('/notes', requireLogin, (req, res) => {
    const notes = db.all(`${NOTE_SELECT} WHERE n.owner_id = ? ORDER BY n.created_at DESC, n.id DESC`, [req.user.id]);
    const list = notes.length
      ? `<ul class="notes">${notes
          .map(
            (n) => `<li><a class="card" href="/notes/${n.id}"><h2>${esc(n.title)}</h2><p class="preview">${esc(n.body)}</p></a></li>`,
          )
          .join('')}</ul>`
      : '<div class="card empty">No notes yet. <a href="/notes/new">Write your first one.</a></div>';
    const body = `<div class="row"><h1>My notes</h1><a class="btn" href="/notes/new">New note</a></div>${list}`;
    res.send(page({ title: 'My notes', user: req.user, active: 'notes', body }));
  });

  r.get('/notes/new', requireLogin, (req, res) => {
    res.send(page({ title: 'New note', user: req.user, active: 'new', body: newNoteForm() }));
  });

  r.post('/notes/new', requireLogin, (req, res) => {
    const title = String(req.body?.title ?? '').trim();
    const body = String(req.body?.body ?? '');
    if (!title || !body.trim()) {
      const form = newNoteForm({ error: 'A note needs a title and some text.', title, body });
      return res.status(400).send(page({ title: 'New note', user: req.user, active: 'new', body: form }));
    }
    const [note] = db.run('INSERT INTO notes (owner_id, title, body, created_at) VALUES (?, ?, ?, ?) RETURNING id', [
      req.user.id, title.slice(0, 200), body.slice(0, 20000), new Date().toISOString(),
    ]);
    res.redirect(302, `/notes/${note.id}`);
  });

  r.get('/notes/:id', requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    // SEEDED BUG #1 — loads the note by id alone; any logged-in user can read anyone's note (missing `AND n.owner_id = ?`).
    const note = id === null ? undefined : db.get(`${NOTE_SELECT} WHERE n.id = ?`, [id]);
    if (!note) {
      return res.status(404).send(page({ title: 'Not found', user: req.user, body: '<h1>Note not found</h1><p><a href="/notes">Back to my notes</a></p>' }));
    }
    const body = `<p><a href="/notes">&larr; My notes</a></p>
<article class="card">
<h1>${esc(note.title)}</h1>
<p class="meta">${esc(note.owner_email)} · ${esc(formatDate(note.created_at))}</p>
<p class="body">${esc(note.body)}</p>
</article>`;
    res.send(page({ title: note.title, user: req.user, active: 'notes', body }));
  });

  r.get('/api/notes/:id', requireLoginApi, (req, res) => {
    const id = parseId(req.params.id);
    // SEEDED BUG #2 — returns the full record (owner email, body) for any id without checking the caller owns it.
    const note = id === null ? undefined : db.get(`${NOTE_SELECT} WHERE n.id = ?`, [id]);
    if (!note) return res.status(404).json({ error: 'not found' });
    res.json(note);
  });

  return r;
}
