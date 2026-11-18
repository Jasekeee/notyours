// The four probe kinds. Kane drives the personas; the oracle (oracle.ts) decides.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ProbeResultSchema } from '../schemas.js';
import type { Boundary, Config, Identity, KaneRun, ProbeResult } from '../types.js';
import type { ChromePool } from './chrome.js';
import { byId } from './identities.js';
import type { KaneOutcome, KaneRunner, KaneVars } from './kane.js';
import { Capture, judge, parseTarget, seesToken, type NetRecord, type Visit } from './oracle.js';

export interface ProbeDeps {
  runner: KaneRunner;
  pool: ChromePool;
  stateDir: string;
  /** Where screenshots + diagnostics go: <stateDir>/runs/<ts>/ by default. */
  runDir: string;
  cwd?: string;
  /**
   * Judge mode (ratchet replay): the recorded Kane tests were just replayed, so no Kane run happens here;
   * only the oracle (targets + positive controls). Stored values come from the replays' finalState.
   */
  replays?: KaneRun[];
}

/** Recording name the ratchet adopts on lock: `<boundary>_<identity>` (see src/ratchet/paths.ts testName). */
export const recordingName = (boundaryId: string, identityId: string) => `${boundaryId}_${identityId}`;

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

/**
 * Kane objective that just opens pages (no sign-in/out, no forms). The URLs are written out literally:
 * kane-cli needs a start URL it can see in the objective (a {{t1}} placeholder fails with "No start URL").
 * They are host-gated targets, so they are safe to inline.
 */
