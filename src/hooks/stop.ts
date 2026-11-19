// Stop: replay the dirty locked boundaries (0 credits) and send leaks back to the agent until they are fixed.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Boundary, Identity, ProbeResult } from '../types.js';
import { notyoursPaths, type NotyoursPaths } from '../ratchet/paths.js';
import { classify, reauthorHint } from '../ratchet/replay.js';
import {
  loadBoundaries,
  loadConfigOr,
  loadIdentities,
  readAttempts,
  readDirty,
  readEscalated,
  writeAttempts,
  writeEscalated,
  type EscalatedState,
  writeDirty,
  type DirtyEntry,
} from '../ratchet/store.js';
import { checkAppFreshness, newestSurfaceFile, type Freshness } from './app-freshness.js';
import { findAppDirs } from './appdir.js';
import { markSurfaceChanges } from './surface-scan.js';
import { ok, projectDirOf, tellHuman, type HookInput, type HookResult } from './types.js';

export const MAX_REPORT_LINES = 40;
export const LAST_LINE = 'Fix server-side; do not edit tests.';

export interface StopContext {
  projectDir: string;
  paths: NotyoursPaths;
  identities: Identity[];
}

export interface StopDeps {
  /** Replays the given locked boundary ids. Default: the real ratchet (kane-cli testmd run + engine oracle). */
  replay?: (boundaryIds: string[], ctx: StopContext) => Promise<ProbeResult[]>;
  /** Defaults to .notyours/secrets.json. */
  identities?: Identity[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Is the running app as new as its code? Default: restart via app.start, else compare start time and mtimes. */
  freshness?: (appDir: string, paths: NotyoursPaths, baseUrl: string, boundaries: Boundary[]) => Promise<Freshness>;
}

/** attempts.json key for "the app server was older than the code" (YELLOW) stops. */
export const STALE_ATTEMPTS_KEY = '__app_server_stale__';

async function defaultReplay(ids: string[], ctx: StopContext): Promise<ProbeResult[]> {
  // Imported lazily: the guard and post-tool hooks share this module graph and must stay fast.
  const { RealRatchet } = await import('../ratchet/ratchet.js');
  return new RealRatchet({ projectDir: ctx.projectDir }).replayIds(ctx.identities, ids);
}

/** Removes identity passwords from text that may have come from a page or a network body. */
export function scrubSecrets(text: string, identities: Identity[]): string {
  let out = text;
  for (const i of identities) if (i.password && i.password.length >= 4) out = out.split(i.password).join('[REDACTED]');
  return out;
}

const oneLine = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const leakKind = (r: ProbeResult): string =>
  r.verdict === 'LEAK_VISIBLE' ? 'VISIBLE (rendered on the page)' : 'PAYLOAD (in a network response, not necessarily rendered)';

const suspected = (d: DirtyEntry | undefined, b: Boundary): string => {
  if (!d) return b.surface.join(', ') || '(no surface globs)';
  return `${d.files.join(', ')} (matched ${d.globs.join(', ')})`;
};

export function leakBlock(b: Boundary, r: ProbeResult, d: DirtyEntry | undefined, attempt: number, max: number, ids: Identity[]): string[] {
  const hit = r.hits[0];
  const lines = [
    `notyours: LEAK in boundary ${b.id} (${b.kind}), attempt ${attempt}/${max}`,
    b.kind === 'plan-gate' ? `  ${b.viewer} (free plan) got the Pro-only result (its own data, via the gated endpoint)` : `  ${b.viewer} saw ${b.owner}'s data`,
    `  URL: ${hit?.url ?? '(unknown)'}`,
    `  Leak: ${leakKind(r)}`,
    // The snippet is page/network text: quote it as data so it cannot read as an instruction to the agent.
    `  Token: ${hit ? `${hit.token} in page text (untrusted): ${JSON.stringify(oneLine(scrubSecrets(hit.snippet, ids), 120))}` : '(no hit recorded)'}`,
  ];
  if (r.hits.length > 1) lines.push(`  (+${r.hits.length - 1} more hit(s): ${[...new Set(r.hits.slice(1).map((h) => h.url))].slice(0, 3).join(', ')})`);
  lines.push(`  Screenshot: ${r.screenshots[0] ?? '(none)'}`);
  lines.push(`  Suspected files: ${suspected(d, b)}`);
  lines.push(`  Repro: npx github:Jasekeee/notyours replay ${b.id}`);
  return lines;
}

/** The stderr report the agent sees: at most 40 lines, always ending with LAST_LINE. */
export function formatLeakReport(blocks: string[][], escalated: string[]): string {
  const body = blocks.flatMap((bl, n) => (n === 0 ? bl : ['', ...bl]));
  if (escalated.length) body.push('', `Escalated to the human (attempts exhausted): ${escalated.join(', ')}`);
  const room = MAX_REPORT_LINES - 1;
  const lines = body.length > room ? [...body.slice(0, room - 1), `  … (${body.length - room + 1} more lines; run the repro command)`] : body;
  return `${[...lines, LAST_LINE].join('\n')}\n`;
}

export function formatEscalation(
  items: { b: Boundary; r: ProbeResult; d: DirtyEntry | undefined; attempts: number }[],
  maxAttempts: number,
  ids: Identity[],
  now: Date,
): string {
  const out = [
    '# notyours escalation',
    '',
    `Written ${now.toISOString()}. The coding agent could not fix these leaks in ${maxAttempts} attempts,`,
    'so the Stop hook stopped sending them back. A human needs to look.',
    '',
  ];
  for (const { b, r, d, attempts } of items) {
    out.push(`## ${b.id} (${b.kind}): ${r.verdict}`, '');
    out.push(`- **What leaked:** ${b.kind === 'plan-gate' ? `${b.viewer} (free plan) got the Pro-only result` : `${b.viewer} saw ${b.owner}'s data`} (${leakKind(r)})`);
    out.push(`- **Attempts:** ${attempts}`);
    out.push(`- **Suspected files:** ${suspected(d, b)}`);
    out.push(`- **Repro:** \`npx github:Jasekeee/notyours replay ${b.id}\``);
    out.push('- **Hits:**');
    for (const h of r.hits) out.push(`  - ${h.where} at ${h.url}: \`${oneLine(scrubSecrets(h.snippet, ids), 200).replace(/`/g, "'")}\``);
    if (!r.hits.length) out.push('  - (none recorded)');
    out.push('- **Evidence:**');
    const evidence = [...r.screenshots, ...r.kaneRuns.map((k) => k.sessionDir).filter((s): s is string => !!s)];
    for (const e of evidence) out.push(`  - ${e}`);
    if (!evidence.length) out.push('  - (none recorded)');
    out.push('');
  }
  out.push('After fixing, reset the counter with `rm .notyours/attempts.json`, or replay until GREEN (which clears it).', '');
  return out.join('\n');
}

