// PostToolUse (Edit|Write|MultiEdit): mark boundaries whose code surface was just edited as dirty.
// Must be fast (<300ms) and must never block the agent: every path exits 0. No Kane here.
import { notyoursPaths } from '../ratchet/paths.js';
import { loadBoundaries, loadMap, readDirty, writeDirty } from '../ratchet/store.js';
import { appsForFile, rememberApp } from './appdir.js';
import { matchesGlob } from './glob.js';
import { ok, projectDirOf, type HookInput, type HookResult } from './types.js';

/** Boundary id -> globs that matched relPath, from boundary surfaces and .notyours/map.json. */
export function matchBoundaries(relPath: string, surfaces: Record<string, string[]>): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  for (const [id, globs] of Object.entries(surfaces)) {
    const matched = globs.filter((g) => matchesGlob(relPath, g));
    if (matched.length) hits[id] = [...new Set(matched)];
  }
  return hits;
}

/** Marks dirty in one app folder; returns true when anything matched. */
function markApp(appDir: string, rel: string, ts: string): boolean {
  if (!rel || rel.startsWith('..') || rel === '.notyours' || rel.startsWith('.notyours/')) return false;
  const p = notyoursPaths(appDir);
  const surfaces: Record<string, string[]> = {};
  for (const { boundary } of loadBoundaries(p)) surfaces[boundary.id] = [...boundary.surface];
  for (const [id, globs] of Object.entries(loadMap(p))) {
    if (id in surfaces) surfaces[id] = [...(surfaces[id] ?? []), ...globs];
  }
  const hits = matchBoundaries(rel, surfaces);
  if (!Object.keys(hits).length) return false;

  const dirty = readDirty(p);
  for (const [id, globs] of Object.entries(hits)) {
    const prev = dirty[id];
    dirty[id] = {
      files: [...new Set([...(prev?.files ?? []), rel])],
      globs: [...new Set([...(prev?.globs ?? []), ...globs])],
      ts,
    };
  }
  writeDirty(p, dirty);
  return true;
}

export function postToolHook(input: HookInput, env: NodeJS.ProcessEnv = process.env, now = () => new Date()): HookResult {
  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) return ok();
  const projectDir = projectDirOf(input, env);
  const ts = now().toISOString();
  // Surface globs are relative to each app folder (one holding .notyours/), which may be a subfolder. Check every
  // enclosing app, for both the path as written and its symlink-resolved location.
  for (const { appDir, rel } of appsForFile(filePath, projectDir)) {
    try {
      if (markApp(appDir, rel, ts)) rememberApp(projectDir, appDir);
    } catch {
      // A broken boundary file must not interrupt the agent's edit; the Stop hook reports config problems.
    }
  }
  return ok();
}
