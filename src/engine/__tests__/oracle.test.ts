import { describe, expect, it } from 'vitest';
import { isUrlEcho, judge, parseTarget, scanText, type NetRecord, type Visit } from '../oracle.js';

const T = 'NY-ALICE-AAAAAAAAAAAA';
const B = 'NY-BOB-BBBBBBBBBBBB';

describe('oracle', () => {
  it('parseTarget: optional HTTP method prefix, default GET', () => {
    expect(parseTarget('POST http://127.0.0.1:3077/api/export')).toEqual({ method: 'POST', url: 'http://127.0.0.1:3077/api/export' });
    expect(parseTarget('delete  http://h/x')).toEqual({ method: 'DELETE', url: 'http://h/x' });
    expect(parseTarget('http://h/api/notes/1')).toEqual({ method: 'GET', url: 'http://h/api/notes/1' });
    expect(parseTarget('FETCH http://h/x').method).toBe('GET'); // unknown verb: treated as part of a URL string
  });

  it('URL echo: token came in the URL and the text repeats the path', () => {
    expect(isUrlEcho(T, [`Cannot GET /missing/${T}`], `http://127.0.0.1:3000/missing/${T}`)).toBe(true);
    expect(isUrlEcho(T, [`No results for /search?q=${T}`], `http://127.0.0.1:3000/search?q=${T}`)).toBe(true);
    expect(isUrlEcho(T, [`Cannot GET /missing/${encodeURIComponent(T)}`], `http://127.0.0.1:3000/missing/${encodeURIComponent(T)}`)).toBe(true);
  });

  it('not an echo: token not in the URL, or the text does not repeat the path', () => {
    expect(isUrlEcho(T, [`Cannot GET /notes/1 ${T}`], 'http://127.0.0.1:3000/notes/1')).toBe(false); // leak next to path
    expect(isUrlEcho(T, [`Secret body ${T}`], `http://127.0.0.1:3000/search?q=${T}`)).toBe(false); // real result
  });

  it('scanText finds every occurrence and flags echoes per occurrence', () => {
    const url = `http://h/api/x/${T}`;
    const body = JSON.stringify({ error: `not found: /api/x/${T}`, pad: 'x'.repeat(500), leaked: { owner: T } });
    const occ = scanText(body, url);
    expect(occ.map((o) => o.echo)).toEqual([true, false]);
  });

  const visit = (dom: Visit['dom']): Visit => ({ url: 'http://h/p', tag: 'leak:ui0', kind: 'ui', status: 200, dom, page: undefined as never });
  const rec = (tokens: NetRecord['tokens']): NetRecord => ({ url: 'http://h/api', status: 200, tag: 'kane', tokens });
  const ok = { ownerSeesOwnToken: true, viewerSeesOwnToken: true };

  it('verdict rules', () => {
    const leak = new Set([T]);
    expect(judge(leak, [visit([{ token: T, snippet: 's', echo: false }])], [rec([{ token: T, snippet: 's', echo: false }])], ok).verdict).toBe('LEAK_VISIBLE');
    expect(judge(leak, [visit([])], [rec([{ token: T, snippet: 's', echo: false }])], ok).verdict).toBe('LEAK_PAYLOAD');
    expect(judge(leak, [visit([{ token: T, snippet: 's', echo: true }])], [], ok).verdict).toBe('HELD');
    expect(judge(leak, [visit([{ token: B, snippet: 's', echo: false }])], [], ok).verdict).toBe('HELD'); // own token is fine
    expect(judge(leak, [], [], { ownerSeesOwnToken: true, viewerSeesOwnToken: false }).verdict).toBe('HARNESS_BROKEN');
    expect(judge(leak, [], [], { ownerSeesOwnToken: false, viewerSeesOwnToken: true }).verdict).toBe('HARNESS_BROKEN');
    // A leak is a leak even when a control fails.
    expect(judge(leak, [], [rec([{ token: T, snippet: 's', echo: false }])], { ownerSeesOwnToken: false, viewerSeesOwnToken: false }).verdict).toBe('LEAK_PAYLOAD');
  });
});
