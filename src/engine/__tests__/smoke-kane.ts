// Real Kane smoke run against the local fixture. COSTS CREDITS: exactly 5 authoring runs, no retries.
//   npx tsx src/engine/__tests__/smoke-kane.ts <stateDir outside the repo>
// 2 sign-ups (parallel) + 1 cross-user probe (owner create + viewer create in parallel, viewer visit).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { ConfigSchema } from '../../schemas.js';
import type { Boundary } from '../../types.js';
import { ChromePool } from '../chrome.js';
import { byId, createIdentities, saveIdentities } from '../identities.js';
import { KaneEngine } from '../index.js';
import { runKane } from '../kane.js';
import { signup } from '../signup.js';
import { startFixture } from './fixture-app.js';

const stateDir = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: smoke-kane.ts <stateDir>');
mkdirSync(stateDir, { recursive: true });
const t = (t0: number) => Number(((Date.now() - t0) / 1000).toFixed(1));
const timings: Record<string, number> = {};

const app = await startFixture(Number(process.env.SMOKE_PORT ?? 8788));
const cfg = ConfigSchema.parse({ baseUrl: app.url });
const ids = createIdentities([{ id: 'alice', role: 'owner', plan: null }, { id: 'bob', role: 'viewer', plan: null }], { stateDir, basePort: 9351 });
saveIdentities(stateDir, ids);
const pool = new ChromePool();
const kopts = { cfg, stateDir, cwd: stateDir };

try {
  // 1+2: sign up both personas (parallel).
  let t0 = Date.now();
  await Promise.all(ids.map((i) => pool.get(i)));
  timings.chromeLaunchS = t(t0);
  t0 = Date.now();
  const ups = await Promise.all(ids.map((i) => signup(i, runKane, kopts)));
  timings.signupsWallS = t(t0);
  for (const [i, u] of ups.entries()) console.log(`signup ${ids[i]!.id}: ${u.run.status} credits=${u.run.creditsConsumed.toFixed(2)} duration=${u.run.durationS}s`);
  if (ups.some((u) => u.run.status !== 'passed')) throw new Error('A sign-up failed; stopping before the probe (no further credits).');

  // Free check: is each Chrome really signed in? (Otherwise the probe would waste 3 runs.)
  for (const i of ids) {
    const b = await puppeteer.connect({ browserURL: (await pool.get(i)).endpoint, defaultViewport: null });
    const p = await b.newPage();
    await p.goto(`${app.url}/notes`);
    const signedIn = (await p.content()).includes(i.email!);
    await p.close();
    await b.disconnect();
    console.log(`signed-in check ${i.id}: ${signedIn}`);
    if (!signedIn) throw new Error(`${i.id} is not signed in after sign-up; stopping before the probe.`);
  }

  // 3+4+5: cross-user probe.
  const boundary: Boundary = {
    id: 'notes-cross-user',
    kind: 'cross-user',
    owner: 'alice',
    viewer: 'bob',
    create: {
      objective: "Go to {{base_url}}/notes/new, create a note with title 'Smoke note' and body '{{token}}', save it, then store the current page URL as 'item_url'",
      store: ['item_url'],
    },
    targets: { ui: ['{{item_url}}', '{{item_url}}/preview', '{{item_url}}/safe'], api: [] },
    expect: 'denied',
    surface: ['src/engine/__tests__/fixture-app.ts'],
  };
  t0 = Date.now();
  const result = await new KaneEngine({ pool, stateDir, cwd: stateDir, runId: 'smoke' }).runBoundary(boundary, ids, cfg);
  timings.probeWallS = t(t0);

  const alice = byId(ids, 'alice');
  console.log(`verdict: ${result.verdict}`);
  console.log(`controls: ${JSON.stringify(result.controls)}`);
  for (const h of result.hits) console.log(`hit: ${h.where} ${h.token === alice.token ? 'alice-token' : h.token} ${h.url}`);
  for (const r of result.kaneRuns) console.log(`run ${r.identity}: ${r.status} credits=${r.creditsConsumed.toFixed(2)} duration=${r.durationS}s`);
  console.log(`screenshots: ${result.screenshots.length}`);
  writeFileSync(join(stateDir, 'smoke-summary.json'), `${JSON.stringify({ timings, signups: ups.map((u) => u.run), result }, null, 2)}\n`);
  console.log(`timings: ${JSON.stringify(timings)}`);
} finally {
  await pool.closeAll();
  await app.close();
}
