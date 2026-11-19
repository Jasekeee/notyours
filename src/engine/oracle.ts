// The canary-token oracle. Verdicts are decided here: never by Kane, never with --analyzer-only.
import puppeteer, { type Browser, type HTTPResponse, type Page } from 'puppeteer-core';
import { TOKEN_SCAN_RE } from '../schemas.js';
import type { Hit, Verdict } from '../types.js';

const MAX_BODY = 2 * 1024 * 1024;
/** Response types that can't carry another user's data: not scanned (their size or read errors don't matter). */
const SKIPPED_RESOURCES = new Set(['image', 'media', 'font', 'stylesheet', 'script', 'manifest', 'texttrack']);
const SNIPPET = 80;

/** One token occurrence, with whether it is just the requested URL echoed back. */
export interface TokenOcc {
  token: string;
  snippet: string;
  echo: boolean;
}

export interface NetRecord {
  url: string;
  status: number;
  /** 'kane' for responses seen during the Kane run; otherwise the visit tag. */
  tag: string;
  tokens: TokenOcc[];
  /** Set when the body could not be judged (over the size cap, or unreadable). Never silently dropped. */
  unreadable?: string;
}

export interface Visit {
  url: string;
  tag: string;
  /** 'ui' pages are judged by DOM + network; 'api' URLs by network only. */
  kind: 'ui' | 'api';
  status: number;
  error?: string;
  dom: TokenOcc[];
  page: Page;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Method = (typeof METHODS)[number];

/** targets.api entries may carry an HTTP method: "POST http://host/api/export". Default GET. */
export function parseTarget(target: string): { method: Method; url: string } {
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec(target.trim());
  if (m && (METHODS as readonly string[]).includes(m[1]!.toUpperCase())) return { method: m[1]!.toUpperCase() as Method, url: m[2]! };
  return { method: 'GET', url: target.trim() };
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * A token is a URL echo when it arrived in the requested URL AND the surrounding text repeats that
 * URL's path (e.g. "Cannot GET /notes/NY-ALICE-…"). A token not present in the URL can never be an echo.
 */
export function isUrlEcho(token: string, contextTexts: string[], requestUrl: string): boolean {
  let u: URL;
  try { u = new URL(requestUrl); } catch { return false; }
  const full = safeDecode(u.pathname + u.search);
  const path = safeDecode(u.pathname);
  if (!full.includes(token)) return false;
  return contextTexts.some((t) => t.includes(full) || (path.includes(token) && t.includes(path)));
}

/** Token occurrences in a response body; context = ±200 chars around each match. */
export function scanText(text: string, requestUrl: string): TokenOcc[] {
  const out: TokenOcc[] = [];
  for (const m of text.matchAll(new RegExp(TOKEN_SCAN_RE.source, 'g'))) {
    const i = m.index ?? 0;
    const token = m[0];
    const ctx = text.slice(Math.max(0, i - 200), i + token.length + 200);
    out.push({
      token,
      snippet: text.slice(Math.max(0, i - SNIPPET), i + token.length + SNIPPET).replace(/\s+/g, ' ').slice(0, 500),
      echo: isUrlEcho(token, [ctx], requestUrl),
    });
  }
  return out;
}

/** Records every text/json/html response body (<=2MB) in a Chrome, across all current and new pages. */
export class Capture {
  readonly records: NetRecord[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly watched = new WeakSet<Page>();
  private readonly tags = new WeakMap<Page, string>();

  private constructor(readonly browser: Browser) {}

  static async attach(endpoint: string): Promise<Capture> {
    const browser = await puppeteer.connect({ browserURL: endpoint, defaultViewport: null });
    const c = new Capture(browser);
    for (const p of await browser.pages()) c.watch(p);
    browser.on('targetcreated', (t) => {
      if (t.type() !== 'page') return;
      void t.page().then((p) => { if (p) c.watch(p); }).catch(() => {});
    });
    return c;
  }

  watch(page: Page, tag?: string): void {
    if (tag) this.tags.set(page, tag);
    if (this.watched.has(page)) return;
    this.watched.add(page);
    page.on('response', (r) => {
      const p = this.record(r, this.tags.get(page) ?? 'kane'); // tag as of the response, not after the body read
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    });
  }

  private async record(r: HTTPResponse, tag: string): Promise<void> {
    const status = r.status();
    if (status >= 300 && status < 400 && status !== 304) return; // 304: Chrome may still hand us the cached body
    const req = r.request();
    if (req.method() === 'OPTIONS') return; // preflights have no body
    const headers = r.headers();
    const url = r.url();
    // Scanned: every document/xhr/fetch/other response whatever its content type (application/xml, octet-stream, …),
    // plus any response with a text-like content type whatever its resource type (a text/javascript data endpoint).
    // Static assets (images, fonts, stylesheets, scripts with a binary or unknown type) are skipped and never flagged.
    const textual = /text\/|json|html|xml|javascript/i.test(headers['content-type'] ?? '');
    const asset = SKIPPED_RESOURCES.has(req.resourceType());
    if (asset && !textual) return;
    // A big bundle or an evicted asset body is not evidence either way: only non-asset bodies are flagged unreadable.
    const flag = (unreadable: string) => { if (!asset) this.records.push({ url, status, tag, tokens: [], unreadable }); };
    if (Number(headers['content-length'] ?? 0) > MAX_BODY) return flag(`body over ${MAX_BODY / 1024 / 1024} MB`);
    let body: string;
    try {
      body = await r.text();
    } catch (e) {
      return flag(`body could not be read (${(e instanceof Error ? e.message : String(e)).slice(0, 60)})`);
    }
    if (body.length > MAX_BODY) {
      this.records.push({ url, status, tag, tokens: scanText(body.slice(0, MAX_BODY), url), unreadable: `body over ${MAX_BODY / 1024 / 1024} MB (only the first part was scanned)` });
      return;
    }
    this.records.push({ url, status, tag, tokens: scanText(body, url) });
  }

  /** Wait for in-flight body reads. */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /**
   * Open a target in a new tab (never a Kane-controlled page), capture its DOM tokens and responses.
   * `target` is a URL, or for api targets optionally "METHOD URL": non-GET calls are made with fetch()
   * from a tab on the app's origin, so the identity's cookies apply.
   */
  async visit(target: string, tag: string, kind: 'ui' | 'api', maxAttempts = 1): Promise<Visit> {
    const { method, url } = kind === 'api' ? parseTarget(target) : { method: 'GET' as Method, url: target };
    const page = await this.browser.newPage();
    // The oracle's own fetch() calls (non-GET targets, file downloads) run in the app's page; a strict CSP
    // (default-src 'none', as the natural app sends) would block them. Only the oracle's tabs, never Kane's.
    await page.setBypassCSP(true);
    // Fresh 200s with bodies: a warm cache (Kane already loaded these URLs) yields 304s with no body.
    await page.setCacheEnabled(false);
    if (method === 'GET') this.watch(page, tag);
    let status = 0;
    let error: string | undefined;
    let downloaded = false;
    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
      try {
        if (method === 'GET') {
          try {
            const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
            status = resp?.status() ?? 0;
          } catch (e) {
            // A file download (Content-Disposition: attachment, e.g. an "export .txt") aborts the navigation and
            // Chrome withholds its body. Fetch it from the persona's own page (its cookies) and judge the body as text.
            if (!/ERR_ABORTED/.test(e instanceof Error ? e.message : String(e))) throw e;
            // The origin page is only the fetch's context, not the target: keep its responses out of the judgement
            // (a free user's own notes list would otherwise count as a plan-gate leak).
            const ignore = `ignore:${tag}`;
            this.tags.set(page, ignore);
            await page.goto(new URL(url).origin + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
            const r = await page.evaluate(async (u: string) => {
              const res = await fetch(u, { credentials: 'include' });
              return { status: res.status, body: await res.text() };
            }, url);
            await this.flush();
            // Also drop the aborted download's own (unreadable) response: its body is the one fetched below.
            for (let i = this.records.length - 1; i >= 0; i--) {
              const rec = this.records[i]!;
              if (rec.tag === ignore || (rec.tag === tag && rec.url === url && rec.unreadable)) this.records.splice(i, 1);
            }
            status = r.status;
            downloaded = true;
            this.records.push({ url, status, tag, tokens: scanText(r.body.slice(0, MAX_BODY), url) });
          }
        } else {
          // The origin page itself is not the target: tag the tab only once it has loaded.
          await page.goto(new URL(url).origin + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
          this.watch(page, tag);
          const r = await page.evaluate(async (u: string, m: string) => {
            const res = await fetch(u, { method: m, credentials: 'include', headers: { accept: 'application/json, text/html;q=0.9, */*;q=0.8' } });
            return { status: res.status, body: await res.text() };
          }, url, method);
          status = r.status;
          this.records.push({ url, status, tag, tokens: scanText(r.body.slice(0, MAX_BODY), url) });
        }
        error = undefined;
        break;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    await new Promise((r) => setTimeout(r, 750)); // late fetches (SPAs)
    await this.flush();
    if (downloaded) this.tags.set(page, `ignore:${tag}`);
    await this.flush();
    for (let i = this.records.length - 1; i >= 0; i--) if (this.records[i]!.tag === `ignore:${tag}`) this.records.splice(i, 1);
    // A download is judged by its body (a record under this visit's tag), so it counts as an api visit: the tab
    // shows the origin page, whose DOM is not the target.
    const dom = kind === 'ui' && !downloaded ? await scanDom(page, url) : [];
    return { url: target, tag, kind: downloaded ? 'api' : kind, status, ...(error ? { error } : {}), dom, page };
  }

  async detach(): Promise<void> {
    await this.flush();
    await this.browser.disconnect(); // leave Chrome running; the pool owns it
  }
}

/** Visible-text token occurrences, per text node, with URL-echo detection on the enclosing elements. */
export async function scanDom(page: Page, requestUrl: string): Promise<TokenOcc[]> {
  let raw: { token: string; snippet: string; contexts: string[] }[] = [];
  try {
    raw = await page.evaluate((src: string, snippetLen: number) => {
      const out: { token: string; snippet: string; contexts: string[] }[] = [];
      if (!document.body) return out;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        const text = n.nodeValue ?? '';
        if (!el || skip.has(el.tagName) || !text.includes('NY-')) continue;
        if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
        const contexts = [el, el.parentElement].filter((e): e is HTMLElement => !!e).map((e) => (e.innerText || e.textContent || '').slice(0, 4000));
        for (const m of text.matchAll(new RegExp(src, 'g'))) {
          const i = m.index ?? 0;
          out.push({ token: m[0], snippet: text.slice(Math.max(0, i - snippetLen), i + m[0].length + snippetLen), contexts });
        }
      }
      return out;
    }, TOKEN_SCAN_RE.source, SNIPPET);
  } catch {
    return [];
  }
  return raw.map((r) => ({
    token: r.token,
    snippet: r.snippet.replace(/\s+/g, ' ').trim().slice(0, 500),
    echo: isUrlEcho(r.token, r.contexts, requestUrl),
  }));
}

/** Does this identity see its own token (non-echo) in these visits? ui: DOM; api: network. */
export function seesToken(token: string, visits: Visit[], records: NetRecord[]): boolean {
  if (visits.some((v) => v.kind === 'ui' && v.dom.some((o) => o.token === token && !o.echo))) return true;
  const apiTags = new Set(visits.filter((v) => v.kind === 'api').map((v) => v.tag));
  return records.some((r) => apiTags.has(r.tag) && r.tokens.some((o) => o.token === token && !o.echo));
}

export interface Judgement {
  verdict: Verdict;
  hits: Hit[];
  /** Why a no-hit result couldn't count as HELD (errored/5xx visits, unreadable leak bodies). */
  broken?: string[];
}

/**
 * LEAK_VISIBLE: a leak token in the DOM. LEAK_PAYLOAD: only in network bodies.
 * HELD: no hit and both positive controls. Anything else: HARNESS_BROKEN.
 */
export function judge(
  leakTokens: Set<string>,
  visits: Visit[],
  records: NetRecord[],
  controls: { ownerSeesOwnToken: boolean; viewerSeesOwnToken: boolean },
): Judgement {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const add = (h: Hit) => {
    const k = `${h.where}|${h.token}|${h.url}`;
    if (!seen.has(k)) { seen.add(k); hits.push(h); }
  };
  for (const v of visits) {
    if (v.kind !== 'ui') continue;
    for (const o of v.dom) if (!o.echo && leakTokens.has(o.token)) add({ token: o.token, where: 'dom', url: v.url, snippet: o.snippet });
  }
  for (const r of records) {
    for (const o of r.tokens) if (!o.echo && leakTokens.has(o.token)) add({ token: o.token, where: 'network', url: r.url, snippet: o.snippet });
  }
  // No hit is only evidence of "held" if every judged observation actually happened: a leak visit that errored,
  // got no response (status 0) or a 5xx, or a leak response whose body couldn't be read, proves nothing (AUD-03/12).
  const broken = [
    ...visits.filter((v) => v.error || v.status === 0 || v.status >= 500).map((v) => `${v.url}: ${v.error ?? `status ${v.status}`}`),
    ...records.filter((r) => r.unreadable && r.tag.startsWith('leak:')).map((r) => `${r.url}: ${r.unreadable}`),
  ];
  let verdict: Verdict;
  if (hits.some((h) => h.where === 'dom')) verdict = 'LEAK_VISIBLE';
  else if (hits.length) verdict = 'LEAK_PAYLOAD';
  else if (broken.length) verdict = 'HARNESS_BROKEN';
  else if (controls.ownerSeesOwnToken && controls.viewerSeesOwnToken) verdict = 'HELD';
  else verdict = 'HARNESS_BROKEN';
  return { verdict, hits, ...(broken.length ? { broken } : {}) };
}
