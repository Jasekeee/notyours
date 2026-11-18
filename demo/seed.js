// Fixed seed so cached Kane replays always hit the same URLs (note 1001 = Alice, 1002 = Bob).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './db.js';

const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Used when .notyours/identities.json is missing. Same shape as notyours canary tokens. */
export const DEFAULT_TOKENS = Object.freeze({
  alice: 'NY-ALICE-JOTTERSEED2A',
  bob: 'NY-BOB-JOTTERSEED2B',
});

// Dev-only defaults for a local demo app. Override with JOTTER_ALICE_PW / JOTTER_BOB_PW.
export const DEFAULT_PASSWORDS = Object.freeze({
  alice: 'alice-jotter-dev', // notyours:allow-secret (local demo default)
  bob: 'bob-jotter-dev', // notyours:allow-secret (local demo default)
});

export const SEED = Object.freeze({
  alice: { id: 1, email: 'alice@jotter.test', name: 'Alice', plan: 'pro', noteId: 1001 },
  bob: { id: 2, email: 'bob@jotter.test', name: 'Bob', plan: 'free', noteId: 1002 },
});

const tokenRe = (id) => new RegExp(`^NY-${id.toUpperCase()}-[A-Z2-7]{12}$`);

/** Candidate identities.json files: $NOTYOURS_DIR, then demo/.notyours, then ./.notyours. */
export function identityFiles() {
  const dirs = [process.env.NOTYOURS_DIR, path.join(DEMO_DIR, '.notyours'), path.join(process.cwd(), '.notyours')];
  return [...new Set(dirs.filter(Boolean).map((d) => path.resolve(d, 'identities.json')))];
}

/**
 * Canary tokens for alice and bob. Reads the first identities.json that exists
 * (an Identity[] array or an object keyed by id); falls back per id to DEFAULT_TOKENS.
 * Only the token is read; passwords never come from this file.
 */
export function loadTokens(files = identityFiles()) {
  const tokens = { ...DEFAULT_TOKENS };
  const file = files.find((f) => fs.existsSync(f));
  if (!file) return tokens;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.warn(`jotter: ignoring unreadable ${file}; using default tokens`);
    return tokens;
  }
  const list = Array.isArray(parsed) ? parsed : Object.entries(parsed ?? {}).map(([id, v]) => ({ id, ...v }));
  for (const who of ['alice', 'bob']) {
    const token = list.find((i) => i?.id === who)?.token;
    if (typeof token === 'string' && tokenRe(who).test(token)) tokens[who] = token;
  }
  return tokens;
}

export function loadPasswords(env = process.env) {
  return {
    alice: env.JOTTER_ALICE_PW || DEFAULT_PASSWORDS.alice,
    bob: env.JOTTER_BOB_PW || DEFAULT_PASSWORDS.bob,
  };
}

/** Wipe the database and insert the fixed demo data. */
export function seed(db, { tokens = loadTokens(), passwords = loadPasswords() } = {}) {
  db.reset();
  const { alice, bob } = SEED;
  const users = [
    [alice, passwords.alice, 'Product designer. Pro member since 2025.'],
    [bob, passwords.bob, `Hi, I'm Bob. Private ref: ${tokens.bob}`],
  ];
  for (const [u, pw, bio] of users) {
    db.run('INSERT INTO users (id, email, name, pw_hash, plan, bio) VALUES (?, ?, ?, ?, ?, ?)', [
      u.id, u.email, u.name, hashPassword(pw), u.plan, bio,
    ]);
  }
  const notes = [
    [alice.noteId, alice.id, 'Travel documents', `Passport no. ${tokens.alice}`, '2026-11-02T09:14:00.000Z'],
    [bob.noteId, bob.id, 'Reminder', tokens.bob, '2026-11-03T18:40:00.000Z'],
  ];
  for (const n of notes) {
    db.run('INSERT INTO notes (id, owner_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)', n);
  }
  return { tokens };
}