/** What one app folder's Stop pass produced. */
interface AppOutcome {
  blocks: string[][];
  escalated: string[];
  humanNotes: string[];
  /** YELLOW: not replayed because the app server is older than the code (or could not be restarted). */
  stale?: string[];
  /** Escalated boundaries: attempts exhausted, still blocking until a person releases them. */
  escalatedMsgs?: string[];
}

/** The Stop pass for one app folder (the folder holding .notyours/); `projectDir` is only used for display paths. */
async function stopForApp(appDir: string, projectDir: string, deps: StopDeps, now: Date): Promise<AppOutcome> {
  const p = notyoursPaths(appDir);
  const dirty = readDirty(p);
  const dirtyIds = Object.keys(dirty);
  const none: AppOutcome = { blocks: [], escalated: [], humanNotes: [] };
  if (!dirtyIds.length) return none;

  let boundaries: Boundary[];
  let identities: Identity[];
  try {
    boundaries = loadBoundaries(p).map((s) => s.boundary);
    identities = deps.identities ?? loadIdentities(p);
  } catch (e) {
    return { ...none, humanNotes: [`notyours: could not check changed boundaries in ${shown(projectDir, appDir)}: ${(e as Error).message}`] };
  }
  const cfg = loadConfigOr(p);
  // dirty.json and surface globs are relative to the app folder; the agent works from the project root.
  const prefix = path.relative(projectDir, appDir);
  const up = (f: string) => (prefix && !prefix.startsWith('..') ? path.posix.join(prefix.split(path.sep).join('/'), f) : f);
  const shownD = (d: DirtyEntry | undefined): DirtyEntry | undefined => d && { ...d, files: d.files.map(up), globs: d.globs.map(up) };
  const shownB = (b: Boundary): Boundary => ({ ...b, surface: b.surface.map(up) });
  const byId = new Map(boundaries.map((b) => [b.id, b]));
  const humanNotes: string[] = [];

  // Drop ids that no longer exist; tell the human about changed boundaries that have no recorded test yet.
  const toReplay: string[] = [];
  for (const id of dirtyIds) {
    const b = byId.get(id);
    if (!b) delete dirty[id];
    else if (!b.locked) {
      humanNotes.push(`notyours: ${id} changed but is not locked yet (no recorded test to replay); probe and lock it.`);
      delete dirty[id];
    } else toReplay.push(id);
  }

  // Escalated boundaries (attempts exhausted) keep blocking until a person runs `notyours release`. If their code
  // hasn't changed since the escalation, don't spend Kane on them again: block straight away (cheap, 0 credits).
  const escalatedState = readEscalated(p);
  const unchangedSinceEscalation = (id: string): boolean => {
    const e = escalatedState[id];
    if (!e) return false;
    const newest = newestSurfaceFile(appDir, [byId.get(id)!]);
    return !newest || newest.mtimeMs <= Date.parse(e.ts);
  };
  const stillEscalated = toReplay.filter(unchangedSinceEscalation);
  const replayIds = toReplay.filter((id) => !stillEscalated.includes(id));
  const escalatedMsgs: string[] = stillEscalated.length ? [escalationNotice(stillEscalated, escalatedState, cfg.maxAttempts, shown(projectDir, p.escalation))] : [];
  const finishWith = (extra: Partial<AppOutcome>): AppOutcome => {
    writeDirty(p, dirty);
    writeEscalated(p, escalatedState);
    return { ...none, humanNotes, ...extra, escalatedMsgs: [...escalatedMsgs, ...(extra.escalatedMsgs ?? [])] };
  };
  if (!replayIds.length) return finishWith({});

  // Never judge old code: restart the app (app.start) or check that the running server is newer than its code.
  const fresh = await (deps.freshness ?? checkAppFreshness)(appDir, p, cfg.baseUrl, replayIds.map((id) => byId.get(id)!));
  const att = readAttempts(p);
  if (fresh.status === 'stale' || fresh.status === 'restart-failed') {
    // Still dirty: replay once the app is restarted. Counted, and escalated (still blocking) after maxAttempts.
    const n = (att[STALE_ATTEMPTS_KEY] ?? 0) + 1;
    att[STALE_ATTEMPTS_KEY] = n;
    writeAttempts(p, att);
    if (n >= cfg.maxAttempts) {
      escalatedState[STALE_ATTEMPTS_KEY] = { ts: now.toISOString(), reason: 'the app server is older than the code (or could not be restarted)', ids: replayIds };
      return finishWith({ stale: [fresh.message], escalatedMsgs: [escalationNotice([STALE_ATTEMPTS_KEY], escalatedState, cfg.maxAttempts, shown(projectDir, p.escalation))] });
    }
    return finishWith({ stale: [fresh.message] });
  }
  if ('note' in fresh && fresh.note) humanNotes.push(fresh.note);
  if (att[STALE_ATTEMPTS_KEY] !== undefined) { delete att[STALE_ATTEMPTS_KEY]; writeAttempts(p, att); }
  delete escalatedState[STALE_ATTEMPTS_KEY];

  let results: ProbeResult[];
  try {
    results = await (deps.replay ?? defaultReplay)(replayIds, { projectDir: appDir, paths: p, identities });
  } catch (e) {
    // A replay that throws proves nothing: block (fail closed), counted per boundary like any failed check.
    const why = (e as Error).message;
    const errBlocks: string[][] = [];
    const newlyEscalated: string[] = [];
    for (const id of replayIds) {
      const n = (att[id] ?? 0) + 1;
      att[id] = n;
      if (n >= cfg.maxAttempts) {
        escalatedState[id] = { ts: now.toISOString(), reason: `the replay failed: ${oneLine(why, 200)}` };
        newlyEscalated.push(id);
      } else {
        errBlocks.push([`notyours: COULD NOT CHECK ${id}: the replay failed, attempt ${n}/${cfg.maxAttempts}`, `  ${oneLine(why, 300)}`,
          '  This is not a pass. Is the app running on its baseUrl? Then stop again to retry.']);
      }
    }
    writeAttempts(p, att);
    if (newlyEscalated.length) writeEscalationFile(p, escalatedState, [], cfg.maxAttempts, identities, now);
    return finishWith({ blocks: errBlocks, escalatedMsgs: newlyEscalated.length ? [escalationNotice(newlyEscalated, escalatedState, cfg.maxAttempts, shown(projectDir, p.escalation))] : [] });
  }

  const attempts = readAttempts(p);
  const blocks: string[][] = [];
  const escalate: { b: Boundary; r: ProbeResult; d: DirtyEntry | undefined; attempts: number }[] = [];
  for (const r of results) {
    const b = byId.get(r.boundaryId);
    if (!b) continue;
    const light = classify(r);
    if (light === 'GREEN') {
      delete dirty[b.id];
      delete attempts[b.id];
      delete escalatedState[b.id];
      continue;
    }
    // RED (a leak) and YELLOW (could not be checked: a positive control or a Kane step failed) both block.
    const n = (attempts[b.id] ?? 0) + 1;
    attempts[b.id] = n;
    if (n >= cfg.maxAttempts) {
      escalate.push({ b: shownB(b), r, d: shownD(dirty[b.id]), attempts: n });
      escalatedState[b.id] = { ts: now.toISOString(), reason: light === 'RED' ? `still leaking (${r.verdict})` : 'still could not be checked (HARNESS_BROKEN)' };
    } else if (light === 'RED') {
      blocks.push(leakBlock(shownB(b), r, shownD(dirty[b.id]), n, cfg.maxAttempts, identities));
    } else {
      blocks.push(harnessBlock(shownB(b), r, n, cfg.maxAttempts));
    }
  }
  writeAttempts(p, attempts);
  if (escalate.length) {
    writeEscalationFile(p, escalatedState, escalate, cfg.maxAttempts, identities, now);
    return finishWith({ blocks, escalated: escalate.map((e) => e.b.id), escalatedMsgs: [escalationNotice(escalate.map((e) => e.b.id), escalatedState, cfg.maxAttempts, shown(projectDir, p.escalation))] });
  }
  return finishWith({ blocks });
}

