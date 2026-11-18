# End-to-end on Jotter

`node dist/cli/index.js demo` against the seeded Jotter app (bugs #1–#3 present), real Kane (kane-cli 0.10.0),
headless Chrome per persona, 2026-11-18. Work dir: a fresh copy of `demo/`; fixed tokens from
`demo/.notyours/identities.json`.

## Run 1: authoring (commit dce76d9)

**All four verdicts match the expectations.**

| Boundary | Kind | Expected | Verdict | Controls (owner / viewer) | Hits | Kane runs (status: credits) | Credits | Elapsed |
|---|---|---|---|---|---|---|---|---|
| B1 `b1-notes-cross-user` | cross-user | LEAK | **LEAK_VISIBLE** | ✓ / ✓ | Alice's token in the DOM of `/notes/1001`, and in network bodies of `/notes/1001` and `/api/notes/1001` | alice create: passed 14.5 · bob visit: failed 0 | 14.5 | 279.2 s* |
| B2 `b2-notes-guest` | guest | HELD | **HELD** | ✓ / ✓ (guest loads every target) | none | alice create: passed 11.2 · guest visit: failed 0 | 11.2 | 121.2 s |
| B3 `b3-export-plan-gate` | plan-gate | LEAK | **LEAK_PAYLOAD** | ✓ / ✓ | **Bob's own** token in the `POST /api/export` response (a free user got the Pro export) | alice create: passed 13.6 · alice pro action: passed 7.3 · bob pro action: failed (`blocker.paywall`) 8.9 | 29.8 | 92.8 s |
| B4 `b4-bob-sweep` | sweep | HELD | **HELD** | ✓ / ✓ | none | alice create: passed 5.9 · bob visit: failed 0 | 5.9 | 88.8 s |

\* B1's time includes both personas' first logins (recorded once, in parallel: alice 14.3, bob 17.7 credits).

- **Total:** 9 m 44 s wall clock; 11 authoring runs (2 logins + 9 probe runs).
- **Credits:** balance 10,960.34 → 10,847.00 = **113.34**. run_end reported 93.39; the gap (~20) is kane-cli's
  unreported triage on failed runs.
- **Locked by the run:** B2 and B4, by adopting the probe's recordings (0 extra runs). The demo locks HELD results only.
- **Report:** `.notyours/runs/<ts>/report.html` in the work dir.

### What run 1 found (fixed in f3f04f8, before step 4)
1. **The viewer's Kane visit runs failed:** `No start URL provided`. The visit objective used `{{t1}}` placeholders and
   kane-cli needs a URL it can see in the objective. **The verdicts are unaffected:** the oracle opens every target in
   the viewer's own Chrome itself, and never uses Kane's result. Visit objectives now inline the host-gated URLs.
2. **B3's free-user pro action "failed" with `blocker.paywall`.** That's correct: the UI hides Export from free users,
   and the leak is in the API. But a recording of a refused attempt would replay as "failed" (YELLOW). The plan-gate
   viewer's recording is now a plain visit of the GET targets; the oracle makes the `POST /api/export` call itself.
3. **`lock` adopted the failed visit recordings** for B2 and B4. It now adopts only recordings whose runs passed.
4. **Recorded logins contain the typed password.** kane-cli writes the value into the frontmatter (with `secret: true`).
   They now live in the persona's own Chrome profile dir (guarded like `secrets.json`, gitignored, and in the Claude
   Code permission deny list), and no recording is ever committed (see step 4).
5. The report described B3 as "Alice's token". For a plan-gate it now says the Pro-only result (with Bob's own data)
   reached Bob.

Before run 1, a dry run of the gate (free) caught one more: the CLI host gate rejected B3's `"POST <url>"` API target
(CC-2). Fixed in dce76d9; that attempt stopped before any Kane run (0 credits).

## Step 4: the ratchet (scratch copy of demo/, bugs #1–#3 fixed, then restored)

Fixes in the scratch copy: `AND n.owner_id = ?` on `/notes/:id` and `/api/notes/:id` (#1, #2); a
`plan !== 'pro'` → 402 check on `POST /api/export` (#3). Checked with curl as Bob: 404 / 404 / 402.

### Proving on the fixed app (`notyours run`)

| Attempt | Commit | Result | Authoring runs | Credits | Cause found (all fixed) |
|---|---|---|---|---|---|
| 1 | dce76d9 | stopped at login | 2 | 25.3 | Recorded logins (with a "verify signed in" step) fail to replay; `{{base_url}}` as start URL is flaky in kane-cli |
| 2 | 13f77b1 | 4 × HARNESS_BROKEN | 11 | 117.6 | The CLI `init` minted random tokens instead of the seeded ones, so the notes didn't contain them; also Kane compared `'{{global.token}}'` literally once |
| 3 | fbd2bb8 | 4 × HARNESS_BROKEN | 7 | 65.2 | The same `init` bug (scratch was initialised before the fix) |
| **4** | **2ab7079** | **4 × HELD**, all controls ✓ | 10 | 89.1 | – |

HARNESS_BROKEN was the correct verdict each time: the positive controls refused to call a broken
harness HELD.

Run 4 took 560 s: B1 159 s, B2 131 s, B3 133 s, B4 135 s. Logins replayed (9 s, 0 credits).

### Lock, replay
| Command | App | Result | Time | Credits (balance) |
|---|---|---|---|---|
| `notyours lock` | fixed | 4 locked by adopting the run's recordings, 0 authoring runs | 1 s | 0 |
| `notyours replay` | fixed | **GREEN** ×4 (HELD) | 170 s | 3.4 |
| `notyours replay` | **bugs restored** | **RED**: B1 LEAK_VISIBLE, B3 LEAK_PAYLOAD; B2, B4 HELD; exit 1 | 198 s | 7.2 |

The expectation was "RED within seconds at ~0 credits". **Measured: ~3 min and a few credits.**
- **Time:** the Kane replays are fast (2–22 s each, logins ~10 s); most of the time is the oracle's own
  visits, screenshots and Chrome start-up per boundary.
- **Credits:** a replay that kane-cli marks failed (B3's free user hits the paywall, by design) triggers
  Kane's paid failure triage; passing replays report 0.

### Why the recordings are not in the repo
kane-cli only replays recordings that keep the TestMu `org_id`, `user_id` and `project_id`. A
sanitized copy errored, and a test showed blanking screenshot URLs is fine but zeroing ids is not. By
decision, recordings stay local (`**/.notyours/tests/` is gitignored), and judges get
`notyours demo --quick` plus the redacted [sample report](sample-report/report.html). The sanitize test
cost 2 extra authoring runs (logins re-recorded after the sanitized login replays errored).
