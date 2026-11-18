// Per-project daily cap on Kane authoring runs (they cost credits; replays don't count).
// The cap lives in .notyours/budget.json; only a human raises it (`notyours budget --set N`).
// Counted from the credit logs every authoring path already writes:
//   .notyours/credits.log           engine runs (probes, login recordings): {"kind":"authoring", ts, ...}
//   .notyours/runs/credits.jsonl    ratchet lock recordings:                {"kind":"author", ts, ...}
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_DAILY_CAP = 20;

export class BudgetError extends Error {}

export interface Budget {
  dailyCap: number;
}

const budgetFile = (stateDir: string) => join(stateDir, 'budget.json');

/** Local calendar day (the cap resets at local midnight), e.g. 2026-11-18. */
export function today(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function readBudget(stateDir: string): Budget {
  try {
    const raw = JSON.parse(readFileSync(budgetFile(stateDir), 'utf8')) as { dailyCap?: unknown };
    const cap = Number(raw.dailyCap);
    if (Number.isInteger(cap) && cap >= 0) return { dailyCap: cap };
  } catch { /* missing or unreadable: default */ }
  return { dailyCap: DEFAULT_DAILY_CAP };
}

export function writeBudget(stateDir: string, dailyCap: number): Budget {
  if (!Number.isInteger(dailyCap) || dailyCap < 0) throw new BudgetError(`budget must be a whole number >= 0 (got ${dailyCap})`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(budgetFile(stateDir), `${JSON.stringify({ dailyCap }, null, 2)}\n`);
  return { dailyCap };
}

function lines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l) as Record<string, unknown>); } catch { /* skip a torn line */ }
  }
  return out;
}

/** Authoring Kane runs started today in this project (both logs). */
export function authoringRunsToday(stateDir: string, now = new Date()): number {
  const day = today(now);
  const isToday = (e: Record<string, unknown>) => typeof e.ts === 'string' && today(new Date(e.ts)) === day;
  const engine = lines(join(stateDir, 'credits.log')).filter((e) => e.kind === 'authoring' && isToday(e)).length;
  const ratchet = lines(join(stateDir, 'runs', 'credits.jsonl')).filter((e) => e.kind === 'author' && isToday(e)).length;
  return engine + ratchet;
}

export function budgetStatus(stateDir: string, now = new Date()): { used: number; cap: number; left: number } {
  const used = authoringRunsToday(stateDir, now);
  const cap = readBudget(stateDir).dailyCap;
  return { used, cap, left: Math.max(0, cap - used) };
}

/** Throws BudgetError when `runs` more authoring runs would exceed today's cap. */
export function assertBudget(stateDir: string, runs = 1, now = new Date()): void {
  const { used, cap } = budgetStatus(stateDir, now);
  if (used + runs > cap) {
    throw new BudgetError(
      `Daily Kane authoring budget reached: ${used}/${cap} authoring runs used today in this project ` +
        `(.notyours/budget.json). Replays still work for free. A person can raise the cap: notyours budget --set ${Math.max(cap * 2, used + runs)}`,
    );
  }
}
