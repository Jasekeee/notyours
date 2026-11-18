import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProbeResultSchema } from '../schemas.js';
import { mockHeldResult } from '../mocks/fixtures.js';
import { createReport } from './index.js';
import { esc, highlightTokens, screenshotDataUri } from './html.js';
import { displayName, headline, tally, tokenOwner } from './summary.js';
import { FIXTURE_DIR, fixtureBoundaries, fixtureIdentities, fixtureResults } from './__fixtures__/results.js';

const byId = new Map(fixtureBoundaries.map((b) => [b.id, b]));

describe('report fixtures', () => {
  it('are valid ProbeResults', () => {
    for (const r of fixtureResults) expect(() => ProbeResultSchema.parse(r)).not.toThrow();
  });
});

describe('summary', () => {
  it('names identities for humans', () => {
    expect(displayName('alice')).toBe('Alice');
    expect(displayName('free_user')).toBe('Free user');
    expect(tokenOwner('NY-FREE_USER-DDDDDDDDDDDD')).toBe('free_user');
  });

  it('headline: "Bob saw Alice\'s data: N leaks"', () => {
    expect(headline(fixtureResults, byId).title).toBe("Bob saw Alice's data: 2 leaks");
    expect(headline(fixtureResults.slice(0, 1), byId).title).toBe("Bob saw Alice's data: 1 leak");
  });

  it('headline infers owner/viewer from tokens and runs when boundaries are unknown', () => {
    expect(headline(fixtureResults.slice(0, 1), new Map()).title).toBe("Bob saw Alice's data: 1 leak");
  });

  it('headline when nothing leaked or nothing ran', () => {
    expect(headline([mockHeldResult], byId)).toMatchObject({ title: "Nobody saw anyone else's data", tone: 'HELD' });
    expect(headline([], byId).tone).toBe('HARNESS');
    expect(headline([fixtureResults[3]!], byId).title).toBe('1 boundary could not be judged');
  });

  it('tallies verdicts and credits', () => {
    expect(tally(fixtureResults)).toEqual({ total: 4, leaks: 2, held: 1, harness: 1, credits: 16 + 0 + 0 + 0 + 16 + 12.3 + 16 });
  });
});

describe('html helpers', () => {
  it('escapes HTML and highlights tokens', () => {
    expect(esc(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    expect(highlightTokens('<b>NY-ALICE-AAAAAAAAAAAA</b>')).toBe('&lt;b&gt;<mark class="tok">NY-ALICE-AAAAAAAAAAAA</mark>&lt;/b&gt;');
  });

  it('embeds screenshots as base64 and skips missing or non-image files', () => {
    expect(screenshotDataUri('bob-sees-note.png', FIXTURE_DIR)).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(screenshotDataUri('missing.png', FIXTURE_DIR)).toBeUndefined();
    expect(screenshotDataUri('results.ts', FIXTURE_DIR)).toBeUndefined();
    expect(screenshotDataUri('data:image/png;base64,AAAA', FIXTURE_DIR)).toBe('data:image/png;base64,AAAA');
  });
});

describe('createReport().write', () => {
  let html = '';
  let json: Record<string, unknown> & { results: Array<Record<string, unknown>>; summary: Record<string, number> };
  let htmlPath = '';
  let outDir = '';

  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-report-'));
    htmlPath = createReport({
      boundaries: fixtureBoundaries,
      identities: fixtureIdentities,
      baseDir: FIXTURE_DIR,
      startedAt: '2026-11-18T12:00:00.000Z',
      finishedAt: '2026-11-18T12:02:41.000Z',
      now: () => new Date('2026-11-18T12:03:00.000Z'),
    }).write(fixtureResults, outDir);
    html = fs.readFileSync(htmlPath, 'utf8');
    json = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
  });

  it('writes report.html and report.json and returns the HTML path', () => {
    expect(htmlPath).toBe(path.join(outDir, 'report.html'));
    expect(json.headline).toBe("Bob saw Alice's data: 2 leaks");
    expect(json.summary).toMatchObject({ total: 4, leaks: 2, held: 1, harness: 1 });
    expect(json.runTimeS).toBe(161);
    expect(json.results[0]).toMatchObject({ boundaryId: 'notes-cross-user', group: 'LEAK', owner: 'alice', viewer: 'bob' });
  });

  it('is self-contained: inline CSS, base64 images, no external resources', () => {
    expect(html).toContain('<style>');
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).not.toMatch(/<link[^>]+stylesheet|<script\b/);
    expect(html).not.toMatch(/src="https?:/);
  });

  it('has the header, one card per boundary with badges, controls, hits, links, credits', () => {
    expect(html).toContain("<h1>Bob saw Alice&#39;s data: 2 leaks</h1>");
    expect(html.match(/<article class="card /g)).toHaveLength(4);
    expect(html).toContain('class="badge leak">LEAK<small>visible</small>');
    expect(html).toContain('class="badge leak">LEAK<small>in payload</small>');
    expect(html).toContain('class="badge held">HELD');
    expect(html).toContain('class="badge harness">HARNESS');
    expect(html).toContain('Bob tried to open data Alice created.');
    expect(html).toContain('<li class="ctl bad">');
    expect(html).toContain('<mark class="tok">NY-ALICE-AAAAAAAAAAAA</mark>');
    expect(html).toContain('href="https://kane.example.test/tests/alice-1"');
    expect(html).toContain('Screenshot not found');
    expect(html).toContain('Total Kane credits <b>60</b>');
    expect(html).toContain('Run time <b>2m 41s</b>');
  });

  it('orders leaks first, then harness, then held', () => {
    const ids = [...html.matchAll(/<article class="card \w+" id="b-([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['notes-cross-user', 'invoices-cross-user', 'export-plan-gate', 'profile-guest']);
  });

  it('escapes page content inside snippets (no injected <script>)', () => {
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x</script>');
  });

  it('never writes identity passwords', () => {
    for (const f of ['report.html', 'report.json']) {
      const body = fs.readFileSync(path.join(outDir, f), 'utf8');
      expect(body).not.toContain('fake-pw-alice');
      expect(body).toContain('[REDACTED]');
    }
  });

  it('scrubs passwords that contain HTML/JSON special characters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-report-'));
    const pw = 'p<w>"&\\x';
    const ids = [{ ...fixtureIdentities[0]!, password: pw }];
    const r = { ...fixtureResults[0]!, hits: [{ ...fixtureResults[0]!.hits[0]!, snippet: `NY-ALICE-AAAAAAAAAAAA ${pw}` }] };
    createReport({ identities: ids, baseDir: FIXTURE_DIR }).write([r], dir);
    for (const f of ['report.html', 'report.json']) {
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(body).not.toContain('p&lt;w&gt;');
      expect(body).not.toContain('p<w>');
      expect(body).toContain('[REDACTED]');
    }
  });
});
