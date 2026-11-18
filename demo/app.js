// Jotter: a small notes app with three labelled, deliberately seeded authorization bugs.
import express from 'express';
import { loadUser } from './session.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import { notesRoutes } from './routes/notes.js';
import { proRoutes } from './routes/pro.js';
import { page } from './views.js';

/** @param {Awaited<ReturnType<typeof import('./db.js').openDb>>} db */
export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(loadUser(db));

  app.get('/', (req, res) => res.redirect(302, req.user ? '/notes' : '/login'));
  app.use(authRoutes(db));
  app.use(notesRoutes(db));
  app.use(accountRoutes(db));
  app.use(proRoutes(db));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
    res.status(404).send(page({ title: 'Not found', user: req.user, body: '<h1>Page not found</h1><p><a href="/">Go home</a></p>' }));
  });
  app.use((err, req, res, _next) => {
    console.error(err);
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server error' });
    res.status(500).send(page({ title: 'Error', user: req.user, body: '<h1>Something went wrong</h1>' }));
  });
  return app;
}
