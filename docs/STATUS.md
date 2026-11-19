# notyours status (2026-11-18, kane-cli 0.10.0, Claude Code 2.1.327)

## Fresh clone, v0.2.0 (2026-11-19, kane-cli 0.10.0, empty npm cache)

Simulation: a clone of `main` at `a54da5d` (committed, not yet pushed), `npm ci` on an empty npm cache, `npm pack`,
the tarball installed in a fresh user folder, then the README commands with `npx notyours` (not on npm yet, so the
installed `node_modules/.bin/notyours` stands in). Times are wall-clock, measured by hand.

| Step | Time | Kane credits | Result |
|---|---|---|---|
| `git clone` of `main` | 0 s | 0 | committed tree |
| `npm ci` (empty cache) | 47 s | 0 | 0 vulnerabilities |
| `npm pack`, then install the tarball | 1 s, 22 s | 0 | `notyours 0.2.0` |
| `notyours doctor` | 3 s | 0 | Ready, 9032 credits |
| `notyours demo --quick` | 4 min 16 s | 27.3 (B1, from the run) | `LEAK_VISIBLE`, Bob saw Alice's data |
| `scripts/judge-loop.sh` on the demo folder | 4 min 23 s in total (the loop itself 122 s) | 15.0 (B1 proof) + 0 (replays) | regression: exit 1 LEAK; fix: exit 0 GREEN |
| Stop hook on the demo, `app.start` approved | 55 s | 0 (replays) | restarted the app, B1 held, exit 0 |
| `init` from the tarball, in a pseudo-terminal, agent variables unset | under 1 s | 0 | approval recorded; the freshness check then restarts the app with no prompt |

- Authoring runs: 2 logged by the demo (its output counts 4 Kane run starts, logins included), 2 logged by the loop's
  setup. Every replay logged 0 credits.
- Account balance: 9032 before the demo, 8951 after the loop and the Stop-hook check (81 credits in total). The credit
  logs record 42.2 for the authoring runs; the rest is not explained by the logs (the same kind of gap as the earlier
  61 against 48.8).
- Found and fixed: the demo copy ran `server.js` as CommonJS inside a CommonJS user folder and failed on its imports.
  v0.1.5 had the same gap (`demo/` had no `package.json`). Fixed by `demo/package.json` (`"type": "module"`), `a54da5d`.
- Not covered: the GitHub fallback `npx github:Jasekeee/notyours` after the push, and the npm package itself (not
  published here). The Stop hook was run through its code (`stopHook`), not from an installed Claude Code session.

## What works (verified with real Kane and real Claude Code)
- **Integration:** A–D merged in order, CC-1 applied, `NOTYOURS_REAL` removed (the CLI always uses the real engine and
  ratchet; `test/contracts.test.ts` stays on MockEngine). `npm run build && npm run typecheck && npm test` passes: 346
  tests, including the 25 demo tests.
- **Oracle on Jotter (authoring):** B1 LEAK_VISIBLE, B2 HELD, B3 LEAK_PAYLOAD (free Bob got the Pro export), B4 HELD,
  all with both positive controls. HARNESS_BROKEN correctly refused to call a broken harness HELD 3 times while bugs
  were being found.
- **Ratchet:** on the fixed app, `run` gives 4 × HELD. `lock` adopts the run's own recordings (0 authoring, 1 s).
  `replay` gives GREEN on the fixed app, and with the bugs restored **RED** on B1 and B3 (exit 1). The oracle judges even
  when a Kane replay diverges.
- **The Claude Code loop (headless), for both bugs:** an edit marks the boundary dirty, Stop replays and exits 2 with
  the leak report, Claude fixes the server-side check, and Stop replays GREEN. Run 1 fixed #1/#2, run 2 fixed #3.
  Loops cost 0 authoring runs.
