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

### CC-1: replay-only oracle on Engine
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
- **Status:** proposed
