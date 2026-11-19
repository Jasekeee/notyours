// `notyours` with no arguments: what is configured, what is locked, and the single next command to run.
// Reads only project files (no Kane, no network, no credits, never secrets).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { budgetStatus } from '../shared/budget.js';
import { verdictGroup } from '../report/summary.js';
import { lockedBoundaryFiles } from './hooks.js';
import { readBoundaries, readConfigIfExists, readLatestRun, nyPaths } from './workspace.js';
import { readPersonas } from './personas.js';
import type { Boundary, ProbeResult } from '../types.js';
import { table } from './output.js';

export interface Next {
  command: string;
  why: string;
}

export interface StatusReport {
  root: string;
  configured: boolean;
  baseUrl?: string;
  app?: { start?: string; port?: number };
  personas: { ids: string[]; withLogin: string[]; missingLogin: string[] };
  boundaries: { total: number; ids: string[]; locked: string[]; drafts: string[] };
  lastRun?: { startedAt?: string; verdicts: Record<string, string>; leaks: string[] };
  hooks: { installed: boolean };
  budget?: { used: number; cap: number; left: number };
  /** What the coding agent can't touch (the guard hook), so a person knows what is protected. */
  protectedForAgent: string[];
  next: Next;
}

export const PROTECTED_FOR_AGENT = [
  'secrets and browser profiles',
  'Kane recordings (locked boundaries replay them)',
  'run results and the credit log',
  'config.yaml, the daily budget and hook settings',
];

/** Draft files (`_draft_*.yaml`) that `notyours map` wrote and nobody finished yet. */
function draftIds(root: string): string[] {
  const dir = nyPaths(root).boundaries;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^_draft_.*\.ya?ml$/.test(f)).map((f) => f.replace(/^_draft_/, '').replace(/\.ya?ml$/, ''));
}

