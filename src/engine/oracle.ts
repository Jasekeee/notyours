// The canary-token oracle. Verdicts are decided here: never by Kane, never with --analyzer-only.
import puppeteer, { type Browser, type HTTPResponse, type Page } from 'puppeteer-core';
import { TOKEN_SCAN_RE } from '../schemas.js';
import type { Hit, Verdict } from '../types.js';

const MAX_BODY = 2 * 1024 * 1024;
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
      const p = this.record(r, page);
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    });
  }

  private async record(r: HTTPResponse, page: Page): Promise<void> {
    const status = r.status();
    if (status >= 300 && status < 400) return;
    const headers = r.headers();
    if (!/text\/|json|html/i.test(headers['content-type'] ?? '')) return;
    if (Number(headers['content-length'] ?? 0) > MAX_BODY) return;
    let body: string;
    try { body = (await r.text()).slice(0, MAX_BODY); } catch { return; }
    this.records.push({ url: r.url(), status, tag: this.tags.get(page) ?? 'kane', tokens: scanText(body, r.url()) });
  }

  /** Wait for in-flight body reads. */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Open a URL in a new tab (never a Kane-controlled page), capture its DOM tokens and responses. */
  async visit(url: string, tag: string, kind: 'ui' | 'api', maxAttempts = 1): Promise<Visit> {
    const page = await this.browser.newPage();
    this.watch(page, tag);
    let status = 0;
    let error: string | undefined;
    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
        status = resp?.status() ?? 0;
        error = undefined;
        break;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    await new Promise((r) => setTimeout(r, 750)); // late fetches (SPAs)
    await this.flush();
    const dom = kind === 'ui' ? await scanDom(page, url) : [];
    return { url, tag, kind, status, ...(error ? { error } : {}), dom, page };
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
  let verdict: Verdict;
  if (hits.some((h) => h.where === 'dom')) verdict = 'LEAK_VISIBLE';
  else if (hits.length) verdict = 'LEAK_PAYLOAD';
  else if (controls.ownerSeesOwnToken && controls.viewerSeesOwnToken) verdict = 'HELD';
  else verdict = 'HARNESS_BROKEN';
  return { verdict, hits };
}
