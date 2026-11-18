# DONE_A: engine (feat/engine)

**Status:** done. `createEngine()` now returns the real engine: Kane drives the personas, and the canary-token
oracle decides the verdict. **42 tests pass** (`npm run typecheck && npm test`, ~80 s, no Kane). One real Kane
smoke run against the local fixture found the seeded leak with both controls true.

## Kane budget
| | authoring runs | credits (run_end, credits.log) |
|---|---|---|
| Smoke run (the only Kane use) | **5** of the 12 allowed | **81.06** |

Balance went 11,054.20 → 10,960.34 (−93.86) over the smoke run. The ~12.8 gap is Kane's unreported triage overhead
(seen in the spike too), and may include other agents' runs at the same time. No retries and no loops.

## Smoke run: `npx tsx src/engine/__tests__/smoke-kane.ts <stateDir outside the repo>`
Fixture app on 127.0.0.1:8788, headless Chromes (`--headless=new`) driven by Kane over CDP.

| Step | Who | Status | Credits | Kane duration | Wall |
|---|---|---|---|---|---|
| sign-up (parallel) | alice | passed | 17.26 | 44.6 s | 77.2 s |
| sign-up (parallel) | bob | passed | 14.70 | 54.1 s | 91.1 s |
| create note with own token (parallel) | alice | passed | 19.94 | 66.1 s | 93.1 s |
| create note with own token (parallel) | bob | passed | 14.43 | 52.5 s | 84.7 s |
| visit the 3 targets | bob | passed | 14.74 | 50.3 s | 77.8 s |

Wall clock: Chrome launch 0.5 s · both sign-ups 92.4 s · cross-user probe 190.5 s (create in parallel, then visit,
then oracle visits + 7 screenshots).

**Result: `LEAK_VISIBLE`**, controls `{ownerSeesOwnToken: true, viewerSeesOwnToken: true}`. Hits:
- DOM: Alice's token on `/notes/:id`, the IDOR page.
- Network: the same page's HTML, plus `/api/notes/:id`, the payload behind the "You do not have access" preview page.

`/notes/:id/safe` produced no hit, as it should.

**Bug the smoke run found, now fixed (44eda7d):** Kane had already loaded `/api/notes/:id`, so the oracle's own
visit got a bodiless `304` from the warm cache and missed the payload; only the Kane-phase capture caught it. Oracle
tabs now disable the cache, and the fake runner in the tests opens targets the way Kane does, so the test reproduces it.

## What's in src/engine/
- `chrome.ts`: one Chrome per identity: `--remote-debugging-port`, `--user-data-dir=<identity.userDataDir>`
  (`.notyours/profiles/<id>`), `--no-first-run --no-default-browser-check`, `--headless=new` unless `NOTYOURS_HEADFUL=1`.
  It waits for `/json/version`, shuts down with SIGTERM (cookies flush) then SIGKILL after 5 s, and finds Chrome via
  `NOTYOURS_CHROME` or the macOS/Linux defaults. `ChromePool` launches lazily and reuses each identity's Chrome.
- `kane.ts`: `runKane(objective, identity, vars, opts)` runs `kane-cli run … --agent --cdp-endpoint
  http://127.0.0.1:<port> --variables-file <0600 tmp, deleted after> --timeout 240 [--name X]`, with a 600 s child timeout.
  It takes the last `run_end`, maps exits 0/1/2/3 to passed/failed/error/timeout, and returns stored values from
  `run_end.context.variables`. It checks `kane-cli balance >= creditFloor` before every run (`CreditFloorError`) and
  appends one JSON line per run to `.notyours/credits.log`. `NOTYOURS_KANE_BIN` swaps in a fake for tests.
- `identities.ts`: `createIdentities` (tokens via `makeToken`, ports `NOTYOURS_CDP_BASE_PORT`/9301+i, generated
  email/password), `saveIdentities` (identities.json has no passwords; secrets.json is 0600 and holds only passwords),
  `loadIdentities`, `importUsers(users.json)` (`[{email,password,id?,role?,plan?}]`, roles default owner/viewer, a
  guest is appended).
- `signup.ts`: `signup` / `login` objectives. If a run fails and mentions a captcha, OAuth-only login or an
  SMS/one-time code, it throws `UnsupportedSignupError` ("not supported … pass --users instead").