/** YELLOW: a changed locked boundary that couldn't be checked. Not a pass, so it blocks too (AUD-11). */
export function harnessBlock(b: Boundary, r: ProbeResult, attempt: number, max: number): string[] {
  const why = !r.controls.ownerSeesOwnToken ? `${b.owner} did not see its own token (create/login/replay problem?)`
    : !r.controls.viewerSeesOwnToken ? `${b.viewer} did not see its own token (not signed in?)` : 'a Kane step or a target failed';
  return [
    `notyours: COULD NOT CHECK ${b.id} (${b.kind}), attempt ${attempt}/${max}: HARNESS_BROKEN, this is not a pass`,
    `  Why: ${why}`,
    '  Check that the app runs and the personas can still sign in, then stop again.',
    `  ${reauthorHint(b.id)}`,
    `  Repro: npx github:Jasekeee/notyours replay ${b.id}`,
  ];
}

/** The block text for escalated boundaries: the agent must stop retrying; only a person can release it. */
export function escalationNotice(ids: string[], state: EscalatedState, max: number, escalationFile: string): string {
  const lines = [`notyours: ESCALATED, still blocking: ${ids.map((id) => `${id} (${state[id]?.reason ?? 'attempts exhausted'})`).join('; ')}.`,
    `  ${max} attempts failed. Stop retrying and tell the user. Details: ${escalationFile}.`,
    '  A person must fix it, or release the block in their own terminal (a coding agent cannot):',
    '    npx github:Jasekeee/notyours release' + (ids.length === 1 && !ids[0]!.startsWith('__') ? ` ${ids[0]}` : ''),
    '  Changing the code under the boundary makes the next stop replay it again (GREEN clears the escalation).'];
  return lines.join('\n');
}

