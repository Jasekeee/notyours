# Contract change requests

`src/types.ts` and `src/schemas.ts` are frozen. To change them, add a request below and stop.
Only the coordinator applies approved changes, on `main`, and every branch then rebases.

## Template

### CC-<n>: <short title>
- **Requested by:** <branch, e.g. feat/engine>
- **Date:** <YYYY-MM-DD>
- **File / symbol:** <e.g. src/schemas.ts ProbeResultSchema.hits>
- **Change:** <exact field/type change>
- **Why:** <what breaks or is impossible without it>
- **Impact on other branches:** <who must adapt, and how>
- **Status:** proposed | approved | rejected | applied (<commit>)

## Requests

### CC-1: explicit viewer-own targets for the positive control
- **Requested by:** feat/engine (agent A)
- **Date:** 2026-11-18
- **File / symbol:** `src/schemas.ts` `BoundarySchema`
- **Change:** add optional `viewerOwn: z.object({ ui: z.array(z.string()), api: z.array(z.string()) }).optional()`:
  pages where the viewer must see its OWN token (e.g. `["http://127.0.0.1:3077/notes/1002"]`).
- **Why:** HELD needs `controls.viewerSeesOwnToken`. Today the engine gets the viewer's own page by running
  `create.objective` as the viewer too and resolving the targets with the viewer's stored values. Seeded boundaries
  (demo B1/B3: fixed URLs like `/notes/1001`, a create objective that only confirms the owner's seed) can't do that:
  the viewer's create run fails (costs ~30 credits for nothing), so on a *fixed* app those boundaries can only ever read
  HARNESS_BROKEN, never HELD. Leaks are still detected correctly.
- **Engine behaviour if approved:** when `viewerOwn` is set, skip the viewer's create run (saves one authoring run per
  probe) and use `viewerOwn` for the viewer control. Without it, behaviour stays as now (viewer create is best-effort).
- **Impact on other branches:** additive and optional. feat/demo can add `viewerOwn` to B1/B3; feat/ratchet/feat/cli
  only pass it through.
- **Status:** approved (2026-11-18); applied on feat/engine (schema + engine + tests)

### CC-2 (convention, no schema change): HTTP method prefix in `targets.api`
- **Requested by:** feat/demo (agent B), implemented in feat/engine
- **Date:** 2026-11-18
- **Change:** a `targets.api` entry may be `"METHOD URL"` (GET/POST/PUT/PATCH/DELETE), default GET, e.g.
  `"POST http://127.0.0.1:3077/api/export"`. The engine calls non-GET targets with `fetch` from the identity's Chrome.
  A 404/405 on such a call is never HELD. Consider documenting it on `BoundarySchema.targets.api`.
- **Impact on other branches:** feat/ratchet replays must use `parseTarget()` from `src/engine/oracle.ts` (or the same rule).
- **Status:** implemented as a convention in feat/engine (f80be6e); schema comment pending approval

### CC-3 (was feat/ratchet's "CC-1"): replay-only oracle on Engine
- **Requested by:** feat/ratchet
- **Date:** 2026-11-18
- **File / symbol:** src/types.ts `Engine`
- **Change:** add an optional method
  `judge?(b: Boundary, ids: Identity[], cfg: Config, replays: KaneRun[]): Promise<ProbeResult>`.
  It runs only the canary-token oracle (live DOM/network capture + positive controls) on the identities'
  Chromes after the ratchet has replayed the recorded tests. It does not run authoring.
- **Why:** `Ratchet.replay()` must "call the engine oracle", but the only Engine method, `runBoundary()`,
  re-runs the whole probe, including the owner's create objective. On the real engine that is an authoring
  run (~16 credits) on every Stop hook, which breaks "replays are free". Until this lands, the ratchet
  (`src/ratchet/replay.ts` `engineOracle`) duck-types `engine.judge` and otherwise calls
  `runBoundary({ ...b, locked: true }, ...)`. **The real engine must treat `locked: true` as "judge only,
  never author"**, or the Stop hook will spend credits.
- **Impact on other branches:** feat/engine implements `judge` (or honours `locked: true` in runBoundary).
  Nobody else changes; the method is optional, so MockEngine stays valid.
- **Status:** resolved at integration without a frozen-interface change: `KaneEngine.judge()` exists on the real
  engine (duck-typed by `engineOracle()`), so `Engine` stays as is. `runBoundary` with `locked: true` never authors.
