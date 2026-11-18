import fs from 'node:fs';
import path from 'node:path';
import type { Boundary, Identity, ProbeResult, Report } from '../types.js';
import { renderHtml, scrub, scrubDeep } from './html.js';
import { MockReport } from './mock.js';
import { headline, parties, tally, verdictGroup, whoAndWhat } from './summary.js';

export { MockReport };
export { renderHtml } from './html.js';
export * from './summary.js';

export interface ReportContext {
  /** Boundaries the results belong to (for who/what, kind, surface). */
  boundaries?: Boundary[];
  /** Only used to scrub passwords from snippets/URLs. Never written out. */
  identities?: Identity[];
  startedAt?: string;
  finishedAt?: string;
  /** Base for relative screenshot paths. Defaults to process.cwd(). */
  baseDir?: string;
  now?: () => Date;
}

/** Writes report.html (self-contained) and report.json into outDir; returns the HTML path. */
export class HtmlReport implements Report {
  constructor(private readonly ctx: ReportContext = {}) {}

  write(rawResults: ProbeResult[], outDir: string): string {
    const secrets = (this.ctx.identities ?? []).map((i) => i.password).filter((p): p is string => !!p);
    // Scrub raw strings before escaping/serialising: an escaped secret (&lt; \") would not match afterwards.
    const results = scrubDeep(rawResults, secrets);
    const boundaries = new Map((this.ctx.boundaries ?? []).map((b) => [b.id, b]));
    const generatedAt = (this.ctx.now?.() ?? new Date()).toISOString();
    const { startedAt, finishedAt } = this.ctx;
    const runTimeS = startedAt && finishedAt ? Math.max(0, (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000) : undefined;

    fs.mkdirSync(outDir, { recursive: true });
    const htmlPath = path.join(outDir, 'report.html');
    const html = renderHtml(results, { boundaries, baseDir: this.ctx.baseDir ?? process.cwd(), runTimeS, generatedAt, secrets });
    fs.writeFileSync(htmlPath, scrub(html, secrets));

    const h = headline(results, boundaries);
    const json = {
      generatedAt,
      startedAt,
      finishedAt,
      runTimeS,
      headline: h.title,
      summary: tally(results),
      results: results.map((r) => {
        const b = boundaries.get(r.boundaryId);
        const p = parties(r, b);
        return {
          ...r,
          group: verdictGroup(r.verdict),
          owner: p.owner,
          viewer: p.viewer,
          kind: p.kind,
          whoAndWhat: whoAndWhat(p),
          surface: b?.surface ?? [],
        };
      }),
    };
    fs.writeFileSync(path.join(outDir, 'report.json'), `${scrub(JSON.stringify(json, null, 2), secrets)}\n`);
    return htmlPath;
  }
}

/** Entry point used by the CLI. */
export function createReport(ctx: ReportContext = {}): Report {
  return new HtmlReport(ctx);
}