function writeEscalationFile(p: NotyoursPaths, state: EscalatedState, items: { b: Boundary; r: ProbeResult; d: DirtyEntry | undefined; attempts: number }[], max: number, ids: Identity[], now: Date): void {
  const others = Object.entries(state).filter(([id]) => !items.some((i) => i.b.id === id)).map(([id, e]) => `- **${id}**: ${e.reason} (since ${e.ts})`);
  const body = formatEscalation(items, max, ids, now) + (others.length ? `\n## Also escalated\n\n${others.join('\n')}\n` : '') +
    '\n## Releasing the block\n\nThe Stop hook keeps blocking until this is fixed (a GREEN replay) or a person releases it in a terminal:\n\n' +
    '```sh\nnpx github:Jasekeee/notyours release        # all, or: release <boundary-id>\n```\n';
  writeFileSync(p.escalation, body);
}

const shown = (projectDir: string, p: string): string => path.relative(projectDir, p) || '.';

/**
 * App folders under the project that have something in dirty.json. Each one's surfaces are scanned first:
 * Bash edits (sed -i, python) never fire PostToolUse, so changes since the last pass mark boundaries dirty here.
 */
function dirtyApps(projectDir: string, now: Date): string[] {
  return findAppDirs(projectDir).filter((d) => {
    try {
      markSurfaceChanges(d, loadBoundaries(notyoursPaths(d)).map((s) => s.boundary), now);
    } catch { /* a scan problem must not block the stop; PostToolUse marks still apply */ }
    return Object.keys(readDirty(notyoursPaths(d))).length > 0;
  });
}

