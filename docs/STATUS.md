# notyours status (2026-11-18, kane-cli 0.10.0, Claude Code 2.1.327)

## What works (verified with real Kane and real Claude Code)
- **Integration:** A–D merged in order, CC-1 applied, `NOTYOURS_REAL` removed (the CLI always uses the real engine and
  ratchet; `test/contracts.test.ts` stays on MockEngine). `npm run build && npm run typecheck && npm test` passes: 290
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
- **Guard:** blocks Edit, Write and Bash tampering with locked boundaries, recordings, `dirty.json`/`attempts.json`,
  config, hook settings, secrets and recorded logins, and agent-run `notyours run`/`lock`. It fails closed on internal
  errors. In run 3 the agent was denied twice and fixed the code instead of cheating.
- **Judges:** `notyours demo --quick` (B1 only) prints its estimate up front. There's also a no-credits
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

## Credits spent in this prompt
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
- **Bash edits bypass post-tool.** Run 3's agent edited a route with `python3`, and that doesn't mark boundaries dirty.
- **The guard is a guardrail, not a sandbox.** Automated security review found successive parser differentials in the
  Bash checks. The current version is deny-by-default for any notyours invocation (exact plain-word allowlist, with no
  quotes, expansions, subshells or command runners) plus a fail-closed regex backstop. A determined agent with shell
  access can still find unanticipated forms (known and accepted: an `npm`/`pnpm`/`yarn run <script>` whose body calls the CLI, and `npx ./`-style path spellings, are not resolved). The backstops are Claude Code's `permissions.deny` rules and reviewing
  `.notyours/` in `git diff`.
- **Demo friction:** Jotter's own tests assert the seeded bugs, so a correct fix turns 2–4 of them red, which agents
  notice and trade off (run 3 briefly re-added bug #3). Running them while the app holds :3077 is slow.
- **Test suite:** one timing test flaked under parallel Chrome load (fixed: best of 3). One unexplained "1 failed file"
  run early on didn't reproduce in 6 later runs.

## Top 3 fixes
1. **Make replays fast and free.**
   - Reuse one Chrome set across boundaries in a Stop pass, and judge boundaries in parallel.
   - Screenshot only hit pages (not every control page) on HELD.
   - Record plan-gate viewers on a non-gated page, so no replay "fails" and triggers paid triage.
   - Target: under 30 s and 0 credits for a 1-boundary Stop.
2. **Catch every edit.** Bash `sed`/`python` edits should mark boundaries dirty: on Stop, diff the surface globs
   against `git diff`/mtime since the last pass instead of relying only on PostToolUse.
3. **Kane robustness and portability.**
   - Evaluate kane-cli 0.10.6 (it changes replay, variables and healing; your decision, since healing may cost
     credits).
   - Add a `doctor --replay-selftest` that catches the 0.10.0 quirks above.
   - Find a way to ship demo recordings without account ids, so judges replay instead of author.
