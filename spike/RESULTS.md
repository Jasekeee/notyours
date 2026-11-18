# G1 summary

1. **Name:** `notyours` (free on npm and GitHub) → https://github.com/Jasekeee/notyours
2. **Parallel runs (2 Chromes over CDP):** YES. T3a+T3b ran simultaneously (step windows overlapped 07:46:22–07:46:37) and both passed.
3. **Live network capture alongside Kane:** YES. puppeteer-core attached to the same Chrome and saw Kane's document response; Kane still passed (T4b).
4. **Analyzer-only usable:** YES. `condition_results:[true]` in ~2 s for 1.76 / 0.25 credits; works with no objective and with `""`. Caveat: it judged by reading the page *title*.
5. **`run --name` works:** YES. Wrote `.testmuai/tests/nyspike_test.md` with the variable baked into frontmatter.
6. **Replay credits:** 0 (balance unchanged across replays; replay run_end has no `credits_consumed`); replay takes <1 s.
7. **Variable-change replay:** edit IGNORED. Changing `site` in the test.md frontmatter to the .org page still replayed the recorded `com.html` URL (passed, `final_url` = com). Retarget needs `--override-start-url` or re-authoring.
8. **testmd + `--cdp-endpoint`:** YES. Replay drove the existing Chrome on :9301 (T7 passed).
9. **Total credits spent:** 78.17 (balance 11200 → 11121.83). run_end events report 62.38; the ~15.8 gap is unreported verdict/triage cost on authoring runs.
10. **Gotcha:** example.com/.org were rewritten (no `<h1>`, no link, "Example Domain" only in `<title>`), so T1 failed for page reasons. T2–T7 used a local fixture (`site/` via `serve.js` on 127.0.0.1:8787), which also proves Kane reaches localhost.

---

Environment: macOS, Node 24.21.0, npm 11.19.0, kane-cli 0.10.0 (0.10.6 available, not upgraded), Chrome stable, 2026-11-18.
Harness: `spike/run.sh <step>`. Each kane-cli invocation ran exactly once (no retries). Raw NDJSON is in `spike/logs/` (gitignored).
Durations below are Kane's `duration` (s) / wall clock incl. CLI startup (s).

| Test | Result | credits_consumed | duration / wall | Notes |
|---|---|---|---|---|
| T1 store h1 + verify (real example.com, headless) | **FAIL** | 14.25 (+2.24 triage) | 52.3 / 106 | Page has no `<h1>` and no visible "Example Domain" anymore. `h1=""`. Kane's triage blamed `agent_misstep`, but the page genuinely lacked the heading. Not retried. |
| T2 click only link, store URL (fixture, headless) | PASS | 16.46 | 41.5 / 62 | `url = http://127.0.0.1:8787/more-com.html` (correct). |
| T3a Alice :9301, com fixture (parallel) | PASS | 6.42 | 19.1 / 41 | Ran concurrently with T3b. |
| T3b Bob :9302, org fixture (parallel) | PASS | 13.84 | 20.6 / 41 | Cost 2× T3a for the same task. |
| T4 dom.js via puppeteer.connect(:9302) | PASS | 0 | – | `org.html contains("Example Domain")=true`. |
| T4b Kane on :9302 while dom.js listens | PASS | 2.91 | 19.7 / 47 | dom.js captured `200 GET /com.html` live, and read the DOM after. No interference. |
| T5a `--analyzer-only --condition` (no objective) | PASS | 1.76 | 2.19 / 7 | `condition_results:[true]`; reason: read page **title**. |
| T5b same with objective `""` | PASS | 0.25 | 2.5 / 6 | Identical verdict. |
| T6 author `--variables-file v.json --name nyspike` | PASS | 6.50 | 16.4 / 39 | Test file created (below). |
| T6 replay #1 | PASS | none reported (0) | 0.72 / 9 | Server log shows a real page hit. |
| T6 replay #2 | PASS | none reported (0) | 0.81 / 11 | |
| T6 replay after variable → org | PASS (wrong page) | 0 (balance unchanged) | 0.89 / 13 | Went to `com.html` anyway: recorded steps win over edited variable. |
| T7 replay with `--cdp-endpoint :9301` | PASS | 0 (balance unchanged) | 0.54 / 10 | Replay works on an existing browser. |

## Deviations from the plan

