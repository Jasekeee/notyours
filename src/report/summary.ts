// Plain-language summaries of probe results, shared by the HTML report, report.json and the CLI.
import type { Boundary, BoundaryKind, ProbeResult, Verdict } from '../types.js';

export type VerdictGroup = 'LEAK' | 'HELD' | 'HARNESS';

export function verdictGroup(v: Verdict): VerdictGroup {
  return v === 'HELD' ? 'HELD' : v === 'HARNESS_BROKEN' ? 'HARNESS' : 'LEAK';
}

export function isLeak(r: ProbeResult): boolean {
  return verdictGroup(r.verdict) === 'LEAK';
}

/** alice -> Alice, free_user -> Free user */
export function displayName(id: string): string {
  const s = id.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** NY-ALICE-K7Q2MZX4P3RA -> alice */
export function tokenOwner(token: string): string | undefined {
  const m = /^NY-([A-Z][A-Z0-9_]*)-[A-Z2-7]{12}$/.exec(token);
  return m?.[1]?.toLowerCase();
}

export interface Parties {
  owner: string;
  viewer: string;
  kind: BoundaryKind | undefined;
}

/** Who created the data and who must not see it. Falls back to the results when the boundary is unknown. */
export function parties(r: ProbeResult, b: Boundary | undefined): Parties {
  if (b) return { owner: b.owner, viewer: b.viewer, kind: b.kind };
  const fromHit = r.hits.map((h) => tokenOwner(h.token)).find(Boolean);
  const runIds = [...new Set(r.kaneRuns.map((k) => k.identity))];
  const owner = fromHit ?? runIds[0] ?? 'owner';
  const viewer = runIds.find((id) => id !== owner) ?? 'viewer';
  return { owner, viewer, kind: undefined };
}

/** One sentence for what the probe tried. */
export function whoAndWhat(p: Parties): string {
  const o = displayName(p.owner);
  const v = displayName(p.viewer);
  switch (p.kind) {
    case 'guest':
      return `A signed-out ${p.viewer === 'guest' ? 'guest' : v} tried to open data ${o} created.`;
    case 'plan-gate':
      return `${v} (free plan) tried a Pro-only action.`;
    case 'sweep':
      return `${v} swept every page, looking for anything ${o} created.`;
    default:
      return `${v} tried to open data ${o} created.`;
  }
}

/** The headline phrase for a leak: "Bob saw Alice's data". */
export function leakPhrase(p: Parties): string {
  if (p.kind === 'plan-gate') return `${displayName(p.viewer)} got a Pro feature for free`;
  return `${displayName(p.viewer)} saw ${displayName(p.owner)}'s data`;
}

export function verdictExplanation(r: ProbeResult, p: Parties): string {
  const o = displayName(p.owner);
  const v = displayName(p.viewer);
  switch (r.verdict) {
    case 'LEAK_VISIBLE':
      return p.kind === 'plan-gate' ? `The Pro-only result appeared on ${v}'s screen.` : `${o}'s canary token appeared on ${v}'s screen.`;
    case 'LEAK_PAYLOAD':
      return `${o}'s canary token reached ${v}'s browser in a network response, even though the page didn't show it.`;
    case 'HELD':
      return `${v} never received ${o}'s token, and both positive controls passed.`;
    case 'HARNESS_BROKEN':
      return 'The probe could not prove anything: a positive control failed. This is not a pass.';
  }
}

export function credits(r: ProbeResult): number {
  return r.kaneRuns.reduce((s, k) => s + k.creditsConsumed, 0);
}

export interface Tally {
  total: number;
  leaks: number;
  held: number;
  harness: number;
  credits: number;
}

export function tally(results: ProbeResult[]): Tally {
  const t: Tally = { total: results.length, leaks: 0, held: 0, harness: 0, credits: 0 };
  for (const r of results) {
    const g = verdictGroup(r.verdict);
    if (g === 'LEAK') t.leaks++;
    else if (g === 'HELD') t.held++;
    else t.harness++;
    t.credits += credits(r);
  }
  return t;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export interface Headline {
  title: string;
  sub: string;
  tone: VerdictGroup;
}

/** "Bob saw Alice's data: 2 leaks" when there are leaks; otherwise a held/harness summary. */
export function headline(results: ProbeResult[], boundaries: Map<string, Boundary>): Headline {
  const t = tally(results);
  if (t.leaks > 0) {
    const counts = new Map<string, number>();
    for (const r of results.filter(isLeak)) {
      const phrase = leakPhrase(parties(r, boundaries.get(r.boundaryId)));
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const title = ranked.length === 1 ? `${ranked[0]![0]}: ${plural(t.leaks, 'leak')}` : `${plural(t.leaks, 'leak')} across ${plural(ranked.length, 'pair')} of users`;
    const others = ranked.length > 1 ? ranked.map(([p, n]) => `${p} (${n})`).join('; ') : '';
    const rest = [`${plural(t.leaks, 'boundary', 'boundaries')} leaked out of ${t.total}`, others, t.harness ? `${t.harness} could not be judged` : '']
      .filter(Boolean)
      .join('. ');
    return { title, sub: `${rest}.`, tone: 'LEAK' };
  }
  if (t.total === 0) return { title: 'No boundaries probed yet', sub: 'Run `notyours run` or `notyours demo`.', tone: 'HARNESS' };
  if (t.harness > 0 && t.held === 0) {
    return { title: `${plural(t.harness, 'boundary', 'boundaries')} could not be judged`, sub: 'A positive control failed, so these are not passes. Fix the harness and rerun.', tone: 'HARNESS' };
  }
  return {
    title: "Nobody saw anyone else's data",
    sub: `${plural(t.held, 'boundary', 'boundaries')} held${t.harness ? `; ${t.harness} could not be judged (not a pass)` : ''}.`,
    tone: t.harness ? 'HARNESS' : 'HELD',
  };
}
