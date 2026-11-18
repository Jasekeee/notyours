// The four probe kinds. Kane drives the personas; the oracle (oracle.ts) decides.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ProbeResultSchema } from '../schemas.js';
import type { Boundary, Config, Identity, KaneRun, ProbeResult } from '../types.js';
import type { ChromePool } from './chrome.js';
import { byId } from './identities.js';
import type { KaneOutcome, KaneRunner, KaneVars } from './kane.js';
import { Capture, judge, seesToken, type NetRecord, type Visit } from './oracle.js';

export interface ProbeDeps {
  runner: KaneRunner;
  pool: ChromePool;
  stateDir: string;
  /** Where screenshots + diagnostics go: <stateDir>/runs/<ts>/ by default. */
  runDir: string;
  cwd?: string;
}

type Ctx = Record<string, string>;

export function resolveTemplate(s: string, ctx: Ctx): string {
  return s.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k: string) => ctx[k] ?? m);
}

export function assertAllowed(url: string, cfg: Config): void {
  let host: string;
  try { host = new URL(url).hostname; } catch { throw new Error(`Not a URL: ${url}`); }
  if (!cfg.allowHosts.includes(host)) {
    throw new Error(`Refusing to probe ${url}: host "${host}" is not in allowHosts (${cfg.allowHosts.join(', ')}). notyours only tests your own app.`);
  }
}

