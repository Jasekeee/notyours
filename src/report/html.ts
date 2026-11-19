// Renders ProbeResult[] into one self-contained HTML page (inline CSS, screenshots as base64). Built for a screen recording.
import fs from 'node:fs';
import path from 'node:path';
import { TOKEN_SCAN_RE } from '../schemas.js';
import type { Boundary, Hit, ProbeResult } from '../types.js';
import { credits, displayName, headline, parties, tally, verdictExplanation, verdictGroup, whoAndWhat, type VerdictGroup } from './summary.js';

export interface RenderOptions {
  boundaries: Map<string, Boundary>;
  /** Where relative screenshot paths are resolved from. */
  baseDir: string;
  /** Total wall-clock run time in seconds, if known. */
  runTimeS?: number;
  generatedAt: string;
  /** Strings that must never appear in the output (identity passwords). */
  secrets: string[];
}

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function scrub(s: string, secrets: string[]): string {
  let out = s;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[REDACTED]');
  return out;
}

/** Recursively replace secrets in every string of a JSON-like value. */
export function scrubDeep<T>(value: T, secrets: string[]): T {
  if (!secrets.length) return value;
  if (typeof value === 'string') return scrub(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, secrets)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, secrets)])) as T;
  }
  return value;
}

/** Escape, then wrap every canary token in a <mark>. */
export function highlightTokens(text: string): string {
  return esc(text).replace(new RegExp(TOKEN_SCAN_RE.source, 'g'), (t) => `<mark class="tok">${t}</mark>`);
}

function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/** data: URI for a screenshot path (or the data URI itself). undefined if missing or not an image. */
export function screenshotDataUri(ref: string, baseDir: string): string | undefined {
  if (ref.startsWith('data:image/')) return ref;
  const file = path.resolve(baseDir, ref);
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime || !fs.existsSync(file)) return undefined;
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > MAX_SCREENSHOT_BYTES) return undefined;
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

export function fmtCredits(n: number): string {
  return n === 0 ? '0' : n < 10 ? n.toFixed(1) : n.toFixed(0);
}