function hooksInstalled(root: string): boolean {
  const file = path.join(root, '.claude', 'settings.json');
  if (!fs.existsSync(file)) return false;
  try {
    return /\bhook stop\b|notyours-hook/.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function verdictsOf(results: ProbeResult[]): { verdicts: Record<string, string>; leaks: string[] } {
  const verdicts: Record<string, string> = {};
  const leaks: string[] = [];
  for (const r of results) {
    verdicts[r.boundaryId] = r.verdict;
    if (verdictGroup(r.verdict) === 'LEAK') leaks.push(r.boundaryId);
  }
  return { verdicts, leaks };
}

export function computeStatus(root: string): StatusReport {
  const cfg = (() => {
    try {
      return readConfigIfExists(root);
    } catch {
      return undefined;
    }
  })();
  const configured = cfg !== undefined;
  const ids = readPersonas(root);
  const boundaries = configured ? readBoundaries(root) : [];
  const real = boundaries.map((b) => b.boundary);
  const locked = real.filter((b) => b.locked === true).map((b) => b.id);
  const drafts = draftIds(root);
  const run = (() => {
    try {
      return readLatestRun(root);
    } catch {
      return undefined;
    }
  })();
  const lastRun = run
    ? { ...(run.meta?.startedAt ? { startedAt: run.meta.startedAt } : {}), ...verdictsOf(run.results) }
    : undefined;
  const app = readAppBlock(root);
  const budget = configured ? budgetStatus(nyPaths(root).dir) : undefined;
  const status: Omit<StatusReport, 'next'> = {
    root,
    configured,
    ...(cfg ? { baseUrl: cfg.baseUrl } : {}),
    ...(app ? { app } : {}),
    personas: { ids: ids.all, withLogin: ids.withLogin, missingLogin: ids.missingLogin },
    boundaries: { total: real.length, ids: real.map((b) => b.id), locked, drafts },
    ...(lastRun ? { lastRun } : {}),
    hooks: { installed: hooksInstalled(root) },
    ...(budget ? { budget } : {}),
    protectedForAgent: PROTECTED_FOR_AGENT,
  };
  return { ...status, next: nextStep(status, real) };
}

/** The one command that moves the project forward, from the first thing missing. */
export function nextStep(s: Omit<StatusReport, 'next'>, boundaries: Boundary[]): Next {
  if (!s.configured) return { command: 'notyours init', why: 'no .notyours/config.yaml here yet: the wizard detects your app and signs up test personas' };
  if (s.personas.ids.length === 0 || s.personas.missingLogin.length) {
    return { command: 'notyours init', why: `personas without a login: ${s.personas.missingLogin.join(', ') || 'none created'}` };
  }
  if (s.boundaries.total === 0) {
    return s.boundaries.drafts.length
      ? { command: '/notyours-map (in Claude Code)', why: `${s.boundaries.drafts.length} draft boundar${s.boundaries.drafts.length === 1 ? 'y' : 'ies'} waiting to be finished` }
      : { command: 'notyours map', why: 'no boundaries yet: scan the routes for drafts' };
  }
  if (s.boundaries.drafts.length) {
    return { command: '/notyours-map (in Claude Code)', why: `${s.boundaries.drafts.length} draft(s) not yet boundaries` };
  }
  if (!s.lastRun) return { command: 'notyours run --dry-run', why: `${s.boundaries.total} boundar${s.boundaries.total === 1 ? 'y' : 'ies'} not proven yet; the dry run shows the credit estimate` };
  if (s.lastRun.leaks.length) {
    return { command: 'notyours report --open', why: `${s.lastRun.leaks.length} leak(s): ${s.lastRun.leaks.join(', ')}. Fix the code, then notyours replay` };
  }
  const unlocked = boundaries.filter((b) => b.locked !== true).map((b) => b.id);
  if (unlocked.length) return { command: 'notyours lock', why: `${unlocked.length} proven but not locked: ${unlocked.join(', ')} (replays then cost 0 credits)` };
  if (!s.hooks.installed) return { command: 'notyours setup claude', why: 'boundaries are locked; install the hooks so Claude Code re-checks them on every stop' };
  return { command: 'notyours replay', why: `all ${s.boundaries.locked.length} boundaries locked; replay them (0 credits)` };
}

function readAppBlock(root: string): { start?: string; port?: number } | undefined {
  const file = nyPaths(root).config;
  if (!fs.existsSync(file)) return undefined;
  try {
    const doc = (YAML.parse(fs.readFileSync(file, 'utf8')) as { app?: { start?: string; port?: number } } | null)?.app;
    return doc ? { ...(doc.start ? { start: doc.start } : {}), ...(doc.port ? { port: doc.port } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** Plain text for a person: configured / personas / boundaries / last run / protected, then the next command. */
export function renderStatus(s: StatusReport): string {
  const mark = (ok: boolean) => (ok ? '✓' : '✗');
  const lines: string[] = [];
  lines.push(`notyours in ${s.root}`);
  if (!s.configured) {
    lines.push(`${mark(false)} not set up yet`);
  } else {
    lines.push(`${mark(true)} app ${s.baseUrl}${s.app?.start ? `  (start: ${s.app.start})` : ''}`);
    lines.push(`${mark(s.personas.missingLogin.length === 0 && s.personas.ids.length > 0)} personas ${s.personas.ids.join(', ') || '(none)'}${s.personas.missingLogin.length ? `  missing login: ${s.personas.missingLogin.join(', ')}` : ''}`);
    lines.push(`${mark(s.boundaries.total > 0)} boundaries ${s.boundaries.total}  locked ${s.boundaries.locked.length}  drafts ${s.boundaries.drafts.length}`);
    if (s.lastRun) {
      const rows = Object.entries(s.lastRun.verdicts).map(([id, v]) => [id, v]);
      lines.push(`${mark(s.lastRun.leaks.length === 0)} last run${s.lastRun.startedAt ? ` ${s.lastRun.startedAt}` : ''}`);
      if (rows.length) lines.push(table(['boundary', 'verdict'], rows).split('\n').map((l) => `    ${l}`).join('\n'));
    } else {
      lines.push('- no run yet');
    }
    lines.push(`${mark(s.hooks.installed)} Claude Code hooks ${s.hooks.installed ? 'installed' : 'not installed'}`);
    if (s.budget) lines.push(`  authoring Kane runs today ${s.budget.used}/${s.budget.cap}`);
  }
  lines.push(`locked for the coding agent: ${PROTECTED_FOR_AGENT.join('; ')}`);
  lines.push('');
  lines.push(`Next: ${s.next.command}`);
  lines.push(`      ${s.next.why}`);
  return lines.join('\n');
}
