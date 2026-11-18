#!/usr/bin/env node
// Jotter demo server.
//   node demo/server.js          start (seeds automatically if the database is empty)
//   node demo/server.js --seed   reset the database to the fixed seed, then start
//   node demo/server.js --seed-only   reset and exit
// Options: --port <n> (default 3077, or $PORT), --db <file> (default demo/data/jotter.sqlite)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { DEFAULT_TOKENS, SEED, identityFiles, loadTokens, seed } from './seed.js';

const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1'; // deliberately vulnerable app: never listen on a public interface

const { values } = parseArgs({
  options: {
    seed: { type: 'boolean', default: false },
    'seed-only': { type: 'boolean', default: false },
    port: { type: 'string' },
    db: { type: 'string' },
  },
});

const port = Number(values.port ?? process.env.PORT ?? 3077);
const dbFile = path.resolve(values.db ?? path.join(DEMO_DIR, 'data', 'jotter.sqlite'));
const db = await openDb({ file: dbFile });

if (values.seed || values['seed-only'] || db.isEmpty()) {
  const tokens = loadTokens();
  const custom = tokens.alice !== DEFAULT_TOKENS.alice || tokens.bob !== DEFAULT_TOKENS.bob;
  const source = custom ? identityFiles().find((f) => fs.existsSync(f)) : 'built-in defaults';
  seed(db, { tokens });
  console.log(`jotter: seeded ${dbFile}`);
  console.log(`  ${SEED.alice.email} (pro)  note ${SEED.alice.noteId}`);
  console.log(`  ${SEED.bob.email} (free) note ${SEED.bob.noteId}`);
  console.log(`  canary tokens from ${source}`);
}

if (values['seed-only']) {
  db.close();
} else {
  createApp(db).listen(port, HOST, () => console.log(`jotter: http://${HOST}:${port}`));
}