export function fmtDuration(s: number): string {
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

const BADGE: Record<VerdictGroup, string> = { LEAK: 'LEAK', HELD: 'HELD', HARNESS: 'HARNESS' };

function hitBlock(h: Hit, secrets: string[]): string {
  const where = h.where === 'dom' ? 'On screen' : 'In a network response';
  return `<li class="hit">
  <div class="hit-where"><span class="hit-kind">${where}</span> <code class="url">${esc(scrub(h.url, secrets))}</code></div>
  <pre class="snippet">${highlightTokens(scrub(h.snippet, secrets))}</pre>
</li>`;
}

function control(ok: boolean, label: string): string {
  return `<li class="ctl ${ok ? 'ok' : 'bad'}"><span class="mark" aria-hidden="true">${ok ? '✓' : '✗'}</span>${esc(label)}<span class="sr">${ok ? ' passed' : ' failed'}</span></li>`;
}

function card(r: ProbeResult, o: RenderOptions): string {
  const b = o.boundaries.get(r.boundaryId);
  const p = parties(r, b);
  const g = verdictGroup(r.verdict);
  const sub = r.verdict === 'LEAK_VISIBLE' ? 'visible' : r.verdict === 'LEAK_PAYLOAD' ? 'in payload' : '';
  const shots = r.screenshots
    .map((s) => ({ ref: s, uri: screenshotDataUri(s, o.baseDir) }))
    .map(({ ref, uri }) =>
      uri
        ? `<figure class="shot"><img alt="Screenshot from ${esc(r.boundaryId)}" src="${uri}"><figcaption>${esc(path.basename(ref.startsWith('data:') ? 'screenshot' : ref))}</figcaption></figure>`
        : `<figure class="shot missing"><div>Screenshot not found</div><figcaption>${esc(path.basename(ref))}</figcaption></figure>`,
    )
    .join('');
  // No links: a Kane run's Test Manager URL carries the TestMu project, test-case and share ids (AUD-02). A report
  // gets filmed and shared, so it shows only who ran, the result, credits and time.
  const runs = r.kaneRuns
    .map((k) => `<li>${esc(`${displayName(k.identity)}: ${k.status}, ${fmtCredits(k.creditsConsumed)} credits, ${fmtDuration(k.durationS)}`)}</li>`)
    .join('');
  const surface = b?.surface.length ? `<p class="surface">Code to check: ${b.surface.map((s) => `<code>${esc(s)}</code>`).join(' ')}</p>` : '';
  const viewerLabel = p.kind === 'plan-gate' ? `${displayName(p.viewer)} can use their own session` : `${displayName(p.viewer)} sees their own token`;

  return `<article class="card ${g.toLowerCase()}" id="b-${esc(r.boundaryId)}">
  <header class="card-head">
    <span class="badge ${g.toLowerCase()}">${BADGE[g]}${sub ? `<small>${sub}</small>` : ''}</span>
    <h2>${esc(r.boundaryId)}</h2>
    <span class="kind">${esc(p.kind ?? 'boundary')}${b?.locked ? ', locked' : ''}</span>
  </header>
  <p class="who">${esc(whoAndWhat(p))}</p>
  <p class="why">${esc(verdictExplanation(r, p))}</p>
  <div class="cols">
    <section><h3>Controls</h3><ul class="controls">
      ${control(r.controls.ownerSeesOwnToken, `${displayName(p.owner)} sees their own token`)}
      ${control(r.controls.viewerSeesOwnToken, viewerLabel)}
    </ul></section>
    <section><h3>Kane runs</h3><ul class="runs">${runs || '<li>none recorded</li>'}</ul><p class="cr">${fmtCredits(credits(r))} credits</p></section>
  </div>
  ${r.hits.length ? `<section><h3>${r.hits.length === 1 ? 'Where the token showed up' : `Where the token showed up (${r.hits.length})`}</h3><ul class="hits">${r.hits.map((h) => hitBlock(h, o.secrets)).join('')}</ul></section>` : ''}
  ${shots ? `<section><h3>Screenshots</h3><div class="shots">${shots}</div></section>` : ''}
  ${surface}
</article>`;
}

const CSS = `
:root{--page:#EDF0F4;--sheet:#FFFFFF;--ink:#132033;--muted:#55627A;--rule:#D5DBE4;--leak:#C1121F;--held:#17734A;--harness:#B26B00;--canary:#FFE14D}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--ink);font:400 19px/1.5 "Avenir Next","Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
code,pre,.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
main{max-width:1100px;margin:0 auto;padding:56px 32px 40px}
.top{padding:8px 0 40px}
.top .app{font-weight:600;color:var(--muted);margin:0 0 20px;font-size:18px}
.top h1{font-size:clamp(40px,7vw,76px);line-height:1.02;letter-spacing:-.025em;font-weight:800;margin:0 0 18px;text-wrap:balance}
.top.leak h1{color:var(--leak)}.top.held h1{color:var(--held)}.top.harness h1{color:var(--harness)}
.top .sub{font-size:24px;color:var(--ink);margin:0;max-width:52ch}
.tally{display:flex;flex-wrap:wrap;gap:12px;margin:32px 0 0;padding:0;list-style:none}
.tally li{background:var(--sheet);border-radius:10px;padding:12px 20px;font-size:20px;font-weight:600;border-left:6px solid var(--rule)}
.tally li b{font-size:30px;margin-right:8px;font-variant-numeric:tabular-nums}
.tally .leak{border-color:var(--leak)}.tally .held{border-color:var(--held)}.tally .harness{border-color:var(--harness)}
.card{background:var(--sheet);border-radius:4px 14px 14px 4px;border-left:12px solid var(--rule);padding:30px 36px 32px;margin:0 0 28px}
.card.leak{border-left-color:var(--leak)}.card.held{border-left-color:var(--held)}.card.harness{border-left-color:var(--harness)}
.card-head{display:flex;flex-wrap:wrap;align-items:center;gap:14px 18px}
.card-head h2{font-size:32px;line-height:1.1;margin:0;font-weight:700;letter-spacing:-.01em;word-break:break-word}
.kind{color:var(--muted);font-size:17px}
.badge{display:inline-flex;align-items:baseline;gap:8px;color:#fff;font-weight:800;font-size:22px;letter-spacing:.04em;padding:6px 14px;border-radius:6px}
.badge small{font-size:15px;font-weight:600;letter-spacing:0;opacity:.92}
.badge.leak{background:var(--leak)}.badge.held{background:var(--held)}.badge.harness{background:var(--harness)}
.who{font-size:26px;font-weight:600;margin:20px 0 4px;line-height:1.3}
.why{font-size:20px;color:var(--muted);margin:0 0 8px;max-width:64ch}
h3{font-size:16px;font-weight:700;color:var(--muted);margin:26px 0 10px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:8px 40px}
ul{margin:0;padding:0;list-style:none}
.controls li{font-size:20px;display:flex;align-items:center;gap:12px;padding:4px 0}
.ctl .mark{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;font-weight:800;color:#fff;flex:none}
.ctl.ok .mark{background:var(--held)}.ctl.bad .mark{background:var(--harness)}
.runs li{font-size:17px;padding:2px 0}
.runs a{color:var(--ink);text-decoration-color:var(--rule);text-underline-offset:3px}
.runs a:hover{text-decoration-color:var(--ink)}
.cr{margin:8px 0 0;font-weight:700;font-size:18px}
.hit{margin:0 0 14px}
.hit-where{font-size:17px;margin:0 0 6px;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline}
.hit-kind{font-weight:700}
.url{color:var(--muted);font-size:15px;word-break:break-all}
.snippet{margin:0;background:var(--ink);color:#E6EBF2;border-radius:10px;padding:16px 20px;font-size:17px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
mark.tok{background:var(--canary);color:var(--ink);font-weight:700;padding:1px 6px;border-radius:4px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.shot{margin:0}
.shot img{display:block;width:100%;border:1px solid var(--rule);border-radius:8px}
.shot figcaption{font-size:14px;color:var(--muted);margin-top:6px}
.shot.missing div{display:grid;place-items:center;height:140px;border:1px dashed var(--rule);border-radius:8px;color:var(--muted);font-size:15px}
.surface{margin:22px 0 0;font-size:17px;color:var(--muted)}
.surface code{color:var(--ink);background:var(--page);padding:2px 8px;border-radius:4px;font-size:15px}
.foot{display:flex;flex-wrap:wrap;gap:8px 36px;color:var(--muted);font-size:18px;padding:12px 0 0;border-top:1px solid var(--rule);margin-top:36px}
.foot b{color:var(--ink);font-variant-numeric:tabular-nums}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
a:focus-visible{outline:3px solid var(--ink);outline-offset:3px;border-radius:2px}
@media (max-width:700px){main{padding:28px 16px}.card{padding:22px 18px}.cols{grid-template-columns:1fr}.top .sub{font-size:20px}.who{font-size:22px}}
@media print{body{background:#fff}.card{break-inside:avoid;border:1px solid var(--rule)}}
`;

export function renderHtml(results: ProbeResult[], o: RenderOptions): string {
  const h = headline(results, o.boundaries);
  const t = tally(results);
  // Leaks first, then harness problems, then held: what needs attention is on top.
  const order: Record<VerdictGroup, number> = { LEAK: 0, HARNESS: 1, HELD: 2 };
  const sorted = [...results].sort((a, b) => order[verdictGroup(a.verdict)] - order[verdictGroup(b.verdict)]);
  const runTime = o.runTimeS ?? results.reduce((s, r) => s + r.kaneRuns.reduce((x, k) => x + k.durationS, 0), 0);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(h.title)} | notyours</title>
<link rel="icon" href="data:,">
<style>${CSS}</style>
</head>
<body>
<main>
<header class="top ${h.tone.toLowerCase()}">
  <p class="app">notyours isolation report</p>
  <h1>${esc(h.title)}</h1>
  <p class="sub">${esc(h.sub)}</p>
  <ul class="tally">
    <li class="leak"><b>${t.leaks}</b>${t.leaks === 1 ? 'leak' : 'leaks'}</li>
    <li class="held"><b>${t.held}</b>held</li>
    <li class="harness"><b>${t.harness}</b>harness</li>
  </ul>
</header>
${sorted.map((r) => card(r, o)).join('\n')}
<footer class="foot">
  <span>Run time <b>${fmtDuration(runTime)}</b></span>
  <span>Total Kane credits <b>${fmtCredits(t.credits)}</b></span>
  <span>Generated <b>${esc(o.generatedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z'))}</b></span>
</footer>
</main>
</body>
</html>
`;
}