export function visitObjective(urls: string[]): string {
  return urls.length === 1
    ? `Go to ${urls[0]} and wait for the page to finish loading. Do not sign in, sign out or submit any form.`
    : `Open these pages one after another and wait for each to finish loading: ${urls.join(', ')}. Do not sign in, sign out or submit any form.`;
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
  const judgeOnly = deps.replays !== undefined;
  const kane = async (objective: string, who: Identity, vars: KaneVars, name?: string): Promise<KaneOutcome> => {
    if (judgeOnly) throw new Error('internal: no Kane runs in judge mode');
    const out = await deps.runner(objective, who, vars, name ? { ...kopts, name: recordingName(b.id, who.id) } : kopts);
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
    // (In judge mode the ratchet wiped it before replaying the guest's recorded visit.)
    if (b.kind === 'guest' && !judgeOnly) await wipeProfile(viewer, deps);
    const [oc, vc] = await Promise.all([deps.pool.get(owner), deps.pool.get(viewer)]);

    // Phase 1: plant data. Owner always; viewer too (its own token is the positive control), except guests.
    const createVars = (i: Identity): KaneVars => ctxOf(i);
    const fromReplays = (i: Identity): KaneOutcome => {
      const stored: Record<string, string> = {};
      for (const r of deps.replays ?? []) {
        if (r.identity !== i.id) continue;
        for (const [k, v] of Object.entries(r.finalState)) if (typeof v === 'string' && v) stored[k] = v;
      }
      return { run: { objective: 'replay', identity: i.id, status: 'passed', exitCode: 0, finalState: stored, creditsConsumed: 0, durationS: 0 }, stored, text: '' };
    };
    // Judge mode: the owner's stored values come from its replay. Fixed-URL boundaries store nothing they need.
    const [oCreate, vCreate] = judgeOnly ? [fromReplays(owner), undefined] : await both(
      cfg.parallel,
      () => kane(b.create.objective, owner, createVars(owner), 'record'),
      // CC-1: with viewerOwn the viewer's control pages are given, so its create run is skipped (one run saved).
      () => (b.kind === 'guest' || b.viewerOwn ? Promise.resolve(undefined) : kane(b.create.objective, viewer, createVars(viewer))),
    );
    // The owner's create run is required. The viewer's is best-effort: it only feeds the viewer's positive
    // control, and seeded boundaries (fixed owner URLs) legitimately fail it as the viewer.
    const createProblem = (out: KaneOutcome) => {
      const missing = b.create.store.filter((k) => !out.stored[k]);
      return out.run.status !== 'passed' || missing.length ? `${out.run.status}${missing.length ? `; did not store ${missing.join(', ')}` : ''}` : undefined;
    };
    const ownerProblem = judgeOnly ? undefined : createProblem(oCreate);
    if (ownerProblem) { notes.push(`owner create run ${ownerProblem}`); return finish('HARNESS_BROKEN'); }
    const viewerProblem = vCreate && createProblem(vCreate);
    if (viewerProblem) notes.push(`viewer create run ${viewerProblem} (viewer control may be unavailable)`);

    const ownerCtx = ctxOf(owner, oCreate.stored);
    const viewerCtx = ctxOf(viewer, vCreate && !viewerProblem ? vCreate.stored : {});
    const resolveAll = (ctx: Ctx): Targets => ({ ui: b.targets.ui.map((u) => resolveTemplate(u, ctx)), api: b.targets.api.map((u) => resolveTemplate(u, ctx)) });
    const leakCtx = b.kind === 'cross-user' || b.kind === 'guest' ? ownerCtx : viewerCtx;
    const leakTargets = resolveAll(leakCtx);
    const ownerTargets = resolveAll(ownerCtx);
    const all = [...leakTargets.ui, ...leakTargets.api, ...ownerTargets.ui, ...ownerTargets.api];
    const unresolved = all.filter((u) => /\{\{/.test(u));
    if (unresolved.length) { notes.push(`unresolved target templates: ${unresolved.join(', ')}`); return finish('HARNESS_BROKEN'); }
    for (const u of all) assertAllowed(parseTarget(u).url, cfg);
    if (!leakTargets.ui.length && !leakTargets.api.length) { notes.push('boundary has no targets'); return finish('HARNESS_BROKEN'); }

    // Phase 2: the viewer acts (visit, or the pro action) with live capture attached BEFORE its Kane run.
    const vcapLive = cfg.liveCapture ? await Capture.attach(vc.endpoint) : undefined;
    if (vcapLive) captures.push(vcapLive);
    const ocapLive = cfg.liveCapture && b.kind === 'plan-gate' ? await Capture.attach(oc.endpoint) : undefined;
    if (ocapLive) captures.push(ocapLive);
    // Kane can only open pages: give it the ui targets and GET api targets ("POST …" ones are the oracle's job).
    const kaneUrls = (t: Targets) => [...t.ui, ...t.api.filter((u) => parseTarget(u).method === 'GET').map((u) => parseTarget(u).url)];
    const urls = kaneUrls(leakTargets);
    if (judgeOnly) {
      /* the recorded runs were just replayed by the ratchet */
    } else if (b.kind === 'plan-gate') {
      // Both try the pro action (the free user's attempt is expected to be refused in the UI: Kane may
      // report a paywall). Neither is the replay recording: a refused attempt would replay as "failed".
      const proAction = b.proAction!.objective;
      await both(cfg.parallel, () => kane(proAction, owner, ownerCtx), () => kane(proAction, viewer, viewerCtx));
      // The free user's recording is a plain visit of the gated GET targets; the oracle makes the
      // non-GET calls itself. Replays of this visit pass whether or not the gate holds.
      if (urls.length) await kane(visitObjective(urls), viewer, viewerCtx, 'record');
    } else if (urls.length) {
      await kane(visitObjective(urls), viewer, leakCtx, 'record');
    } else {
      notes.push('no GET targets: skipped the Kane visit run (the oracle still calls every target)');
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
    if (b.viewerOwn && b.kind === 'guest') notes.push('viewerOwn is ignored for guest boundaries (a guest has no own page)');
    if (b.viewerOwn && b.kind !== 'guest') {
      // CC-1: explicit pages where the viewer must see its own token.
      const own = { ui: b.viewerOwn.ui.map((u) => resolveTemplate(u, viewerCtx)), api: b.viewerOwn.api.map((u) => resolveTemplate(u, viewerCtx)) };
      const unresolvedOwn = [...own.ui, ...own.api].filter((u) => /\{\{/.test(u));
      if (unresolvedOwn.length) notes.push(`unresolved viewerOwn templates: ${unresolvedOwn.join(', ')}`);
      const ready = { ui: own.ui.filter((u) => !/\{\{/.test(u)), api: own.api.filter((u) => !/\{\{/.test(u)) };
      for (const u of [...ready.ui, ...ready.api]) assertAllowed(parseTarget(u).url, cfg);
      viewerCtlVisits = await visitAll(vcap, ready, 'vctl');
      viewerOk = seesToken(viewer.token, viewerCtlVisits, vcap.records);
    } else if (b.kind === 'guest') {
      viewerOk = leakVisits.every((v) => v.status > 0 && !v.error);
      if (!viewerOk) notes.push('guest browser could not load every target');
    } else if (b.kind === 'sweep') {
      viewerOk = seesToken(viewer.token, leakVisits, vcap.records);
    } else if (b.kind === 'plan-gate') {
      const own = viewerCtx.item_url ?? b.create.store.map((k) => viewerCtx[k]).find((v) => v?.startsWith('http'));
      if (own) { assertAllowed(own, cfg); viewerCtlVisits = [await vcap.visit(own, 'vctl:ui0', 'ui', cfg.maxAttempts)]; }
      viewerOk = seesToken(viewer.token, viewerCtlVisits, vcap.records);
    } else {
      const own = resolveAll(viewerCtx);
      const ready = { ui: own.ui.filter((u) => !/\{\{/.test(u)), api: own.api.filter((u) => !/\{\{/.test(u)) };
      for (const u of [...ready.ui, ...ready.api]) assertAllowed(parseTarget(u).url, cfg);
      viewerCtlVisits = await visitAll(vcap, ready, 'vctl');
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
      const targetUrls = new Set([...leakTargets.ui, ...leakTargets.api.map((u) => parseTarget(u).url)]);
      judgedRecords = vcap.records.filter((r) => r.tag.startsWith('leak:') || (r.tag === 'kane' && targetUrls.has(r.url)));
    } else {
      if (b.kind === 'sweep') for (const i of ids) { if (i.id !== viewer.id) leakTokens.add(i.token); }
      else leakTokens.add(owner.token);
      judgedVisits = [...leakVisits, ...viewerCtlVisits];
      judgedRecords = vcap.records;
    }
    await vcap.flush();
    const judged = judge(leakTokens, judgedVisits, judgedRecords, { ownerSeesOwnToken, viewerSeesOwnToken: viewerOk });
    const { hits } = judged;
    let { verdict } = judged;
    // A 404/405 on an api target means the call never reached the endpoint (wrong method or path): never HELD.
    const misfired = [...ownerVisits.filter((v) => v.kind === 'api' && (v.status === 404 || v.status === 405)),
      ...leakVisits.filter((v) => v.kind === 'api' && v.status === 405)];
    for (const v of misfired) notes.push(`api target "${v.url}" answered ${v.status}: wrong method or path? (never counted as HELD)`);
    if (verdict === 'HELD' && misfired.length) verdict = 'HARNESS_BROKEN';

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

export async function wipeProfile(identity: Identity, deps: Pick<ProbeDeps, 'stateDir' | 'pool'>): Promise<void> {
  const profiles = resolve(deps.stateDir, 'profiles');
  const dir = resolve(identity.userDataDir);
  const rel = relative(profiles, dir);
  if (!rel || rel.startsWith('..')) throw new Error(`Refusing to wipe ${dir}: guest profiles must live under ${profiles}.`);
  await deps.pool.close(identity.id);
  rmSync(dir, { recursive: true, force: true });
}