export async function stopHook(input: HookInput, deps: StopDeps = {}): Promise<HookResult> {
  const env = deps.env ?? process.env;
  const projectDir = projectDirOf(input, env);
  // .notyours/ may live in a subfolder (demo/), so look for every app folder with dirty boundaries.
  const now = (deps.now ?? (() => new Date()))();
  const apps = dirtyApps(projectDir, now);
  if (!apps.length) return ok();

  const outcomes: AppOutcome[] = [];
  for (const appDir of apps) outcomes.push(await stopForApp(appDir, projectDir, deps, now));
  const blocks = outcomes.flatMap((o) => o.blocks);
  const escalated = outcomes.flatMap((o) => o.escalated);
  const humanNotes = outcomes.flatMap((o) => o.humanNotes);
  const stale = outcomes.flatMap((o) => o.stale ?? []);
  const escalatedMsgs = outcomes.flatMap((o) => o.escalatedMsgs ?? []);

  // Fail closed (AUD-11): a leak, a check that couldn't run (HARNESS, replay error, stale app) and an escalation all
  // exit 2. stop_hook_active is deliberately not an exit: trying to stop twice must not skip the check. After
  // maxAttempts a boundary is escalated: it keeps blocking, but without new Kane runs unless its code changes, and
  // the block text tells the agent to stop retrying and hand it to the user (`notyours release` is a person's call).
  const parts = [...stale, ...(blocks.length ? [formatLeakReport(blocks, escalated)] : []), ...escalatedMsgs];
  if (humanNotes.length && parts.length) parts.push(humanNotes.join('\n'));
  if (parts.length) return { exitCode: 2, stderr: `${parts.join('\n\n').trimEnd()}\n` };
  return humanNotes.length ? tellHuman(humanNotes.join('\n')) : ok();
}