- **Agent policy:** coding agents **may** run `notyours run`, `lock`, `demo`, `init` and `install-hooks` (the agent
  and Kane interact). Credits are bounded by a **per-project daily cap on authoring Kane runs** (default 20,
  `.notyours/budget.json`, counted from both credit logs; replays don't count). At the cap, the command prints why and
  how to continue, and exits non-zero. `notyours budget` shows usage. `notyours budget --set N` raises the cap and
  refuses from an agent shell (`CLAUDECODE=1`, no TTY), so the agent can't raise its own cap. CI can opt in with
  `NOTYOURS_ALLOW_AGENT_AUTHORING=1`, which the guard never lets the agent set.
- **Guard:** blocks Edit, Write and Bash tampering with `.notyours/`: locked boundaries, recordings,
  `dirty.json`/`attempts.json`, `budget.json` and the credit logs, config, hook settings, secrets and recorded logins.
  It fails closed on internal errors. In run 3 the agent was denied twice and fixed the code instead of cheating.
- **Quick start:** `notyours demo --quick` (B1 only) prints its estimate up front. There's also a no-credits
  [sample report](sample-report/report.html).

## Timings (measured)
| What | Time |
|---|---|
| `demo` full, fresh (logins recorded + B1–B4 authored) | 9 m 44 s |
| `run` B1–B4 on the fixed app (logins replayed) | 560 s (B1 159, B2 131, B3 133, B4 135) |
| `lock` ×4 | 1 s |
| `replay` ×4, fixed / bugs restored | 170 s / 198 s |
| Stop hook, 1–4 dirty boundaries | 70–535 s (median ≈ 130 s) |
| Loop runs 1 / 2 / 3 end to end | 477 s / 262 s / 1687 s |
| Login replay / login recording | ~10 s / 50–75 s |

### Replay speed-ups (2026-11-18, kane-cli 0.10.0, `/tmp/ny-loop`, Stop hook run as Claude Code would)
Changes: one Chrome set per Stop pass (already), the owner's and viewer's oracle visits in parallel, up to 2 boundaries
in parallel when they share no persona, screenshots only of hit pages, and plan-gate viewers recorded on their own
non-gated page.

| Stop pass | Before | After |
|---|---|---|
| 1 boundary (B1) | 53 s, 0.73 credits | 56 s, 0.73 credits (no gain) |
| B3 plan-gate | 64 s, **13.17 credits** (Bob's paywalled replay "failed", so Kane billed triage) | **39 s, 0.55 credits** (both replays pass) |
| 3 boundaries (B1, B2, B4) | 120 s, 4.36 credits | **99 s, 1.13 credits** |

Where a 1-boundary Stop's ~55 s goes: process start + Chrome launch + scan ~13 s, two login replays ~10 s (in
parallel), the two recorded-test replays ~26 s (kane-cli process overhead around 2–12 s of replay), the oracle ~6 s.
The floor is Kane, not notyours. The demo's boundaries all include Alice, so they never qualify for the 2-in-parallel
path. It helps projects whose boundaries use different personas. Stopped after 18 of the 90 timeboxed minutes:
the rest would have been Kane time.

## Quick end-to-end check after the audit fixes (2026-11-19, fresh clone of `fix/audit`, empty npm cache, kane-cli 0.10.0)
| Step | Time | Kane credits (balance) | Result |
|---|---|---|---|
| `npm ci` | 49 s | 0 | no install-script warnings |
| `npm run build` | <1 s | 0 | |
| `node dist/cli/index.js doctor` | 4 s | 0 | all green |
| `demo --quick` (empty folder) | 4 min 48 s | **61.69** | B1 **LEAK_VISIBLE**, both controls; a progress line per Kane run plus a 30 s heartbeat; report in `./notyours-demo`; no Test Manager links |
| `bash scripts/judge-loop.sh ./notyours-demo` | 4 min 15 s (setup 2 min 17 s, **loop 1 min 55 s**) | **19.66** | regression → `replay` exit **1, LEAK**; fix → exit **0, GREEN** |
| `npm test` ×3 (flake check) | 153 s each | 0 | 341/341 passed all three times |
| **v0.1.5**, fresh clone of the tag: `npm ci` / `doctor` | 90 s / 3 s | 0 | no install-script warnings; all green |
| **v0.1.5** `demo --quick` (recorded logins reused) | 2 min 13 s | **32.68** (26.2 logged) | B1 **LEAK_VISIBLE**, 2 authoring runs |

## Quick end-to-end check (measured on a clean copy, kane-cli 0.10.0)
| Step | Time |
|---|---|
| `git clone` (fresh, `/tmp/judge`) | 2 s |
| `npm ci` (runs `prepare` → build; warm npm cache) | 2 s |
| `npm run build` | <1 s |
| `node dist/cli/index.js doctor` | 3 s, all green, `kane-cli version 0.10.0 (tested 0.10.0–0.10.6)` |
| `node dist/cli/index.js demo --quick` | **4 m 17 s**, B1 **LEAK_VISIBLE** with both controls, 60.90 credits (4 authoring runs) |
| `npx --yes github:Jasekeee/notyours demo --quick` (empty folder) | **5 m 9 s** total (install + `prepare` build ≈ 27 s, then the demo 4 m 42 s); B1 **LEAK_VISIBLE**, 30.94 credits |

The demo copy contains no `test/` or `vitest.config.js`.

### Feature-freeze prompt (catch every edit, faster replays, quick end-to-end check)
**12 authoring runs** of the 15 allowed (B3 re-recorded on a non-gated page: 4; quick check A: 4; quick check B: 4).
About **153 Kane credits**: B3 re-recording 40.06, quick check A 60.90, quick check B 30.94, and the Stop-pass measurements 21.46.
Balance is now 10,163.58.

## Credits spent in the integration prompt
**529.17 Kane credits** (balance 10,960.34 → 10,431.17), **44 authoring runs** of the 52 approved, plus about $2.48 of
Claude Code usage for the four headless sessions.

| Phase | Authoring runs | Credits |
|---|---|---|
| Step 3 E2E demo | 11 | 113.3 |
| Step 4 proving attempts 1–4 (3 broken by real bugs, then 4 × HELD) | 2 + 11 + 7 + 10 | 25.3 + 117.6 + 65.2 + 89.1 |
| Free diagnosis replays (their failures trigger paid triage) | 0 | 23.5 |
| Lock + 2 replays | 0 | 10.7 |
| Sanitized-recording test (logins re-recorded) | 2 | 27.7 |
| Hook dry run (one login re-recorded) | 1 | 12.9 |
| Loop runs 1–3 (incl. attempt 1) | 0 | 43.8 |

## What is flaky or weaker than planned
- **Replays are not "seconds at ~0 credits".** Each boundary takes ~40–50 s, mostly the oracle's own visits, screenshots
  and Chrome start-up. A replay that kane-cli marks failed (by design for B3's paywall) costs a few credits of triage.
  Docs and the README now state measured numbers.
- **kane-cli 0.10.0 quirks** (all worked around):
  - `{{vars}}` inside a verify clause are sometimes compared literally, so non-secret values are now inlined.
  - Recorded analyze→assert steps replay without their value.
  - A recorded login types the right password only if the secret is supplied again at replay time.
  - A `{{base_url}}` start URL is flaky, so URLs are inlined.
  - One unexplained login replay "no test_md_done event" (dry run). Replays now never re-record logins, so this can't
    loop on credits.
- **Recordings aren't portable.** kane-cli replays them only with the recording machine's TestMu org/user/project ids.
  By decision they're never committed (`**/.notyours/tests/` is gitignored), so every fresh demo authors (~45 credits
  quick, ~120 full).
- **Bash edits bypassed post-tool (fixed).** Run 3's agent edited a route with `python3`. Each Stop pass now also scans
  every boundary's surface for changes since the previous pass (git in a git repo, else an mtime snapshot).
- **Hooks failed open when the CLI path vanished (fixed, v0.1.1).** `install-hooks` used to write the CLI's absolute
  path (often an npx-cache path) into `.claude/settings.json`. A hook command that can't start is a non-blocking error
  in Claude Code, so the guard silently let tool calls through. Now every hook command runs `.notyours/bin/notyours-hook`.
  The launcher tries, in order: the `--cli` override, the project's `node_modules/.bin/notyours`, the install-time
  CLI, `notyours` on PATH, then `npx github:Jasekeee/notyours`. If no CLI is found, the launcher is missing, or the
  CLI crashes, the hook **exits 2** with "notyours guard unavailable — run `npx github:Jasekeee/notyours
  install-hooks` (or doctor)". The one exception keeps Stop's loop protection: with `stop_hook_active` it prints the
  note and lets that second stop through. The guard keeps `.notyours/bin` read-only. `doctor` checks that every
  installed hook resolves and prints a FIX line if not. Tests: `src/cli/hook-launcher.test.ts`. The npx fallback
  takes 5–9 s per hook call (slow, but it blocks rather than passes). The old direct-command installer
  (`src/hooks/install.ts`) was removed.
- **The guard is a guardrail, not a sandbox.** It decides by text-matching Bash commands, so a determined agent with
  shell access can still find spellings it doesn't anticipate. The backstops are Claude Code's `permissions.deny`
  rules and reviewing `.notyours/` in `git diff`. Credits don't depend on the guard: the daily budget is enforced
  inside the CLI at every authoring run.
- **Demo friction:** Jotter's own tests assert the seeded bugs, so a correct fix turns 2–4 of them red, which agents
  notice and trade off (run 3 briefly re-added bug #3). Running them while the app holds :3077 is slow.
- **Test suite:** one timing test flaked under parallel Chrome load (fixed: best of 3). One unexplained "1 failed file"
  run early on didn't reproduce in 6 later runs.

## Fixed on fix day (2026-11-19, from the natural-app experiments)
- **Stale app server (false GREEN).** The Stop hook no longer judges an old process. With `app.start`/`app.port` in
  `.notyours/config.yaml` it restarts the app and waits for the port before replaying (live: new pid, HELD). Without
  them, it compares the listening process's start time with the newest surface file. If the code is newer, it doesn't
  replay; it reports YELLOW "your app server is older than your code — restart it or set app.start" and exits 2 (live:
  0 s, 0 credits). This counts in `attempts.json`, so after `maxAttempts` stops the agent may stop.
- **Already signed in.** Before replaying a recorded login, the persona's own page is checked for its token; if it's
  there, the replay is skipped. 1-boundary Stop pass on the natural app, before → after: **102 s, 2.13 credits,
  2 failed login replays → 62 s, 0.73 credits (0 logged), 0 failed replays** (both skipped), HELD both times.
- **File downloads.** A GET target that aborts as a download (`Content-Disposition: attachment`) is fetched in the
  persona's tab with `fetch(url, {credentials: 'include'})` and judged as text; the origin page it runs from is kept
  out of the judgement. The oracle's tabs now also bypass the app's CSP: the natural app's `default-src 'none'`
  blocked those `fetch()` calls, and it would have broken POST targets on any strict-CSP app as well. Natural-app Pro
  export, judge-only (0 credits): **HELD, both controls true** (was HARNESS).

## Fixed after the independent audit (2026-11-19)
The audit itself stays private; ids below are its finding numbers. Code fixes come with tests that failed before.
- **Budget bypass (AUD-01).** `budget --set` was refused only for `CLAUDECODE=1`; `CLAUDECODE=0 … budget --set 999`
  worked. Now it's refused inside Claude Code for any `CLAUDECODE` value or any `CLAUDE_CODE_*` variable (no TTY). The
  guard denies `budget --set`, `notyours release`, and setting or unsetting those variables in Bash.
- **False HELD paths in the oracle (AUD-03, AUD-12, AUD-13).** A leak visit that errored, got no response or a 5xx,
  or a leak body that was over 2 MB or unreadable, made a no-hit result HELD. Now it's HARNESS. Bodies of any content
  type are scanned (XML, octet-stream, text/javascript data endpoints). A viewer's 404 on an api target counts as a
  denial only when the owner's call to the same URL returned 2xx.
- **Stop hook fails closed (AUD-11).** HARNESS results and replay exceptions block too. After `maxAttempts` the
  boundary is escalated (`ESCALATION.md` + `.notyours/escalated.json`) and **keeps blocking**, with no new Kane runs
  until its code changes, until a person runs `notyours release` (refused from an agent, denied by the guard).
- **Report (AUD-02):** no Test Manager links (TestMu ids) or local session paths in `report.html` / `report.json`.
- **Quick end-to-end check:**
  - A start line per Kane run, plus a 30 s heartbeat (AUD-10).
  - The demo works in `./notyours-demo` and prints the report path first (AUD-19).
  - `doctor` pins kane-cli 0.10.0 (AUD-05, AUD-22).
  - The README gives the install line, measured credits and about 2× for 0.10.6 (AUD-05, 06, 07, 32).
  - `scripts/judge-loop.sh` runs the loop without Claude Code: a simulated regression gives exit 1 LEAK, the fix
    gives exit 0 GREEN (AUD-15).
- **Smaller:**
  - Generated sign-up emails use `notyours.test` (AUD-31); the demo credentials are explained as demo-only (AUD-17).
  - `allowScripts` for esbuild and fsevents (AUD-24).
  - The spike recording is untracked and `**/.testmuai/tests/` is ignored (AUD-18).
  - CLAUDE.md now reports 0 `npm audit` findings (AUD-30).
  - The README's credit-log keys (AUD-21) and the launcher's "second stop" wording (AUD-20) are corrected.
  - Signed-in personas also skip the login replay during authoring runs (`run`), not only replays.
  - `package.json` is 0.1.4 (AUD-09).
- **Not done here:** AUD-23 (the budget check isn't atomic) stays documented below. AUD-25, 28 and 29 were
  deferred by the owner. AUD-04, 08 and 26 are documentation items outside this release.

## Fixed after the second independent review (2026-11-19, v0.1.5)
- **The Stop hook could be switched off from a boundary file (P0).** An invalid boundary file, or an unlocked copy
  reusing a locked boundary's id, made the Stop hook exit 0 (and the copy emptied `dirty.json`). A crash inside the
  Stop hook also exited 0. Now all three block (exit 2) with a message saying what to fix. A broken boundary file is
  checked even when nothing is marked dirty. Tests reproduce each bypass and failed before.
- **`init` gitignores Kane recordings** (`.notyours/tests/`, `.testmuai/tests/`: TestMu account ids, typed login
  passwords) along with the raw runs (`.notyours/runs/`: Test Manager links, session dirs, local screenshot paths).
- README: replay triggers only on `surface` files; locked boundaries need fixed URLs; the demo's token is planted by
  the seed script; the recorded loops predate v0.1.4; Kane's pass/fail never changes a verdict. The rest of the
  review's P1 items are listed as known limitations and roadmap in the README.

## Known limitations
From the automated security review. By decision, only real secret or credential leaks are fixed; the rest is logged here.
- Bash-guard parser differentials: comment `#` handling, `rg --pre` / `git` aliases running a program, option values
  that contain a notyours path, `npm`/`pnpm`/`yarn run <script>` indirection, and `npx ./` path spellings. The
  allowlist parser for agent notyours commands was removed when agents were allowed to author; the budget (enforced
  in the CLI) is the credit control.
- The budget counts runs from local logs: a person who deletes `.notyours/credits.log` resets today's count (the agent
  can't; the guard blocks it).
- With `--cli`, the launcher calls a machine-specific command. If it's missing, the hook blocks (fails closed) with
  "notyours guard unavailable".
- Raw kane-cli stderr can contain local paths and share links; replay reasons use only `err.code` or redacted text.
- Agents may run `notyours install-hooks` (by decision), so an agent could re-install the hooks with a different
  `--cli` command, swapping in its own guard. Direct edits to `.claude/settings.json` stay blocked; the change would
  show in `git diff`. Likewise, by decision, agents may `init` (rewriting config and identities) and `lock`/`run`
  (re-recording the oracle).
- The budget is per project: an agent can start a fresh project dir (or delete `.notyours/` through an unguarded
  path) and get a new daily cap. A per-machine or per-account cap is not implemented.
- Surface scan (catch every edit): the fingerprint is mtime + size, not a content hash, so a write that restores both
  goes unnoticed. In a git repo, gitignored files under a surface aren't scanned, and the agent could edit
  `.gitignore`. Git file listings aren't `-z`-quoted, so unusual file names may be missed. The non-git walk skips
  `node_modules`, `dist`, `data` (and others) at any depth and stops at 50,000 files.
- `planLock` writes plan-gate `viewerOwn` URLs into the recorded objective after filling in stored values; a
  templated host in `viewerOwn` isn't re-checked against `allowHosts` at that point (literal URLs are checked by the
  CLI host gate).