- **Target pages:** example.com/.org/.net changed (Nov 2026); they now say *"avoid relying on it for testing and monitoring purposes."* With approval, T2–T7 swapped them for `http://127.0.0.1:8787/com.html` and `/org.html` (each `<h1>Example Domain</h1>` + one link).
- **Variables file format:** used the documented `{"site":{"value":"..."}}` instead of the flat `{"site":"..."}`, to avoid spending a run on a format error.
- **T4b URL:** Kane navigated Bob's Chrome to the com fixture (Bob was already on org) so there was a fresh response to capture.

## Implications for notyours

- One Chrome per persona over CDP + parallel Kane runs works: Alice/Bob/guest/free can each get their own `--user-data-dir`.
- Our own CDP client can sit beside Kane to record network bodies for the canary-token oracle.
- Analyzer-only is a cheap, fast oracle (~0.25–1.8 credits), but conditions must target the body explicitly ("the page body text contains …"), since it is happy to satisfy them from `<title>`.
- Authoring costs 3–16 credits per run and varies ~2× for identical tasks; replays are free and sub-second. Author once, replay many.
- Do not rely on editing test.md variables to retarget a replay. Use `--override-start-url` or re-author.
- Kane's failure triage can misattribute page problems to the agent (T1), so don't treat `verdict.category` as ground truth.

## nyspike_test.md (as authored; the value was later edited to org.html for the variable test)

```markdown
---
mode: testing
max_steps: 50
timeout: 180
target: chrome
headless: true
variables:
  global.site:
    value: http://127.0.0.1:8787/com.html
    secret: false
    syntax: '{{site}}'
    type: global
---

# Session: nyspike

## Step 1
Go to {{site}} and verify the page shows 'Example Domain'
```

## Trimmed run_end JSON

Produced with `jq -f spike/trim.jq` (drops session paths, share URLs and run dirs).

```
T1	{"status":"failed","one_liner":"The agent saved the heading value but did not perform the required check that it equals “Example Domain.”","duration":52.3,"credits_consumed":14.247724999999999,"result_code":330,"reason_code":"stuck.ap_stuck","variables":{"h1":"","example_domain_visible":"false"},"verdict_status":"broken","verdict_category":"agent_misstep","verdict_credits":2.2385}
T2	{"status":"passed","one_liner":"clicked the only link on the page on the local site","duration":41.5,"credits_consumed":16.459242500000002,"result_code":100,"reason_code":"success.complete","variables":{"url":"http://127.0.0.1:8787/more-com.html"}}
T3a	{"status":"passed","one_liner":"verified the Example Domain page on the local site","duration":19.1,"credits_consumed":6.41897,"result_code":100,"reason_code":"success.complete","variables":{"example_domain_visible":"Example Domain"}}
T3b	{"status":"passed","one_liner":"confirmed the Example Domain heading on the organization page","duration":20.6,"credits_consumed":13.837024999999999,"result_code":100,"reason_code":"success.complete","variables":{"example_domain_visible":"true"}}
T4b	{"status":"passed","one_liner":"verified the Example Domain page on the local site","duration":19.7,"credits_consumed":2.9145299999999996,"result_code":100,"reason_code":"success.complete","variables":{"example_domain_visible":"Example Domain"}}
T5a	{"status":"passed","duration":2.19,"credits_consumed":1.76245,"variables":{},"condition_results":[true]}
T5b	{"status":"passed","duration":2.5,"credits_consumed":0.24838000000000002,"variables":{},"condition_results":[true]}
T6-author	{"status":"passed","one_liner":"verified the Example Domain page on the local site","duration":16.4,"credits_consumed":6.496469999999999,"result_code":100,"reason_code":"success.complete","variables":{"example_domain_visible":"Example Domain"}}
T6-replay1	{"status":"passed","duration":0.72,"result_code":100,"reason_code":"success.complete","variables":{"example_domain_visible":"Example Domain"}}
T6-replay2	{"status":"passed","duration":0.81,"result_code":100,"reason_code":"success.complete","variables":{"example_domain_visible":"Example Domain"}}
T6-replay-org	{"status":"passed","duration":0.89,"result_code":100,"reason_code":"success.complete","variables":{"example_domain_visible":"Example Domain"},"final_url":"http://127.0.0.1:8787/com.html"}
T7	{"status":"passed","duration":0.54,"result_code":100,"reason_code":"success.complete","variables":{"example_domain_visible":"Example Domain"},"final_url":"http://127.0.0.1:8787/com.html"}
```

T5a analyzer detail: `"condition_reasons":["Reading the current page title: value: 'Example Domain' -> 'Example Domain'; equals 'Example Domain' -> PASS"]`