/** Any HTTP answer is fine; no answer means every Kane run would be wasted credits. */
export async function assertReachable(baseUrl: string): Promise<void> {
  try {
    await fetch(baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new Error(`App not reachable at ${baseUrl}. Start it first; no Kane runs were started.`);
  }
}

/** Kane objective that just opens pages (no sign-in/out, no forms). */
export function visitObjective(n: number): string {
  const list = Array.from({ length: n }, (_, i) => `{{t${i + 1}}}`);
  return n === 1
    ? `Go to ${list[0]} and wait for the page to finish loading. Do not sign in, sign out or submit any form.`
    : `Open these pages one after another and wait for each to finish loading: ${list.join(', ')}. Do not sign in, sign out or submit any form.`;
}

interface Targets { ui: string[]; api: string[] }

function both<A, B>(parallel: boolean, a: () => Promise<A>, b: () => Promise<B>): Promise<[A, B]> {
  return parallel ? Promise.all([a(), b()]) : a().then(async (x) => [x, await b()] as [A, B]);
}

export async function probe(b: Boundary, ids: Identity[], cfg: Config, deps: ProbeDeps): Promise<ProbeResult> {
  const ts = new Date().toISOString();
  const owner = byId(ids, b.owner);
  const viewer = byId(ids, b.viewer);
  if (b.kind === 'plan-gate' && !b.proAction) throw new Error(`Boundary ${b.id}: plan-gate needs proAction.`);
  assertAllowed(cfg.baseUrl, cfg);
  await assertReachable(cfg.baseUrl);
  mkdirSync(deps.runDir, { recursive: true });

  const runs: KaneRun[] = [];
  const notes: string[] = [];
  const captures: Capture[] = [];
  const kopts = { cfg, stateDir: deps.stateDir, ...(deps.cwd ? { cwd: deps.cwd } : {}) };
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  const ctxOf = (i: Identity, stored: Ctx = {}): Ctx => ({ base_url: baseUrl, token: i.token, ...(i.email ? { email: i.email } : {}), ...stored });
  const kane = async (objective: string, who: Identity, vars: KaneVars): Promise<KaneOutcome> => {
    const out = await deps.runner(objective, who, vars, kopts);
    runs.push(out.run);
    return out;
  };

  const finish = (verdict: ProbeResult['verdict'], extra: Partial<ProbeResult> = {}): ProbeResult => {
    const result = ProbeResultSchema.parse({
      boundaryId: b.id, verdict, controls: { ownerSeesOwnToken: false, viewerSeesOwnToken: false },
      hits: [], screenshots: [], kaneRuns: runs, ts, ...extra,
    });
    writeFileSync(join(deps.runDir, `${b.id}.json`), `${JSON.stringify({ result, notes }, null, 2)}\n`);
    return result;
  };

  try {
    // A guest starts from a wiped profile: no cookies, no login.
    if (b.kind === 'guest') await wipeProfile(viewer, deps);
    const [oc, vc] = await Promise.all([deps.pool.get(owner), deps.pool.get(viewer)]);

    // Phase 1: plant data. Owner always; viewer too (its own token is the positive control), except guests.
    const createVars = (i: Identity): KaneVars => ctxOf(i);
    const [oCreate, vCreate] = await both(
      cfg.parallel,
      () => kane(b.create.objective, owner, createVars(owner)),
      () => (b.kind === 'guest' ? Promise.resolve(undefined) : kane(b.create.objective, viewer, createVars(viewer))),
    );
    for (const [who, out] of [['owner', oCreate], ['viewer', vCreate]] as const) {
      if (!out) continue;
      const missing = b.create.store.filter((k) => !out.stored[k]);
      if (out.run.status !== 'passed' || missing.length) {
        notes.push(`${who} create run ${out.run.status}${missing.length ? `; did not store ${missing.join(', ')}` : ''}`);
      }
    }
    if (notes.length) return finish('HARNESS_BROKEN');

    const ownerCtx = ctxOf(owner, oCreate.stored);
    const viewerCtx = ctxOf(viewer, vCreate?.stored ?? {});
    const resolveAll = (ctx: Ctx): Targets => ({ ui: b.targets.ui.map((u) => resolveTemplate(u, ctx)), api: b.targets.api.map((u) => resolveTemplate(u, ctx)) });
    const leakCtx = b.kind === 'cross-user' || b.kind === 'guest' ? ownerCtx : viewerCtx;
    const leakTargets = resolveAll(leakCtx);
    const ownerTargets = resolveAll(ownerCtx);
    const all = [...leakTargets.ui, ...leakTargets.api, ...ownerTargets.ui, ...ownerTargets.api];
    const unresolved = all.filter((u) => /\{\{/.test(u));
    if (unresolved.length) { notes.push(`unresolved target templates: ${unresolved.join(', ')}`); return finish('HARNESS_BROKEN'); }
    for (const u of all) assertAllowed(u, cfg);
    if (!leakTargets.ui.length && !leakTargets.api.length) { notes.push('boundary has no targets'); return finish('HARNESS_BROKEN'); }

    // Phase 2: the viewer acts (visit, or the pro action) with live capture attached BEFORE its Kane run.
    const vcapLive = cfg.liveCapture ? await Capture.attach(vc.endpoint) : undefined;
    if (vcapLive) captures.push(vcapLive);
    const ocapLive = cfg.liveCapture && b.kind === 'plan-gate' ? await Capture.attach(oc.endpoint) : undefined;
    if (ocapLive) captures.push(ocapLive);
    const visitVars = (ctx: Ctx, t: Targets): KaneVars =>
      ({ ...ctx, ...Object.fromEntries([...t.ui, ...t.api].map((u, i) => [`t${i + 1}`, u])) });
    if (b.kind === 'plan-gate') {
      const proAction = b.proAction!.objective;
      await both(cfg.parallel, () => kane(proAction, owner, ownerCtx), () => kane(proAction, viewer, viewerCtx));
    } else {
      const n = leakTargets.ui.length + leakTargets.api.length;
      await kane(visitObjective(n), viewer, visitVars(leakCtx, leakTargets));
    }

    // Phase 3: the oracle opens every target itself (new tabs) and checks the positive controls.
    const attach = async (endpoint: string) => { const c = await Capture.attach(endpoint); captures.push(c); return c; };
    const vcap: Capture = vcapLive ?? (await attach(vc.endpoint));
    const ocap: Capture = ocapLive ?? (await attach(oc.endpoint));
    const visitAll = async (cap: Capture, t: Targets, prefix: string): Promise<Visit[]> => {
      const out: Visit[] = [];
      for (const [i, u] of t.ui.entries()) out.push(await cap.visit(u, `${prefix}:ui${i}`, 'ui', cfg.maxAttempts));
      for (const [i, u] of t.api.entries()) out.push(await cap.visit(u, `${prefix}:api${i}`, 'api', cfg.maxAttempts));
      return out;
    };
    const leakVisits = await visitAll(vcap, leakTargets, 'leak');
    const ownerVisits = await visitAll(ocap, ownerTargets, 'octl');
    let viewerCtlVisits: Visit[] = [];
    let viewerOk: boolean;
    if (b.kind === 'guest') {
      viewerOk = leakVisits.every((v) => v.status > 0 && !v.error);
      if (!viewerOk) notes.push('guest browser could not load every target');
    } else if (b.kind === 'sweep') {
      viewerOk = seesToken(viewer.token, leakVisits, vcap.records);
    } else if (b.kind === 'plan-gate') {
      const own = viewerCtx.item_url ?? b.create.store.map((k) => viewerCtx[k]).find((v) => v?.startsWith('http'));
      if (own) { assertAllowed(own, cfg); viewerCtlVisits = [await vcap.visit(own, 'vctl:ui0', 'ui', cfg.maxAttempts)]; }
      viewerOk = seesToken(viewer.token, viewerCtlVisits, vcap.records);
    } else {
      viewerCtlVisits = await visitAll(vcap, resolveAll(viewerCtx), 'vctl');
      viewerOk = seesToken(viewer.token, viewerCtlVisits, vcap.records);
    }
    const ownerSeesOwnToken = seesToken(owner.token, ownerVisits, ocap.records);
    if (!ownerSeesOwnToken) notes.push('owner did not see its own token on the targets');
    if (!viewerOk && b.kind !== 'guest') notes.push('viewer did not see its own token on its own page (not signed in?)');

    // Which observations count. plan-gate: only the gated result (targets), since the free user's own pages
    // legitimately show its token. Everything else: anything the viewer's browser received.
    let judgedVisits: Visit[];
    let judgedRecords: NetRecord[];
    const leakTokens = new Set<string>();
    if (b.kind === 'plan-gate') {
      leakTokens.add(viewer.token);
      judgedVisits = leakVisits;
      const targetUrls = new Set([...leakTargets.ui, ...leakTargets.api]);
      judgedRecords = vcap.records.filter((r) => r.tag.startsWith('leak:') || (r.tag === 'kane' && targetUrls.has(r.url)));
    } else {
      if (b.kind === 'sweep') for (const i of ids) { if (i.id !== viewer.id) leakTokens.add(i.token); }
      else leakTokens.add(owner.token);
      judgedVisits = [...leakVisits, ...viewerCtlVisits];
      judgedRecords = vcap.records;
    }
    await vcap.flush();
    const { verdict, hits } = judge(leakTokens, judgedVisits, judgedRecords, { ownerSeesOwnToken, viewerSeesOwnToken: viewerOk });

    // Screenshots: every hit page and every control page.
    const hitTags = new Set(judgedRecords.filter((r) => r.tokens.some((o) => !o.echo && leakTokens.has(o.token))).map((r) => r.tag));
    const isHitPage = (v: Visit) => hitTags.has(v.tag) || v.dom.some((o) => !o.echo && leakTokens.has(o.token));
    const screenshots: string[] = [];
    const shoot = async (v: Visit, who: string) => {
      const file = join(deps.runDir, `${b.id}-${who}-${v.tag.replace(/:/g, '-')}.png`);
      try { await v.page.screenshot({ path: file as `${string}.png`, fullPage: true }); screenshots.push(file); } catch { /* page gone */ }
    };
    for (const v of judgedVisits) if (isHitPage(v) || v.tag.startsWith('vctl')) await shoot(v, viewer.id);
    for (const v of ownerVisits) await shoot(v, owner.id);
    for (const v of [...leakVisits, ...viewerCtlVisits, ...ownerVisits]) await v.page.close().catch(() => {});

    return finish(verdict, { controls: { ownerSeesOwnToken, viewerSeesOwnToken: viewerOk }, hits, screenshots });
  } catch (e) {
    notes.push(`error: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    await Promise.all(captures.map((c) => c.detach().catch(() => {})));
  }
}

async function wipeProfile(identity: Identity, deps: ProbeDeps): Promise<void> {
  const profiles = resolve(deps.stateDir, 'profiles');
  const dir = resolve(identity.userDataDir);
  const rel = relative(profiles, dir);
  if (!rel || rel.startsWith('..')) throw new Error(`Refusing to wipe ${dir}: guest profiles must live under ${profiles}.`);
  await deps.pool.close(identity.id);
  rmSync(dir, { recursive: true, force: true });
}
