// Tiny notes app with deliberate leaks, for engine tests and the Kane smoke run. Test-only; never bundled.
//   /notes/:id          LEAKY   any signed-in user sees any note (IDOR)            -> LEAK_VISIBLE
//   /notes/:id/preview  LEAKY   renders "no access", but /api/notes/:id sends body -> LEAK_PAYLOAD
//   /notes/:id/safe     SAFE    owner only, 404 otherwise
//   /export(-leaky)     plan-gated export (pro only) / leaky variant ignoring the plan
//   unknown paths       404 page that echoes the requested path (URL-echo false positive)
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import { customAlphabet } from 'nanoid';

interface User { email: string; password: string; plan: 'free' | 'pro' }
interface Note { id: string; owner: string; title: string; body: string }

const nid = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 10);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface FixtureApp {
  url: string;
  users: Map<string, User>;
  notes: Map<string, Note>;
  addUser(email: string, password: string, plan?: 'free' | 'pro'): void;
  addNote(ownerEmail: string, title: string, body: string): Note;
  /** Session cookie value for a user (tests log Chromes in without a Kane run). */
  sessionFor(email: string): string;
  /** Every request in arrival order: '<email or anon> <METHOD> <path>' (tests check visit order). */
  requests: string[];
  close(): Promise<void>;
}