- **Replays don't return stored values (kane-cli 0.10.0).** A locked boundary whose targets come from its create run
  (`{{note_url}}`) replays as HARNESS. Locked boundaries need fixed URLs (as the demo's are).
- **`app.start` runs a shell command from `.notyours/config.yaml` on every Stop pass that replays.** A cloned repo's
  committed config could therefore start arbitrary commands. The guard keeps the file read-only for the agent, but
  not for whoever wrote the repo. The restart also stops whatever process listens on `app.port`.
- **Skipping the login replay needs a literal own page** (`viewerOwn`, or the owner's literal targets). A Stop pass
  with both logins skipped and 0 credits logged still lowered the Kane balance by 0.73.
- **An escalated boundary keeps blocking the session** (by decision): the agent can't finish until the leak is fixed,
  a person runs `notyours release`, or the person interrupts the session. Each blocked stop costs no Kane credits,
  but Claude keeps getting the block text.
- **The budget and release checks match text.** An agent that writes a script file which unsets
  `CLAUDECODE`/`CLAUDE_CODE_*` and then calls `budget --set` isn't caught by the guard, and the CLI then sees no agent
  variables. It's a guardrail for a cooperating agent, not a sandbox.
- **The demo reuses an existing `./notyours-demo`** (security review): files already there are not overwritten, so a
  folder planted with a modified `server.js` would run it. Run the demo in a folder you control, or pass `--dir`.
- **First `npx github:` install prints almost nothing for 1–3 minutes** (measured 81 s and, by the reviewer, 2 min
  46 s with an empty npm cache). Since `allowScripts` (v0.1.4), neither `npm ci` in a clone nor the `npx github:`
  install shows the install-script warnings (both checked 2026-11-19).
- **Kane's guest recording can get stuck at a login redirect** (`stuck.ap_stuck`). On the natural app,
  `share-link-guest` proved HELD, but its guest visit was stuck both in the probe and in `lock`'s own recording, so it
  can't be locked (docs/natural-app/EXPERIMENT3.md). The demo's guest boundary locks fine.
- `run --dry-run` underestimates long objectives and plan-gates: the natural-app run was estimated at ~120 credits
  and used 259 (15 authoring runs).
- The budget check isn't atomic: several authoring runs started at the same moment can each pass the check and
  overshoot the cap by the number of parallel runs (the engine runs at most 2 at once).

## Top 3 fixes
1. **Keep persona Chromes alive between Stop passes.** Chrome launch and login replays are ~23 of a 1-boundary Stop's
   ~55 s; a small per-project Chrome daemon would remove them. (Done 2026-11-18: one Chrome set per pass, parallel
   oracle visits, 2 disjoint boundaries at once, hit-only screenshots, non-gated plan-gate recordings. See the
   table above.)
2. **Version-aware costs everywhere** (docs/KANE_COMPAT.md): on kane-cli 0.10.4+ replays cost credits, so count
   replay credits against a daily credit cap, not only authoring runs. (Done: catch every edit via a surface scan on
   each Stop.)
3. **Kane robustness and portability.**
   - Evaluate kane-cli 0.10.6 (it changes replay, variables and healing; your decision, since healing may cost
     credits).
   - Add a `doctor --replay-selftest` that catches the 0.10.0 quirks above.
   - Find a way to ship demo recordings without account ids, so a replay needs no authoring run.

## Onboarding (feat/onboarding, 2026-11-19): time to first verdict on a developer's own app

Baseline: a fresh copy of `~/code/natural-app` (Express 4, `npm start`, PORT || 4000; its `data/` removed), kane-cli 0.10.0,
built from this branch (`npm run build`), wizard run with `notyours init --yes`, then one boundary.

| Step | Time | Kane credits | Result |
|---|---|---|---|
| `notyours init --yes`: detect, start the app, sign up alice, bob, free_user (3 authoring runs) | 4 m 27 s | 32.0 | 10 drafts, hooks installed |
| boundary `notes-id-cross-user` written by hand (what `/notyours-map` does) | about 1 min (not Kane time) | 0 | `_draft_` removed |
| `notyours run notes-id-cross-user` (2 logins recorded, owner create, viewer look) | 4 m 44 s wall (181 s Kane) | 50.2 | **HELD**, both controls passed |
| **Total: `init` to the first verdict** | **≈ 9 m 11 s tool time** (≈ 10 min with the boundary write) | **82.2** | 8 authoring runs (budget 20/day) |

Findings from this run:
- A first `run` was refused with no Kane spend because the wizard stopped the app it had started. Fixed: `run`, `lock --reauthor`
  and `replay` start the app from `app.start` when nothing answers, and stop it afterwards.
- The map drafts are noisy: `PLAN_RE` matches the word "plan" in route bodies, so `signup`, `login`, `root` and `account` got plan-gate
  drafts. Those drafts pulled in a third persona (`free_user`, 9.2 credits) for no reason. Known limitation (map heuristic).
- Passport strategies (`GoogleStrategy`) were not detected as OAuth until the pattern was widened.
