// Catch every edit: PostToolUse only fires for Edit/Write/MultiEdit, so changes made through Bash (sed -i,
// python scripts, codegen) would never mark a boundary dirty. Each Stop pass therefore also compares the files
// under every boundary's surface globs with a snapshot taken at the previous pass (or at install-hooks).
//   git repo: candidates from `git ls-files -co --exclude-standard`; with no snapshot yet, `git status` changes count
//   otherwise:  a filesystem walk (node_modules, .git, .notyours, .testmuai, dist, data skipped)
// A file's fingerprint is mtime + size: cheap, and any write changes it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Boundary } from '../types.js';
import { notyoursPaths, type NotyoursPaths } from '../ratchet/paths.js';
import { readDirty, writeDirty, type DirtyState } from '../ratchet/store.js';
import { matchesGlob } from './glob.js';

interface Snapshot {
  mode: 'git' | 'mtime';
  files: Record<string, string>;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.notyours', '.testmuai', 'dist', 'data', '.claude']);
const MAX_FILES = 50_000;

const snapshotFile = (p: NotyoursPaths) => path.join(p.dir, 'surface-snapshot.json');

function isGit(dir: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function gitLines(dir: string, args: string[]): string[] {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    if (out.length >= MAX_FILES) return;
    let entries;
    try { entries = readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) visit(r); }
      else if (e.isFile()) out.push(r);
    }
  };
  visit('');
  return out;
}

function fingerprint(abs: string): string | undefined {
  try {
    const s = statSync(abs);
    return `${Math.floor(s.mtimeMs)}:${s.size}`;
  } catch {
    return undefined;
  }
}

const surfaceGlobs = (bs: Boundary[]) => [...new Set(bs.flatMap((b) => b.surface))];

/** The current fingerprints of every file under any boundary's surface. */
export function surfaceFingerprints(appDir: string, boundaries: Boundary[]): Snapshot {
  const globs = surfaceGlobs(boundaries);
  const git = isGit(appDir);
  const candidates = git ? gitLines(appDir, ['ls-files', '-co', '--exclude-standard']) : walk(appDir);
  const files: Record<string, string> = {};
  for (const rel of candidates) {
    const posix = rel.split(path.sep).join('/');
    if (!globs.some((g) => matchesGlob(posix, g))) continue;
    const fp = fingerprint(path.join(appDir, rel));
    if (fp) files[posix] = fp;
  }
  return { mode: git ? 'git' : 'mtime', files };
}

function readSnapshot(p: NotyoursPaths): Snapshot | undefined {
  try {
    const v = JSON.parse(readFileSync(snapshotFile(p), 'utf8')) as Snapshot;
    return v && typeof v.files === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeSnapshot(p: NotyoursPaths, s: Snapshot): void {
  mkdirSync(p.dir, { recursive: true });
  const tmp = `${snapshotFile(p)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s)}\n`);
  renameSync(tmp, snapshotFile(p));
}

/** Record the current surface state as the baseline (install-hooks, and the end of each scan). */
export function writeSurfaceBaseline(appDir: string, boundaries: Boundary[]): void {
  writeSnapshot(notyoursPaths(appDir), surfaceFingerprints(appDir, boundaries));
}

/**
 * Files under any surface that changed since the last pass (added, modified or deleted). With no snapshot yet:
 * in a git repo the uncommitted surface changes (`git status`); otherwise nothing (this pass is the baseline).
 */
export function changedSurfaceFiles(appDir: string, boundaries: Boundary[], current = surfaceFingerprints(appDir, boundaries)): string[] {
  const prev = readSnapshot(notyoursPaths(appDir));
  const globs = surfaceGlobs(boundaries);
  if (!prev) {
    if (current.mode !== 'git') return [];
    // git status, as paths relative to the app folder: modified/staged/deleted vs HEAD, plus untracked files.
    const tracked = gitLines(appDir, ['diff', '--relative', '--name-only', 'HEAD', '--', '.']);
    const untracked = gitLines(appDir, ['ls-files', '--others', '--exclude-standard']);
    return [...new Set([...tracked, ...untracked])].filter((f) => globs.some((g) => matchesGlob(f, g))).sort();
  }
  const changed = new Set<string>();
  for (const [f, fp] of Object.entries(current.files)) if (prev.files[f] !== fp) changed.add(f);
  for (const f of Object.keys(prev.files)) if (!(f in current.files)) changed.add(f); // deleted
  return [...changed].sort();
}

/**
 * The Stop pass entry point: mark boundaries whose surface has changed files as dirty (merged into dirty.json with
 * file + glob evidence), then store the new snapshot. Returns the boundary ids it marked.
 */
export function markSurfaceChanges(appDir: string, boundaries: Boundary[], now = new Date()): string[] {
  const p = notyoursPaths(appDir);
  if (!existsSync(p.dir)) return [];
  const current = surfaceFingerprints(appDir, boundaries);
  const changed = changedSurfaceFiles(appDir, boundaries, current);
  writeSnapshot(p, current);
  if (!changed.length) return [];
  const dirty: DirtyState = readDirty(p);
  const marked: string[] = [];
  for (const b of boundaries) {
    const files = changed.filter((f) => b.surface.some((g) => matchesGlob(f, g)));
    if (!files.length) continue;
    const globs = b.surface.filter((g) => files.some((f) => matchesGlob(f, g)));
    const prev = dirty[b.id];
    dirty[b.id] = {
      files: [...new Set([...(prev?.files ?? []), ...files])],
      globs: [...new Set([...(prev?.globs ?? []), ...globs])],
      ts: now.toISOString(),
    };
    marked.push(b.id);
  }
  if (marked.length) writeDirty(p, dirty);
  return marked;
}