export async function startFixture(port = 0): Promise<FixtureApp> {
  const users = new Map<string, User>();
  const notes = new Map<string, Note>();
  const sessions = new Map<string, string>(); // sid -> email

  const newSession = (email: string) => { const sid = nid() + nid(); sessions.set(sid, email); return sid; };
  const me = (req: Request): User | undefined => {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const email = sid ? sessions.get(sid) : undefined;
    return email ? users.get(email) : undefined;
  };
  const setSession = (res: Response, email: string) =>
    res.setHeader('Set-Cookie', `sid=${newSession(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  const page = (res: Response, title: string, body: string, status = 200, who?: User) =>
    res.status(status).type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · Fixture Notes</title></head><body>` +
        `<nav><a href="/notes">My notes</a> · <a href="/notes/new">New note</a> · ` +
        `${who ? `Signed in as <b>${esc(who.email)}</b> (<a href="/logout">Sign out</a>)` : '<a href="/login">Log in</a> · <a href="/signup">Sign up</a>'}</nav>` +
        `<main>${body}</main></body></html>`,
    );
  const needLogin = (req: Request, res: Response): User | undefined => {
    const u = me(req);
    if (!u) page(res, 'Log in required', '<h1>Please log in</h1><p><a href="/login">Log in</a></p>', 401);
    return u;
  };

  const app = express();
  const requests: string[] = [];
  app.use((req, _res, next) => { requests.push(`${me(req)?.email ?? 'anon'} ${req.method} ${req.path}`); next(); });
  // A strict CSP like the natural app's (default-src 'none' also blocks fetch()), except on the SPA-style preview page.
  app.use((req, res, next) => { if (!req.path.endsWith('/preview')) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'"); next(); });
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (req, res) => page(res, 'Home', '<h1>Fixture Notes</h1><p>A tiny notes app.</p>', 200, me(req)));

  const authForm = (action: string, label: string) =>
    `<h1>${label}</h1><form method="post" action="${action}"><label>Email <input name="email" type="email" required></label>` +
    `<label>Password <input name="password" type="password" required></label><button type="submit">${label}</button></form>`;
  app.get('/signup', (req, res) => page(res, 'Sign up', authForm('/signup', 'Sign up'), 200, me(req)));
  app.post('/signup', (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) return page(res, 'Sign up', `<p role="alert">Email and password are required.</p>${authForm('/signup', 'Sign up')}`, 400);
    if (users.has(email)) return page(res, 'Sign up', `<p role="alert">Account already exists.</p>${authForm('/signup', 'Sign up')}`, 409);
    users.set(email, { email, password, plan: 'free' });
    setSession(res, email);
    res.redirect(303, '/notes');
  });
  app.get('/login', (req, res) => page(res, 'Log in', authForm('/login', 'Log in'), 200, me(req)));
  app.post('/login', (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    const u = email ? users.get(email) : undefined;
    if (!u || u.password !== password) return page(res, 'Log in', `<p role="alert">Wrong email or password.</p>${authForm('/login', 'Log in')}`, 401);
    setSession(res, u.email);
    res.redirect(303, '/notes');
  });
  app.get('/logout', (_req, res) => { res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0'); res.redirect(303, '/'); });

  app.get('/notes', (req, res) => {
    const u = needLogin(req, res); if (!u) return;
    const mine = [...notes.values()].filter((n) => n.owner === u.email);
    page(res, 'My notes', `<h1>My notes</h1><ul>${mine.map((n) => `<li><a href="/notes/${n.id}">${esc(n.title)}</a></li>`).join('') || '<li>No notes yet.</li>'}</ul><p><a href="/notes/new">New note</a></p>`, 200, u);
  });
  app.get('/notes/new', (req, res) => {
    const u = needLogin(req, res); if (!u) return;
    page(res, 'New note', '<h1>New note</h1><form method="post" action="/notes"><label>Title <input name="title" required></label>' +
      '<label>Body <textarea name="body" required></textarea></label><button type="submit">Save note</button></form>', 200, u);
  });
  app.post('/notes', (req, res) => {
    const u = needLogin(req, res); if (!u) return;
    const { title, body } = req.body as { title?: string; body?: string };
    const n = { id: nid(), owner: u.email, title: title || 'Untitled', body: body ?? '' };
    notes.set(n.id, n);
    res.redirect(303, `/notes/${n.id}`);
  });

  // LEAKY: no owner check.
  app.get('/notes/:id', (req, res) => {
    const u = needLogin(req, res); if (!u) return;
    const n = notes.get(req.params.id);
    if (!n) return page(res, 'Not found', '<h1>Note not found</h1>', 404, u);
    page(res, n.title, `<article><h1>${esc(n.title)}</h1><p class="body">${esc(n.body)}</p></article>`, 200, u);
  });
  // SAFE: owner only.
  app.get('/notes/:id/safe', (req, res) => {
    const u = needLogin(req, res); if (!u) return;
    const n = notes.get(req.params.id);
    if (!n || n.owner !== u.email) return page(res, 'Not found', '<h1>Note not found</h1>', 404, u);
    page(res, n.title, `<article><h1>${esc(n.title)}</h1><p class="body">${esc(n.body)}</p></article>`, 200, u);
  });
  // LEAKY payload: the page hides the note, but the API it calls returns it.
  app.get('/notes/:id/preview', (req, res) => {
    const u = needLogin(req, res); if (!u) return;
    page(res, 'Preview', `<h1>Preview</h1><div id="out">Loading…</div><script>
      fetch('/api/notes/${esc(req.params.id)}').then(r => r.json()).then(d => {
        document.getElementById('out').textContent = d.owner === d.me ? d.title + ': ' + d.body : 'You do not have access to this note.';
      });</script>`, 200, u);
  });
  // Oracle edge cases (AUD-12/13): an XML API with no owner check; a body over the 2 MB scan cap with the note at
  // the end; and a "raw" API that answers 404 for free users' notes (a wrong path for them) and 200 for pro notes.
  app.get('/notes/:id/xml', (req, res) => {
    if (!me(req)) return res.status(401).type('application/xml').send('<error>login required</error>');
    const n = notes.get(req.params.id);
    if (!n) return res.status(404).type('application/xml').send('<error>not found</error>');
    res.type('application/xml').send(`<note><title>${esc(n.title)}</title><body>${esc(n.body)}</body></note>`);
  });
  app.get('/notes/:id/big', (req, res) => {
    const n = notes.get(req.params.id);
    if (!me(req) || !n) return res.status(404).type('text').send('not found');
    res.type('text').send(`${'x'.repeat(2 * 1024 * 1024 + 4096)}\n${n.body}`);
  });
  app.get('/notes/:id/pro-raw', (req, res) => {
    const u = me(req); const n = notes.get(req.params.id);
    if (!u || !n || users.get(n.owner)?.plan !== 'pro') return res.status(404).json({ error: 'not found' });
    res.json({ body: n.body });
  });

  app.get('/api/notes/:id', (req, res) => {
    const u = me(req); if (!u) return res.status(401).json({ error: 'login required' });
    const n = notes.get(req.params.id);
    if (!n) return res.status(404).json({ error: 'not found' });
    res.json({ ...n, me: u.email });
  });

  const exportPage = (u: User, gated: boolean, res: Response) => {
    if (gated && u.plan !== 'pro') return page(res, 'Export', '<h1>Export</h1><p>Export is a Pro feature. Upgrade to Pro.</p>', 402, u);
    const mine = [...notes.values()].filter((n) => n.owner === u.email);
    page(res, 'Export', `<h1>Export</h1><pre>${mine.map((n) => esc(`${n.title},${n.body}`)).join('\n')}</pre>`, 200, u);
  };
  app.get('/export', (req, res) => { const u = needLogin(req, res); if (u) exportPage(u, true, res); });
  app.get('/export-leaky', (req, res) => { const u = needLogin(req, res); if (u) exportPage(u, false, res); });
  // A file download (like the natural app's /export.txt): text/plain attachment of the caller's notes. Pro-gated + leaky twin.
  const exportFile = (gated: boolean) => (req: Request, res: Response) => {
    const u = needLogin(req, res);
    if (!u) return;
    if (gated && u.plan !== 'pro') { res.status(403).type('text').send('Pro required'); return; }
    const mine = [...notes.values()].filter((n) => n.owner === u.email).map((n) => `# ${n.title}\n${n.body}\n`).join('\n');
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="notes.txt"' }).send(mine || '(no notes)');
  };
  app.get('/export.txt', exportFile(true));
  app.get('/export-leaky.txt', exportFile(false));

  // POST-only export API (like the demo's): pro-gated, plus a leaky twin. Other methods get 405.
  const exportApi = (gated: boolean) => (req: Request, res: Response) => {
    const u = me(req); if (!u) return res.status(401).json({ error: 'login required' });
    if (gated && u.plan !== 'pro') return res.status(402).json({ error: 'Pro plan required' });
    res.json({ notes: [...notes.values()].filter((n) => n.owner === u.email) });
  };
  app.post('/api/export', exportApi(true));
  app.post('/api/export-leaky', exportApi(false));
  app.all(['/api/export', '/api/export-leaky'], (_req, res) => res.status(405).setHeader('Allow', 'POST').json({ error: 'method not allowed' }));

  // 404 that echoes the requested path.
  app.use((req, res) => page(res, 'Not found', `<h1>Not found</h1><p class="echo">Cannot GET ${esc(decodeURIComponent(req.path))}</p>`, 404, me(req)));

  const server: Server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    users,
    notes,
    addUser: (email, password, plan = 'free') => { users.set(email, { email, password, plan }); },
    addNote: (owner, title, body) => { const n = { id: nid(), owner, title, body }; notes.set(n.id, n); return n; },
    sessionFor: (email) => newSession(email),
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