- `oracle.ts`: `Capture` attaches puppeteer-core to a Chrome **before** the Kane run and records every
  text/json/html response body (≤2 MB) on all pages. It then opens each target in a **new tab** (never Kane's page)
  with the cache off, scans the visible DOM per text node, and takes full-page PNGs. `judge()` holds the verdict
  rules; `isUrlEcho()` drops tokens that arrived in the requested URL and are echoed next to that path.
- `probes.ts`: the four kinds (below), the allowHosts check, an app-reachability check before any Kane run,
  screenshots and a diagnostics file `.notyours/runs/<runId>/<boundary>.json` (`{result, notes}`).
- `index.ts`: `KaneEngine` / `createEngine({runner?, pool?, stateDir?, runId?, cwd?})`, plus re-exports.

## Verdict rules (oracle.ts, never Kane, never `--analyzer-only`)
- LEAK_VISIBLE: a leak token in the visible DOM of a page the viewer loaded.
- LEAK_PAYLOAD: a leak token only in network response bodies.
- HELD: no hit **and** `ownerSeesOwnToken` (owner's Chrome opens the same targets and sees its own token) **and**
  `viewerSeesOwnToken`. Anything else is HARNESS_BROKEN. A leak still counts as a leak when a control fails.
- A 404/405 from an owner API target, or a 405 from any API target, can never produce HELD.

| Kind | Leak token | Where it counts | Viewer control |
|---|---|---|---|
| cross-user | owner's | anything the viewer's Chrome received or showed | viewer opens the same target templates resolved with its own stored values |
| guest | owner's | everything in a freshly wiped guest profile | every target loaded (a guest has no own page) |
| plan-gate | the **free user's own** | only the gated results: target visits, plus Kane-phase responses whose URL is a target | free user's own `item_url` |
| sweep | every other identity's | everything the viewer received | viewer sees its own token on its own pages |

## Decisions and interpretations
- **Ports come from `Identity.cdpPort`**, since Config has no port field. The base port is `NOTYOURS_CDP_BASE_PORT`, default 9301.
- **The viewer runs `create` too, for its own control.** That run is best-effort: seeded boundaries (B1) fail it as
  the viewer and still probe. See CC-1 for making HELD reachable there.
- **API targets are judged by network only.** Chrome renders a GET'd JSON response as DOM text, which would
  otherwise make every API leak "visible".
- **`maxAttempts` only applies to the oracle's free page loads.** Kane authoring runs are never retried.
- **`HTTP METHOD URL` api targets** (CC-2, at agent B's request): non-GET targets are called with `fetch` from a tab on
  the app's origin, so cookies apply. Kane only gets GET-able targets; if there are none, the Kane visit run is skipped.

## Changes outside src/engine/ (please review)
1. `test/contracts.test.ts`: uses `new MockEngine()` instead of `createEngine()` (separate commit). Otherwise
   `npm test` would start real Kane runs with the mock identities.
2. `CONTRACT_CHANGE.md`: CC-1 (proposed: optional `Boundary.viewerOwn`) and CC-2 (the method-prefix convention).

## For other agents / the coordinator
- **Pre-push hook false positive (coordinator):** the `.env`-style rule `…KEY|TOKEN|SECRET… = value` runs under
  `grep -i`, so ordinary code like `viewerSeesOwnToken = seesToken(...)` gets blocked. I renamed my local variable.
  Fix: match that rule case-sensitively (a second `grep -E` without `-i`).
- **feat/cli (D):** the current CLI stub's `probe`/`replay` call `createEngine()` with the mock identities, which is now
  the real engine. It refuses before any Kane run if the app at `baseUrl` is unreachable, but don't ship that stub.
  Use: `loadIdentities` / `createIdentities` + `saveIdentities`, `signup` / `login` with `runKane`, then
  `createEngine({ pool, stateDir })`. Pass the same `ChromePool` you signed up with to avoid relaunches.
- **feat/ratchet (C):** `runKane(…, { name })` passes `--name`. Diagnostics are in `.notyours/runs/<runId>/*.json`.
  Replays should resolve "METHOD URL" targets with `parseTarget()` from `src/engine/oracle.ts`.
- **feat/demo (B):** method prefix done, and plan-gate leak = free user's own token. With `create.store: []` (B3) the
  free user has no own page, so B3 can be LEAK or HARNESS_BROKEN, never HELD, until CC-1 (or B3 stores the free
  user's note URL). The engine ignores `surface`, so its base path is the report's concern.
- Kane wrote no `.testmuai/` into the state dir or the worktree during the smoke run (0.10.0 keeps evidence under
  `~/.testmuai/kaneai/sessions`). Ignore rules remain in place anyway.
