# kane-cli compatibility: 0.10.0 vs 0.10.6 (tested 2026-11-18)

Setup: 0.10.6 installed in isolation (`npm i --prefix /tmp/kane0106 @testmuai/kane-cli@0.10.6`, used only via
`PATH="/tmp/kane0106/node_modules/.bin:$PATH"`). The Homebrew 0.10.0 was not touched (`kane-cli --version` outside that
PATH stays 0.10.0). `~/.testmuai` was backed up to `~/.testmuai.bak-0100` first.

Cost of this test: **6 authoring runs** of the 8 allowed, **114.23 Kane credits** (balance 10,431.17 → 10,316.94).

## Verdict: works

| Check | 0.10.6 |
|---|---|
| Auth with the existing 0.10.0 login | ✓ `whoami` Authenticated, no re-login |
| Flags notyours uses (`run --agent --cdp-endpoint --variables-file --timeout --name`; `testmd run --no-adaptive-heal --variables-file --override-start-url`) | ✓ all present |
| `notyours demo --quick` (B1, fresh work dir) | ✓ **LEAK_VISIBLE**, both controls true, hits in the DOM `/notes/1001` + network `/notes/1001` and `/api/notes/1001`; all 4 Kane runs `success.complete` |
| 0.10.0 afterwards | ✓ still on PATH, Authenticated, same balance; no restore needed |

**Shared config:** 0.10.6 rewrote `~/.testmuai/kaneai/profiles/<profile>/prod/credentials` (same schema:
`access_token`, `refresh_token`, `expires_at`, i.e. a token refresh) and added `kaneai/tls/` and two `assurance/`
files. `config.json` keys are unchanged. Switching back and forth between the versions works.

## Differences that matter to notyours

| | 0.10.0 | 0.10.6 |
|---|---|---|
| `demo --quick` wall time | B1 incl. both logins ≈ 280 s | **610 s** |
| One authoring run (Kane `duration` / wall) | 18–46 s / 38–70 s | **51–103 s / 137–227 s** (≈ 85–130 s of extra wall time per invocation) |
| Login replay (passing) | ~10 s, **0 credits** | 45 s, **0.20 credits** |
| Recorded test replay (passing, with an assert) | 2–12 s, **0 credits** | 46–74 s, **0–4.45 credits** (4.42 and 4.45 on the two variable-assert replays; 0 on one inlined-assert replay) |
| Failed replay | a few credits (triage) | 2.62 credits (a login replay that "passed" but left the user signed out) |
| `demo --quick` credits | ≈ 46 (run 1, B1 + logins) | 62.90 |

The changelog says why: from 0.10.4, "reads heal… run through the analyze v3 repair loop"; in 0.10.6, "self-healing runs
on every web replay". Even with `--no-adaptive-heal`, replays on 0.10.6 are **no longer free or fast**.

## The 0.10.0 quirks in docs/STATUS.md, re-checked on 0.10.6

| Quirk (0.10.0) | 0.10.6 | Evidence |
|---|---|---|
| `{{vars}}` inside a verify clause compared literally | **Not observed** (2/2 authoring runs resolved `'{{token}}'` and passed) | Note: the 0.10.0 evidence is weaker than STATUS says. The run where Kane quoted `'{{global.token}}'` was also hit by the init bug (random tokens), so the note genuinely didn't contain the expected token. |
| Recorded analyze→assert steps replay without their value | **Fixed** | A recording with `assert: the note text contains '{{global.token}}'` replays and passes (2/2, without re-supplied variables) |
| A recorded login types the right password only if the secret is supplied again at replay | **Unchanged** | Without the variables file: "passed", user signed out. With it: passed, signed in, and a new server session. notyours already re-supplies the secret, so login replays work. |
| `{{base_url}}` as a start URL is flaky ("No start URL provided") | **Not observed** (2/2 resolved) | notyours inlines URLs anyway |
| Login replay "no test_md_done event" | Not seen | – |
| **New:** a replay occasionally exits 1 instantly with no output | **New, intermittent** (2 of 9 replays, both right after another replay on the same port or test; didn't reproduce on demand) | notyours treats it as a failed replay: a login isn't re-recorded during replays, and the oracle's controls then say HARNESS_BROKEN |

## Recommendation: (c) code change needed. Support both versions; nothing is broken today

Verdicts are correct on both versions, because the oracle never depends on Kane's own pass/fail. But on 0.10.6 several
of notyours' promises and estimates are wrong: "replays cost 0", "`--quick` ~4 min / ~45 credits", and the 900 s Stop
timeout. Most users will likely have 0.10.6. Suggested changes (not implemented yet):
1. **Version-aware estimates.** `demo` and `run --dry-run` should read `kane-cli --version` and print 0.10.6 numbers
   (quick ≈ 10 min / ≈ 65 credits; full ≈ 25 min / ≈ 170 credits, extrapolated) instead of the 0.10.0 ones. `doctor`
   should show the version and say which one notyours was tested with.
2. **Count replay credits.** Today the daily budget counts only authoring runs. On 0.10.6 every replay costs ~0.2–4.5
   credits, so the Stop hook can spend credits on every stop. Log replay credits (the ratchet already writes them) and
   add a daily **credit** cap next to the run cap, reported in the Stop message and the report.
3. **Retry once on an empty exit.** If `testmd run` exits non-zero within ~2 s with no events after `stream_start`,
   retry once. Nothing ran, so the retry costs nothing.
4. **Stop hook time.** With 0.10.6 a 4-boundary Stop pass can exceed the 900 s hook timeout. Replay boundaries in
   parallel (separate Chrome sets), or raise the timeout for 0.10.6 (see STATUS top fix #1).

If the code changes aren't done before release, the fallback is **(b): pin 0.10.0** in the README:
```sh
npm i -g @testmuai/kane-cli@0.10.0   # or keep Homebrew's lambdatest/kane/kane-cli (stable 0.10.0 as of 2026-11-18)
kane-cli --version                   # 0.10.0
```
That keeps the measured numbers in docs/E2E.md and STATUS true, and makes passing replays free again. The cost is
asking users to downgrade.
