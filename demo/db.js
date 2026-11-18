// Jotter data layer: sql.js (SQLite compiled to WASM, no native modules).
// The whole database lives in memory and is written to `file` after every change.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import initSqlJs from 'sql.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id       INTEGER PRIMARY KEY,
  email    TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  pw_hash  TEXT NOT NULL,
  plan     TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  bio      TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
`;

let sqlPromise;

/**
 * Open (or create) the Jotter database.
 * @param {{ file?: string }} [opts] Without `file` the database is memory-only (tests).
 */
export async function openDb(opts = {}) {
  sqlPromise ??= initSqlJs();
  const SQL = await sqlPromise;
  const file = opts.file;
  const raw = file && fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  const db = new SQL.Database(raw);
  db.exec(SCHEMA);

  /** @param {string} sql @param {unknown[]} [params] */
  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, db.export());
  }

  return {
    all,
    /** First row or undefined. */
    get: (sql, params = []) => all(sql, params)[0],
    /** Statement that changes data; persisted immediately. Returns RETURNING rows, if any. */
    run(sql, params = []) {
      const rows = all(sql, params);
      save();
      return rows;
    },
    /** Drop everything (used by --seed). */
    reset() {
      db.exec('DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS users;');
      db.exec(SCHEMA);
      save();
    },
    isEmpty: () => (all('SELECT COUNT(*) AS n FROM users')[0]?.n ?? 0) === 0,
    close: () => db.close(),
  };
}

/** scrypt password hash, stored as scrypt$<salt hex>$<hash hex>. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
