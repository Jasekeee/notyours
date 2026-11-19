// Project state under .notyours/: config, identities, boundaries, runs. All paths are relative to a project root.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { BoundarySchema, ConfigSchema, IdentitySchema } from '../schemas.js';
import type { Boundary, Config, ConfigInput, Identity, KaneRun, ProbeResult } from '../types.js';
import { safeAppendFile, safeMkdir, safeWriteFile } from './safe-fs.js';

export const NY_DIR = '.notyours';

export function nyPaths(root: string) {
  const dir = path.join(root, NY_DIR);
  return {
    dir,
    config: path.join(dir, 'config.yaml'),
    /** Identities incl. passwords. Gitignored. Never print it; use redactIdentity(). */
    secrets: path.join(dir, 'secrets.json'),
    profiles: path.join(dir, 'profiles'),
    boundaries: path.join(dir, 'boundaries'),
    runs: path.join(dir, 'runs'),
    latest: path.join(dir, 'runs', 'latest.json'),
    creditsLog: path.join(dir, 'runs', 'credits.jsonl'),
    dirty: path.join(dir, 'runs', 'dirty.json'),
    map: path.join(dir, 'map.json'),
  };
}

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

// ---------- config ----------

export function readConfig(root: string): Config {
  const file = nyPaths(root).config;
  if (!fs.existsSync(file)) throw new UserError(`No ${NY_DIR}/config.yaml here. Run: notyours init --url http://localhost:3000`);
  const parsed = ConfigSchema.safeParse(YAML.parse(fs.readFileSync(file, 'utf8')) ?? {});
  if (!parsed.success) throw new UserError(`${NY_DIR}/config.yaml is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

export function readConfigIfExists(root: string): Config | undefined {
  return fs.existsSync(nyPaths(root).config) ? readConfig(root) : undefined;
}

export function writeConfig(root: string, cfg: ConfigInput): void {
  // Keep an existing `app:` block (app.start / app.port, read by the Stop hook): ConfigSchema doesn't know it.
  let app: unknown;
  try { app = (YAML.parse(fs.readFileSync(nyPaths(root).config, 'utf8')) as { app?: unknown } | null)?.app; } catch { /* new file */ }
  const body = YAML.stringify(app === undefined ? ConfigSchema.parse(cfg) : { ...ConfigSchema.parse(cfg), app });
  safeWriteFile(root, nyPaths(root).config, `# notyours config. allowHosts: only these hosts may be probed.\n${body}`);
}

// ---------- identities ----------

export function readIdentities(root: string): Identity[] {
  const file = nyPaths(root).secrets;
  if (!fs.existsSync(file)) throw new UserError(`No ${NY_DIR}/secrets.json (identities). Run: notyours init --url <url> --users users.yaml`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { identities?: unknown };
  const list = Array.isArray(raw.identities) ? raw.identities : [];
  return list.map((i, n) => {
    const r = IdentitySchema.safeParse(i);
    // Report the field, never the value: identities hold passwords.
    if (!r.success) throw new UserError(`${NY_DIR}/secrets.json identity #${n + 1} is invalid: ${r.error.issues.map((x) => x.path.join('.') || x.message).join(', ')}`);
    return r.data;
  });
}

export function writeIdentities(root: string, identities: Identity[]): void {
  safeWriteFile(root, nyPaths(root).secrets, `${JSON.stringify({ identities }, null, 2)}\n`, { mode: 0o600 });
}

// ---------- boundaries ----------

export interface LoadedBoundary {
  boundary: Boundary;
  file: string;
}

/** Real boundaries: .notyours/boundaries/*.yaml, excluding _draft_* files. */
export function readBoundaries(root: string): LoadedBoundary[] {
  const dir = nyPaths(root).boundaries;
  if (!fs.existsSync(dir)) return [];
  const out: LoadedBoundary[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(name) || name.startsWith('_draft_')) continue;
    const file = path.join(dir, name);
    const r = BoundarySchema.safeParse(YAML.parse(fs.readFileSync(file, 'utf8')));
    if (!r.success) throw new UserError(`${path.relative(root, file)} is invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    out.push({ boundary: r.data, file });
  }
  return out;
}

/** Pick boundaries by id; no ids means all. Unknown ids are an error (typos would silently skip a probe). */
export function selectBoundaries(all: LoadedBoundary[], ids: string[]): LoadedBoundary[] {
  if (ids.length === 0) return all;
  const known = new Set(all.map((b) => b.boundary.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new UserError(`Unknown boundary id(s): ${unknown.join(', ')}. Known: ${[...known].join(', ') || '(none)'}`);
  return all.filter((b) => ids.includes(b.boundary.id));
}

// ---------- runs ----------

export interface RunMeta {
  command: string;
  startedAt: string;
  finishedAt: string;
}

export function runStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Saves results to .notyours/runs/<stamp>/results.json, appends credits, points latest.json at it. */
export function saveRun(root: string, results: ProbeResult[], meta: RunMeta): string {
  const p = nyPaths(root);
  const dir = path.join(p.runs, runStamp(new Date(meta.finishedAt)));
  safeMkdir(root, dir);
  safeWriteFile(root, path.join(dir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  safeWriteFile(root, path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  safeWriteFile(root, p.latest, `${JSON.stringify({ dir: path.relative(p.runs, dir) })}\n`);
  logCredits(root, results);
  return dir;
}

/** One JSON line per Kane run with its credits_consumed (project rule: log every run's credits). */
export function logCredits(root: string, results: ProbeResult[]): void {
  const lines = results.flatMap((r) =>
    r.kaneRuns.map((k: KaneRun) =>
      JSON.stringify({ ts: r.ts, boundaryId: r.boundaryId, identity: k.identity, status: k.status, credits_consumed: k.creditsConsumed }),
    ),
  );
  if (lines.length) safeAppendFile(root, nyPaths(root).creditsLog, `${lines.join('\n')}\n`);
}

export interface SavedRun {
  dir: string;
  results: ProbeResult[];
  meta?: RunMeta;
}

export function readLatestRun(root: string): SavedRun | undefined {
  const p = nyPaths(root);
  if (!fs.existsSync(p.latest)) return undefined;
  const { dir } = JSON.parse(fs.readFileSync(p.latest, 'utf8')) as { dir: string };
  return readRun(path.join(p.runs, dir));
}

function readRun(dir: string): SavedRun | undefined {
  const resultsFile = path.join(dir, 'results.json');
  if (!fs.existsSync(resultsFile)) return undefined;
  const metaFile = path.join(dir, 'meta.json');
  return {
    dir,
    results: JSON.parse(fs.readFileSync(resultsFile, 'utf8')) as ProbeResult[],
    meta: fs.existsSync(metaFile) ? (JSON.parse(fs.readFileSync(metaFile, 'utf8')) as RunMeta) : undefined,
  };
}

/** Most recent result per boundary id, newest run first. */
export function latestResultsByBoundary(root: string): Map<string, ProbeResult> {
  const runsDir = nyPaths(root).runs;
  const out = new Map<string, ProbeResult>();
  if (!fs.existsSync(runsDir)) return out;
  const dirs = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const d of dirs) {
    for (const r of readRun(path.join(runsDir, d))?.results ?? []) if (!out.has(r.boundaryId)) out.set(r.boundaryId, r);
  }
  return out;
}

// ---------- dirty set (written by the post-tool hook, drained by the stop hook) ----------

export function readDirty(root: string): string[] {
  const f = nyPaths(root).dirty;
  if (!fs.existsSync(f)) return [];
  try {
    const v = JSON.parse(fs.readFileSync(f, 'utf8')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeDirty(root: string, ids: string[]): void {
  safeWriteFile(root, nyPaths(root).dirty, `${JSON.stringify([...new Set(ids)].sort())}\n`);
}
