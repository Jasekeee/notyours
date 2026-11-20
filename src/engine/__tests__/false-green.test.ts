// False-green regressions that need no browser, so they run in CI's badge workflow (ci.yml).
// The oracle's capture is driven with a fake puppeteer browser/page; the verdict comes from the real judge().
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Capture, judge, seesToken, ownerControl, type NetRecord, type Visit } from '../oracle.js';

const T = 'NY-ALICE-AAAAAAAAAAAA';
const MB2 = 2 * 1024 * 1024;

/** A fake tab: GET navigations either load (status) or abort as a download; fetch() returns the given body. */
function fakePage(opts: { download?: { status: number; body: string }; fetch?: { status: number; body: string } }) {
  const page = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(page, {
    setBypassCSP: async () => undefined,
    setCacheEnabled: async () => undefined,
    goto: async (url: string) => {
      if (opts.download && !url.endsWith('/')) throw new Error(`net::ERR_ABORTED at ${url}`);
      return { status: () => 200 };
    },
    evaluate: async () => opts.download ?? opts.fetch,
    close: async () => undefined,
    screenshot: async () => undefined,
  });
  return page;
}
function fakeCapture(page: unknown): Capture {
  const browser = { newPage: async () => page, disconnect: async () => undefined };
  return new (Capture as unknown as new (b: unknown) => Capture)(browser);
}
const controls = { ownerSeesOwnToken: true, viewerSeesOwnToken: true };

describe('false greens without a browser (audit v0.2.1)', () => {
  it('P0-2: a downloaded body over 2 MB is never HELD, even when the token is past the scanned part', async () => {
    const body = 'x'.repeat(MB2 + 10) + T;
    const cap = fakeCapture(fakePage({ download: { status: 200, body } }));
    const v = await cap.visit('http://127.0.0.1:3077/export.txt', 'leak:api0', 'api');
    const j = judge(new Set([T]), [v], cap.records, controls);
    expect(j.verdict).toBe('HARNESS_BROKEN');
    expect(j.broken?.join(' ')).toMatch(/over 2 MB/);
  });

  it('P0-2: the same for a non-GET target fetched by the oracle (POST export)', async () => {
    const body = 'x'.repeat(MB2 + 10) + T;
    const cap = fakeCapture(fakePage({ fetch: { status: 200, body } }));
    const v = await cap.visit('POST http://127.0.0.1:3077/api/export', 'leak:api0', 'api');
    expect(judge(new Set([T]), [v], cap.records, controls).verdict).toBe('HARNESS_BROKEN');
  });

  it('P0-2: a small download is still judged normally (leak found, or HELD)', async () => {
    const leak = fakeCapture(fakePage({ download: { status: 200, body: `notes\n${T}\n` } }));
    const lv = await leak.visit('http://127.0.0.1:3077/export.txt', 'leak:api0', 'api');
    expect(judge(new Set([T]), [lv], leak.records, controls).verdict).toBe('LEAK_PAYLOAD');
    const held = fakeCapture(fakePage({ download: { status: 200, body: 'nothing here' } }));
    const hv = await held.visit('http://127.0.0.1:3077/export.txt', 'leak:api0', 'api');
    expect(judge(new Set([T]), [hv], held.records, controls).verdict).toBe('HELD');
  });
});

describe('owner control per target (audit P1-09)', () => {
  const ui = (url: string, tag: string, dom: string[]): Visit =>
    ({ url, tag, kind: 'ui', status: 200, dom: dom.map((token) => ({ token, snippet: token, echo: false })), page: {} as Visit['page'] });
  const api = (url: string, tag: string): Visit => ({ url, tag, kind: 'api', status: 200, dom: [], page: {} as Visit['page'] });
  const rec = (url: string, tag: string, tokens: string[]): NetRecord => ({ url, status: 200, tag, tokens: tokens.map((token) => ({ token, snippet: token, echo: false })) });

  // The owner sees her note page, but the export target redirects everyone to a login page (a typo in the boundary).
  const visits = [ui('http://h/notes/1', 'octl:ui0', [T]), api('http://h/exprot', 'octl:api0')];
  const records = [rec('http://h/notes/1', 'octl:ui0', [T]), rec('http://h/exprot', 'octl:api0', [])];

  it('cross-user and guest: every target must show the owner her own token; the old any-of rule passed this', () => {
    expect(seesToken(T, visits, records)).toBe(true); // the old rule: one target was enough
    for (const kind of ['cross-user', 'guest'] as const) {
      expect(ownerControl(kind, T, visits, records)).toEqual({ ok: false, missing: ['http://h/exprot'] });
    }
    expect(ownerControl('cross-user', T, [visits[0]!], records)).toEqual({ ok: true, missing: [] });
    expect(ownerControl('cross-user', T, [], records)).toEqual({ ok: false, missing: [] });
  });

  it('plan-gate and sweep keep any-of: their targets include pages without the owner token (Pro button page, own list)', () => {
    expect(ownerControl('plan-gate', T, visits, records).ok).toBe(true);
    expect(ownerControl('sweep', T, visits, records).ok).toBe(true);
  });
});
