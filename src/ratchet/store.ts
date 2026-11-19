// Reads and writes the .notyours/ state the ratchet and hooks share. Hooks import this, so keep it light.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { BoundarySchema, ConfigSchema, IdentitySchema } from '../schemas.js';
import type { Boundary, Config, Identity } from '../types.js';
import type { NotyoursPaths } from './paths.js';

/** dirty.json: boundary id -> the edited files and the globs they matched. */
export interface DirtyEntry {
  files: string[];
  globs: string[];
  ts: string;
}
export type DirtyState = Record<string, DirtyEntry>;
/** attempts.json: boundary id -> consecutive RED replays the agent has had to fix it. */
export type AttemptsState = Record<string, number>;

/** A boundary plus the file it came from, so lock() can write `locked: true` back to it. */
export interface StoredBoundary {
  boundary: Boundary;
  file: string;
  /** Index inside a list file; undefined when the file holds a single boundary. */
  index?: number;
  /** Key path of the list inside the document: [] for a top-level list, ['boundaries'] otherwise. */
  listPath?: string[];
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write via temp file + rename so a concurrent reader never sees half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function readDirty(p: NotyoursPaths): DirtyState {
  const v = readJson<unknown>(p.dirty, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as DirtyState) : {};
}

export function writeDirty(p: NotyoursPaths, d: DirtyState): void {
  writeJsonAtomic(p.dirty, d);
}

export function readAttempts(p: NotyoursPaths): AttemptsState {
  const v = readJson<unknown>(p.attempts, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AttemptsState) : {};
}

export function writeAttempts(p: NotyoursPaths, a: AttemptsState): void {
  writeJsonAtomic(p.attempts, a);
}

/** Escalations: id -> when and why (ids: the boundaries behind a non-boundary key such as a stale app). */
export type EscalatedState = Record<string, { ts: string; reason: string; ids?: string[] }>;

export function readEscalated(p: NotyoursPaths): EscalatedState {
  const v = readJson<unknown>(p.escalated, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as EscalatedState) : {};
}

export function writeEscalated(p: NotyoursPaths, e: EscalatedState): void {
  if (!Object.keys(e).length && !existsSync(p.escalated)) return;
  writeJsonAtomic(p.escalated, e);
}

export function loadConfig(p: NotyoursPaths): Config {
  return ConfigSchema.parse(YAML.parse(readFileSync(p.config, 'utf8')));
}

/** Like loadConfig, but falls back to defaults (maxAttempts 3) when the file is missing or invalid. */
export function loadConfigOr(p: NotyoursPaths, fallbackBaseUrl = 'http://127.0.0.1:3000'): Config {
  try {
    return loadConfig(p);
  } catch {
    return ConfigSchema.parse({ baseUrl: fallbackBaseUrl });
  }
}

function boundaryFiles(p: NotyoursPaths): string[] {
  const files: string[] = [];
  if (existsSync(p.boundariesFile)) files.push(p.boundariesFile);
  if (existsSync(p.boundariesDir)) {
    for (const f of readdirSync(p.boundariesDir).sort()) {
      if (/\.(ya?ml|json)$/.test(f)) files.push(path.join(p.boundariesDir, f));
    }
  }
  return files;
}

/**
 * All boundaries from .notyours/boundaries.yaml and .notyours/boundaries/*.{yaml,yml,json}.
 * A file may hold one boundary, a list, or `{ boundaries: [...] }`. Invalid entries throw: a typo in a
 * boundary must not silently drop it from the ratchet.
 */
export function loadBoundaries(p: NotyoursPaths): StoredBoundary[] {
  const out: StoredBoundary[] = [];
  for (const file of boundaryFiles(p)) {
    const doc: unknown = YAML.parse(readFileSync(file, 'utf8'));
    if (doc == null) continue;
    const rel = path.relative(p.root, file);
    const parse = (raw: unknown, where: string) => {
      const r = BoundarySchema.safeParse(raw);
      if (!r.success) throw new Error(`notyours: invalid boundary in ${where}: ${r.error.issues[0]?.message ?? 'schema error'}`);
      return r.data;
    };
    if (Array.isArray(doc)) {
      doc.forEach((raw, index) => out.push({ boundary: parse(raw, `${rel}[${index}]`), file, index, listPath: [] }));
    } else if (typeof doc === 'object' && Array.isArray((doc as { boundaries?: unknown }).boundaries)) {
      (doc as { boundaries: unknown[] }).boundaries.forEach((raw, index) =>
        out.push({ boundary: parse(raw, `${rel}.boundaries[${index}]`), file, index, listPath: ['boundaries'] }),
      );
    } else {
      out.push({ boundary: parse(doc, rel), file });
    }
  }
  return out;
}

/** Sets `locked: true` on the boundary in its source file, keeping comments and formatting where possible. */
export function markLocked(s: StoredBoundary, locked = true): void {
  const text = readFileSync(s.file, 'utf8');
  if (s.file.endsWith('.json')) {
    const doc: unknown = JSON.parse(text);
    const target = s.index === undefined ? doc : getIn(doc, [...(s.listPath ?? []), s.index]);
    (target as Record<string, unknown>).locked = locked;
    writeFileSync(s.file, `${JSON.stringify(doc, null, 2)}\n`);
  } else {
    const doc = YAML.parseDocument(text);
    const keyPath = s.index === undefined ? ['locked'] : [...(s.listPath ?? []), s.index, 'locked'];
    doc.setIn(keyPath, locked);
    writeFileSync(s.file, doc.toString());
  }
  s.boundary = { ...s.boundary, locked };
}

function getIn(v: unknown, keys: (string | number)[]): unknown {
  return keys.reduce<unknown>((acc, k) => (acc as Record<string | number, unknown>)[k], v);
}

/**
 * Identities from .notyours/secrets.json: `{ identities: [...] }`, a list, or `{ <id>: {...} }`.
 * Holds passwords: never print what this returns without redactIdentity().
 */
export function loadIdentities(p: NotyoursPaths): Identity[] {
  // identities.json (tokens, ports; committed by the demo) merged with secrets.json (passwords; gitignored).
  const byId = new Map<string, Record<string, unknown>>();
  for (const file of [p.identities, p.secrets]) {
    for (const i of identityList(readJson<unknown>(file, null))) {
      if (i && typeof i === 'object' && typeof (i as { id?: unknown }).id === 'string') {
        const id = (i as { id: string }).id;
        byId.set(id, { ...(byId.get(id) ?? {}), ...(i as Record<string, unknown>) });
      }
    }
  }
  // Errors name the field only; zod messages never echo a password value.
  return [...byId.entries()].map(([id, i]) => {
    const r = IdentitySchema.safeParse(i);
    if (!r.success) throw new Error(`notyours: invalid identity ${id} in .notyours/identities.json/secrets.json: ${r.error.issues[0]?.path.join('.')}`);
    return r.data;
  });
}

function identityList(raw: unknown): unknown[] {
  if (raw == null || typeof raw !== 'object') return [];
  if (Array.isArray(raw)) return raw;
  const ids = (raw as { identities?: unknown }).identities;
  if (Array.isArray(ids)) return ids;
  return Object.entries(raw as Record<string, unknown>).map(([id, v]) => ({ id, ...(v as object) }));
}

/**
 * .notyours/map.json, normalised to boundary id -> code globs/paths. Accepted shapes:
 * `{ <id>: string[] }`, `{ <id>: { files?, surface?, globs? } }`, and either of those under `boundaries`.
 */
export function loadMap(p: NotyoursPaths): Record<string, string[]> {
  const raw = readJson<unknown>(p.map, null);
  if (!raw || typeof raw !== 'object') return {};
  const top = raw as Record<string, unknown>;
  const src =
    top.boundaries && typeof top.boundaries === 'object' && !Array.isArray(top.boundaries)
      ? (top.boundaries as Record<string, unknown>)
      : top;
  const out: Record<string, string[]> = {};
  for (const [id, v] of Object.entries(src)) {
    const globs: unknown[] = Array.isArray(v)
      ? v
      : v && typeof v === 'object'
        ? ['files', 'surface', 'globs'].flatMap((k) => {
            const x = (v as Record<string, unknown>)[k];
            return Array.isArray(x) ? x : [];
          })
        : [];
    const strings = globs.filter((g): g is string => typeof g === 'string' && g.length > 0);
    if (strings.length) out[id] = strings;
  }
  return out;
}

export interface CreditLogEntry {
  ts: string;
  kind: 'author' | 'replay';
  name: string;
  identity: string;
  status: string;
  credits: number;
  /** Replays should never author; >0 means kane-cli re-authored a step (and may have spent credits). */
  authorDecisions?: number;
}

export function logCredits(p: NotyoursPaths, e: CreditLogEntry): void {
  mkdirSync(path.dirname(p.creditsLog), { recursive: true });
  writeFileSync(p.creditsLog, `${JSON.stringify(e)}\n`, { flag: 'a' });
}

export function readCreditLog(p: NotyoursPaths): CreditLogEntry[] {
  try {
    return readFileSync(p.creditsLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CreditLogEntry);
  } catch {
    return [];
  }
}
