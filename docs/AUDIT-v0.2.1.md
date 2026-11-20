# notyours v0.2.1: independent audit (2026-11-20)

Scope: what outsiders get. The npm package `notyours@0.2.1` run with `npx notyours@latest` in empty `/tmp`
folders, the live site https://jasekeee.github.io/notyours/, and the public GitHub repo, README and release v0.2.1.
The working copy was read for evidence only. Nothing was fixed. Machine: macOS, Node 26.13.1, kane-cli 0.10.0.

## 1. Executive summary

- **Score: 72/100** as a skeptical TestMu judge (**±0 vs 72** for v0.1.5).
  - Gains: an npm package, a working `init` wizard, the app-start approval, a fast and honest site.
  - Losses: the first things a judge sees now contradict each other.
    - The site says "isn't on npm yet" and leads with `npx github:`.
    - The README's top image is a broken `demo.gif`.
    - The CLI, its hooks and its slash command still say `npx github:Jasekeee/notyours`.
    - "0-credit replay" and "replay: 0 credits, about a second each" are claimed although the repo measures 40–50 s and about 0–1 credit.
- **Gates: 3 of 3 pass on repo evidence. None was re-proven from npm in this audit.**
  - The npm `demo --quick` run was invalidated by the auditor (section 5).
  - A re-run was refused by the session's permission classifier, consistent with the "never retry authoring runs" rule.
- **Top-3 chance: possible, not the favorite** (judgment, not a measurement).
  - It is strongest on the two tie-breakers. Verified: a canary oracle with positive controls, and measured numbers. Closed loop: three recorded agent loops, and a Stop hook that blocks.
  - It is weakest on Craft and first impression.
  - On a real app (natural-app) it has proven only HELD. No real bug has been caught outside the seeded demo.
- **New false-green paths found (section 4):**
  - Download bodies over 2 MB are truncated without a flag (P0-2).
  - `app.start` restart reports success while the old server still serves (P0-3, no `lsof`).
  - The stale-server check without `app.start` fails open (P1-08).
  - The owner control is any-of across targets (P1-09).
  - Every v0.1.5 false-green fix still holds (section 4, note).
- **Highest leverage before Nov 26: about 45 minutes of copy-only fixes** (P0-1, P1-01 to P1-05, P1-07, P1-14), with no code touched. In my judgment that is worth about +4 to +6 points on Ships and Craft.

## 2. Scorecard

| Gate / criterion | Result | One-line reason |
|---|---|---|
| Gate: works end to end | PASS (repo evidence) | Four fresh demo runs in STATUS end in LEAK_VISIBLE. The npm demo was not re-proven here (auditor error, section 5). `doctor` and `init` from npm work. |
| Gate: Kane caught something meaningful | PASS, narrow | B1 LEAK_VISIBLE and B3 LEAK_PAYLOAD on seeded bugs (docs/E2E.md:13-16). On natural-app, 0 leaks: nothing real was caught. |
| Gate: agent and Kane interact | PASS | docs/loop-run-1..3: the Stop hook replays, blocks with evidence, the agent fixes the code, then GREEN. The guard denied cheating twice. |
| **Ships** | **19/25** | Published on npm; install, `doctor` and `init` work; 0 vulnerabilities. Against it: the site's install path contradicts npm, the README has a broken hero image, the CLI points to GitHub, and e2e.yml will go red tonight. |
| **Verified** | **19/25** | A token oracle with both controls, and numbers traced to committed docs. Against it: replay-cost and speed claims contradict the repo's own measurements, 2 confirmed false-green paths are new, and the CI badge doesn't run the false-green regression tests. |
| **Closed loop** | **18/25** | A real Stop-hook loop, fail-closed launcher and escalation. Against it: the drafts `init`/`map` generate use `{{stored}}` targets, which can't be locked, so the loop never covers a user's own boundaries without a rewrite; `replay` exits 0 with nothing locked; and the 900 s Stop timeout is plausibly fail-open. |
| **Craft** | **16/25** | `init` takes 8 s with 4 clear questions, the hook adds about 0.2 s, and the site is fast and accessible. Against it: a first verdict on your own app takes about 10 min, 82 credits and hand-written YAML (or Claude Code); 6 of 10 drafts on natural-app are noise; the dry-run estimate is 30 against 50 measured; and the demo's "no credits" link shows raw HTML. |

## 3. Product analysis

**ICP.** A solo developer or small team building a multi-user CRUD SaaS on Express or Next.js, with email+password auth, who works with Claude Code and already has, or will accept, a TestMu/Kane account. In practice the ICP is also "existing Kane users", because the account and credits are the gate.

**Job to be done.** "When my coding agent changes access-control code, prove that user B still can't get user A's data, and stop the agent if it can."

**Value prop (one sentence).** notyours plants a canary token in one test user's data, has Kane sign in as other users in real browsers, and blocks your coding agent until no token crosses accounts.

- **5-second site test:** passes. The H1 "Prove your users' data stays theirs" and the two-browser hero land. The cost (Kane credits and an account) is not visible until the quickstart.
- **30-second README test:** mostly passes. The tagline and "Not a penetration test" are clear. But the second visual is a broken image, and the "how it works" diagram promises "every later check is a 0-credit replay".

### Time to first value on your own app (natural-app, Express, already secure)

| Path | Time | Credits | Steps / decisions | Source |
|---|---|---|---|---|
| Prerequisites: TestMu account, `brew install kane-cli`, `kane-cli login` | not measured | 0 | 3 steps, 1 account | n/a |
| `doctor` | 12 s (warm cache); first `npx` 86 s on an empty cache | 0 | 0 | this audit; hygiene subagent |
| `init --users users.yaml` (accounts made beforehand) | **8 s** | 0 | 4 prompts (start command, port, base URL, hooks) | this audit |
| `init` with Kane sign-ups (alice, bob, free_user) | 4 m 27 s | 32.0 | the same 4 prompts; **no confirmation before spending** | STATUS "Onboarding" (feat/onboarding build, not a tag) |
| Turn 1 of 10 drafts into a boundary | about 1 min by hand (I did it), or `/notyours-map` | 0 | triage 10 drafts (6 are plan-gate noise), write the English objective, decide on fixed URLs if you want `lock` | this audit |
| `run` one boundary | 4 m 44 s | 50.2 (the dry run estimated ~30) | 0 | STATUS "Onboarding" |
| **Total to the first verdict** | **about 10 min** | **about 82** | about 8 decisions | |

The first verdict on a correct app is **HELD**. That proves the harness works, but it is not an "aha". The "aha" exists only on the seeded demo.

### Differentiation

Research by a subagent; each claim is sourced in its report.

| Alternative | notyours wins | notyours loses |
|---|---|---|
| Shannon, Strix (OSS AI pentest) | A deterministic cross-user oracle with positive controls instead of LLM judgment. Replays inside the coding-agent loop. | They find injection, XSS and SSRF, and boundaries nobody declared. They use your own LLM key, not a Kane account. Shannon supports TOTP and SSO. |
| XBOW, Aikido AI pentest | Local, cheap per replay, in the inner loop. Aikido's multi-role tier is 8,000 credits ($1 each). | Breadth, compliance reports, unknown attack paths. |
| Supabase Security Advisor, SupaShield, pgTAP | Sees leaks above the database: API routes, SSR, caches, service-role misuse. | Free, fast, deterministic, every policy on every table. |
| Playwright with one context per user | Canary seeding, network-payload scanning, positive controls and agent hooks built in. | Free, about 1 s per test, no vendor, any auth method, already in CI. **This is the real competitor.** |
| Burp Autorize, ZAP access control, StackHawk, Escape BOLA | No manual browsing or rule matrix; no OpenAPI spec needed. | Every captured request, automatic ID enumeration, mature CI. |
| Kane CLI's own [security and access testing docs](https://www.testmuai.com/docs/kane-cli-security-access-testing) | Adds what Kane's docs don't cover: user A seeing user B's records, the network-body oracle, controls. | Same account and credits. Judges know this page, so notyours must show clearly what it adds. |

Honest position: notyours's moat is the **combination** of a cross-user token oracle, Kane personas and an agent Stop-hook gate. No single part is unique.

### Retention

- **What keeps people:**
  - The Stop hook blocks a regression with evidence at almost 0 marginal credits.
  - The guard keeps the agent honest.
  - `notyours` with no arguments prints a status and the next step.
- **What makes people uninstall after a day:**
  1. Every edit to a `surface` file costs a Stop pass of about 1–2 min. On a one-file app like natural-app (`surface: server.js`), that is every edit.
  2. The boundaries they wrote from the drafts can't be locked (`{{record_url}}`), so the loop never starts for them (P1-10).
  3. Credits: about 82 to the first verdict, and the balance falls 20–90% more than the logs show.
  4. Kane flakiness (`stuck.ap_stuck`, about 2× credit variance) appears as HARNESS, which blocks the agent.
  5. Email+password only.

### Top 5 product risks

1. **Kane dependency:** cost, account, version drift (0.10.6 replays bill), and recordings that aren't portable.
2. **Thin proof on real apps:** 0 real leaks found outside the seeded demo.
3. **The loop gap:** generated drafts aren't lockable, so the headline feature needs manual rework.
4. **Trust erosion from overclaims:** "0 credits", "about a second", "can't stop until fixed". TestMu engineers will spot the replay billing.
5. **Speed against Playwright:** 40–55 s per boundary replay against seconds.

### Top 5 highest-leverage improvements (impact ÷ effort)

1. Make the site, README and CLI agree on `npx notyours` and remove the broken gif. Copy only, about 25 min. (P0-1, P1-01, P1-02)
2. Correct the replay-cost and speed claims everywhere. About 25 min; small code strings. (P1-03)
3. State the measured time to the first verdict (about 10 min, about 82 credits) and make the dry-run estimate count login runs. About 20 min. (P1-11)
4. Make drafts lock-ready: emit a `viewerOwn` and fixed-URL template, or at least a warning in the draft. About 20 min for the comment, longer for code. (P1-10)
5. Close the confirmed false greens (P0-2, P0-3, P1-08) with tests. About 1.5 h of code; a freeze decision for the owner.

## 4. Findings

Severity: **P0** blocks a gate, is a false green, a privacy leak or a broken install. **P1** clearly loses points or misleads. **P2** is polish.

"Code" = touches `src/`, `dist/` or `package.json` (y/n). Effort is in minutes.

| id | sev | area | finding | evidence | why it matters | exact fix | effort | code |
|---|---|---|---|---|---|---|---|---|
| P0-1 | P0 | site / install | The site says notyours "isn't on npm yet". The GitHub tab is the default and the hero command is `npx github:Jasekeee/notyours init`. | site/index.html:43, :252-256; `npm view notyours version` → 0.2.1 | The install path contradicts the README and npm; the GitHub path builds for 1–3 min. | Delete `.note-np`. Make `#t-npm` selected and `#t-gh` "from GitHub (fallback)". `#cmd-hero` → `npx notyours init`. | 10 | n |
| P0-2 | P0 (low likelihood) | oracle | False green: a download body over 2 MB is truncated with no `unreadable` flag, so a token past 2 MB gives HELD. This reopens AUD-12 for downloads. | src/engine/oracle.ts:191 (and :202); the listener's flagged record is spliced out at :187 | A false green. Needs an export over 2 MB. | At :191 and :202 add `unreadable` when `r.body.length > MAX_BODY`. Add a fixture test. | 30 | y |
| P0-3 | P0 (Linux without lsof, docker-proxy, another user's process) | Stop hook | False green: `restartApp` kills only the PIDs `lsof` sees (`?? []`), then `waitForPort` succeeds on the **old** process, which is still listening. A subagent reproduced it on a local port with `lsof` off `PATH`: "restarted", the old server answered. | src/hooks/app-freshness.ts:117-131 | The replay judges stale code and reports GREEN. | Before spawning, require `listenersOn(port)` to be defined and empty and the port to refuse connections, else `restart-failed`. After spawning, require a different listener set. | 25 | y |
| P1-01 | P1 | README | The second image is a broken `assets/demo.gif` ("recording to come"), on GitHub **and** npm. | README.md:12-14; the GitHub contents API returns 404 | The first visual a judge sees is broken. | Delete lines 12-14 until a recording exists. | 1 | n |
| P1-02 | P1 | CLI / hooks | The npm build tells users and agents to run `npx github:Jasekeee/notyours` (APPROVE_COMMAND, HOOK_FIX, Stop "Repro"/"release", `/notyours-map` steps 1, 6, 7, `/notyours-check`). The hook launcher's last fallback is unpinned GitHub HEAD. | src/cli/program.ts:74 `NPX_CLI`; dist: 19 hits; `.notyours/bin/notyours-hook` in the natural-app copy | Slow, contradicts the README, and hooks may run a different version than the one installed. | `NPX_CLI = 'npx notyours'`; launcher fallback `npx --yes notyours@<version>`; update the string tests; ship 0.2.2. | 40 | y |
| P1-03 | P1 | claims | Replay cost and speed are overstated: "every later check is a 0-credit replay", `replay` help says "0 credits, about a second each", the dry run says "Replays after `notyours lock` are free", and the site shows "passing replay: 0 credits". | README.md:87; program.ts:147, :140, :172; commands.ts:418, :468; status.ts:128-130; demo.ts:207; doctor.ts:104; check-command.ts:4,8; site cards. Counter-evidence: E2E.md:66 (3.4 credits / 170 s for 4), STATUS.md:127, :249 | TestMu engineers know how replays are billed; this is the core claim. | "no authoring runs; about 0–1 credit and ~40–50 s per boundary (kane-cli 0.10.0)" everywhere. | 25 | y (strings) |
| P1-04 | P1 | site | The announcement bar says v0.2.0, not v0.2.1. | site/index.html:30 | Looks stale on release day. | `v0.2.1` with "app-start approval moved out of the project". | 2 | n |
| P1-05 | P1 | site | The hero claims "your coding agent can't stop until the server is fixed". | site hero `.lede` vs README hooks section (3 attempts, then escalation) | An overclaim the page itself contradicts ("attempt 1/3"). | "…the Stop hook blocks your coding agent and hands it the evidence (3 attempts, then it escalates to you)." | 3 | n |
| P1-06 | P1 | claims | "It never judges an old server" (README:234, CHANGELOG:85). "A Stop pass can cost about 0 credits" (README:236). "61 vs 48.8" (README:250; 48.8 has no committed source). The FAQ "Does my data leave my machine?" never says yes. | app-freshness.ts:189-194 (unknown → replay); STATUS.md:249 (0.73); STATUS.md:22-23 (81 vs 42.2) | Each is a checkable overstatement. | Use the corrected wordings from the claims subagent: "doesn't judge a server it knows is old…", "0.73 off the balance (0 logged)", "81 vs 42.2 (STATUS 'Fresh clone')", "Yes. Kane runs go through your TestMu account…". | 15 | n |
| P1-07 | P1 | claims | The kane-cli range disagrees: README "0.10.0–0.10.6 (tested both)", site "kane-cli 0.10.0 (pin it)". 0.10.6 was tested only with `demo --quick` plus replays, and its replay credits aren't counted by the budget. | README.md:20; site `.req`; docs/KANE_COMPAT.md:15, :26-31, :52-61 | Inconsistent, and brew installs the latest. | One sentence in both places: "0.10.0 (all numbers); 0.10.6 works but replays cost credits the daily cap doesn't count and runs take about 2×". | 5 | n |
| P1-08 | P1 | Stop hook | Without `app.start`, the stale-server check returns `unknown` and **replays** when there is no `lsof`, no visible listener, or no readable age. A test asserts this. | app-freshness.ts:189-194; stop.ts:220; app-freshness.test.ts:74 | The false-green class this check was added for. Only applies when `app.start` is unset (`init` sets it). | Return `stale` with "can't verify; set app.start" when the PIDs are undefined, or empty while the port answers, or the age is unknown. | 15 | y |
| P1-09 | P1 | oracle | The owner positive control is any-of across targets. A target that redirects everyone to login (a typo) gives no viewer hit and counts as held. | oracle.ts:260-263; probes.ts:244 | HELD while a declared target was never really tested. | Require the owner's token per target, else HARNESS naming the target. | 40 | y |
| P1-10 | P1 | closed loop | The drafts that `init`/`map` write target `{{record_url}}`. On kane-cli 0.10.0 such boundaries replay as HARNESS, so they can't be locked, and the agent loop never covers the user's own boundaries without a rewrite. The draft doesn't say so. | `.notyours/boundaries/_draft_notes-id-cross-user.yaml` (natural-app copy); README.md:131-133; STATUS.md:243-244 | The headline feature doesn't reach the user's app by default. | At least add a line to the draft header: "to lock it, use fixed URLs plus `viewerOwn` (see the demo)". Better, emit that template. | 15 / 90 | y |
| P1-11 | P1 | credits | The dry-run estimate is boundaries × 30 and ignores login recordings: ~30 printed for a boundary measured at 50.2. A known 120 vs 259 case is in STATUS. | commands.ts:50, :416; STATUS "Onboarding"; STATUS.md:257 | Credits are the user's money; a judge will compare. | Add login authoring runs for personas without a recording; print a range. | 20 | y |
| P1-12 | P1 | CLI exit codes | `replay` exits 0 when nothing is locked or a named id isn't locked. | commands.ts:479-482, :227-228 | A CI gate passes while checking nothing. | Exit 1 for missing or unlocked explicit ids; exit 2 for nothing locked unless `--allow-empty`. | 10 | y |
| P1-13 | P1 | CI | The badge workflow runs `test:unit`, which excludes engine.test.ts and cli.test.ts, where the AUD-01/12/13 and download regression tests live. They run only in e2e.yml (manual and nightly), which has no runs yet and whose header expects 8 timeouts. | package.json:22; .github/workflows/e2e.yml (cron `17 3 * * *`); `gh run list -w e2e.yml` → none | A false-green regression can merge green, and tonight's nightly will likely put a red X on main (inferred). | Remove `schedule:` (keep `workflow_dispatch`), or `continue-on-error: true`. Move the `judge()`-level cases into oracle.test.ts later. | 5 | n |
| P1-14 | P1 | demo | The demo's "No credits at all" link is `raw.githubusercontent.com/...report.html`, served as `text/plain` with `nosniff`, so it shows raw HTML. | src/cli/demo.ts:62; `curl -sI` → `content-type: text/plain`; the Pages copy is `text/html` | The no-credit path for a judge without credits looks broken. | Use `https://jasekeee.github.io/notyours/sample-report/report.html`. | 5 | y |
| P1-15 | P1 | repo | SECURITY.md and the issue config send reporters to private advisories, which are disabled. | `gh api repos/Jasekeee/notyours/private-vulnerability-reporting` → `{"enabled":false}` | A security tool with a dead report channel. | `gh api -X PUT repos/Jasekeee/notyours/private-vulnerability-reporting` | 1 | n |
| P1-16 | P1 (plausible) | Stop hook | The Stop hook is installed with `timeout: 900`. Many dirty boundaries or slow targets can exceed it, and a timed-out hook is likely non-blocking. | src/cli/hooks.ts:288; STATUS Stop passes 62–535 s | Leaks may go unchecked when the agent stops. | An internal deadline of about 780 s; boundaries not reached stay dirty and the hook exits 2. | 30 | y |
| P1-17 | P1 (plausible) | oracle | A `kind: guest` boundary whose viewer has credentials is tested logged in. | commands.ts:94-101; session.ts:99; ratchet.ts:113-114 | HELD while an anonymous visitor would see the data. | Refuse guest boundaries whose viewer isn't a credential-less guest. | 10 | y |
| P2-01 | P2 | errors | When the app dies mid-run, the error blames credentials: "Could not log alice in (stuck.ap_stuck). Check its email/password in .notyours/secrets.json", plus a generic "run notyours doctor". | section 5 log; Kane's recorded condition was "This site can't be reached" | Sends the user to the wrong fix; it took me about 10 min to diagnose. | Check that the app is still up before blaming the login, and name the dead URL. | 20 | y |
| P2-02 | P2 | demo output | It prints "~50–60 Kane credits", then "Authoring 1 boundary with Kane (~30 credits)". Quick is measured at 60.90–61.69. | demo.ts:50-52; commands.ts:110 | Two numbers that disagree in one screen. | "~60", and drop or align the per-boundary line. | 5 | y |
| P2-03 | P2 | map | Noisy drafts: 6 of 10 on natural-app are plan-gate (`signup-`, `login-`, `root-`, `account-plan-plan-gate`). A plain `init` therefore signs up a third persona (about 9 credits). | init output in section 5; STATUS "Onboarding" | Triage burden and wasted credits. | Restrict `PLAN_RE` to conditions (`plan ===`, `isPro`), not the word "plan" in templates. | 30 | y |
| P2-04 | P2 | wizard | `init` signs personas up (about 30 credits) with no confirmation; the only prompts are start, port, URL and hooks. | src/cli/wizard.ts:199-203 | It spends money without a yes. | `yesNo('Sign up N personas with Kane (~X credits)?')` when interactive. | 10 | y |
| P2-05 | P2 | CLI | `run --dry-run` with only drafts exits 2 with "how to fix: run `notyours doctor`". | this audit (section 5) | Wrong hint; doctor can't help. | Hint: "finish a draft (drop `_draft_`) or run /notyours-map". | 5 | y |
| P2-06 | P2 | Stop hook | The Stop hook loads `_draft_*.yaml`; `run` and `replay` don't. A leftover draft next to its finished copy blocks every stop as a "duplicate id". | src/ratchet/store.ts:93-94 vs src/cli/workspace.ts:101 | A confusing permanent block (it fails closed). | Skip `_draft_` in `boundaryFiles`. | 5 | y |
| P2-07 | P2 | launcher | Once `stop_hook_active` is set, a crashing CLI (exit ≠ 0/2) lets every later stop through. | src/cli/hook-launcher.ts:34, :75-80; stop.ts:358 comment | A narrower fail-open than documented. | Document it, or count consecutive unavailable stops. | 15 | y |
| P2-08 | P2 | guard | `budget --set` from an agent through a pseudo-terminal (`script -q /dev/null …`) passes `isTTY`. | commands.ts:83-89 | The same class as the documented text-matching limit. | Add to Known limitations. | 2 | n |
| P2-09 | P2 | hooks | `permissions.deny` includes `Edit(./.claude/**)`, which blocks the agent from editing the user's own commands, agents and skills. | `.claude/settings.json` written by `setup claude` | A surprising side effect. | Deny only `.claude/settings*.json` and the notyours command files. | 10 | y |
| P2-10 | P2 | freshness | Restart and freshness use `app.port` or the base-URL port, not the ports in the locked target URLs; `init` doesn't check that they match. | app-freshness.ts:167; wizard.ts:119-120 | A stale GREEN on multi-port setups. | Warn in `init` on a mismatch. | 15 | y |
| P2-11 | P2 | status / map | Bare status says "Next: notyours init" (not on `PATH` for npx users). `map` in an empty folder writes `.notyours/` and scans 0 routes. | hygiene subagent run | Small first-run friction. | Echo `npx notyours init`; refuse `map` without a package.json. | 20 | y |
| P2-12 | P2 | docs | README cites a "Judge path" STATUS section that doesn't exist. The fallback build is "about 1–2 min" against a measured 81 s and 2 m 46 s. "Same answer on each replay" overstates it. The "fails closed" exception is undisclosed. | README.md:163, :49, :186, :231 | Small accuracy nits. | Use the wordings from the claims subagent. | 10 | n |
| P2-13 | P2 | release | The v0.2.1 release body has no install line; v0.2.0 has no release; the CHANGELOG 0.2.0 heading has no date; CHANGELOG isn't in the tarball; no GitHub social preview is set. | `gh release view v0.2.1`; package.json `files`; `usesCustomOpenGraphImage:false` | Polish. | Add an install line and a date; upload the preview in Settings. | 10 | n (`files`: y) |
| P2-14 | P2 | repo | DONE_A..D, DONE_REL/SITE/UX.md, spike/ and 10 merged branches are public. Personal author email on 112 of 148 commits (also npm maintainer metadata). | `git ls-tree main`; hygiene subagent | Noise. The email can't be removed without a force-push (forbidden). | `git rm` the handoff files in a normal commit, delete merged branches, use the noreply address from now on. | 10 | n |
| P2-15 | P2 | site | Missing canonical, `og:type`, `og:image:alt` and twitter title and description. h1 → h3 jump inside the hero mock. `--dim` measures 4.37:1 on `--surface-2`. About 730 px of blank space on mobile before the loop plays. "Works with Next.js" (scan only). OWASP "of the applications OWASP tested". | site/index.html; screenshots in the subagent's scratch | Polish. Reduced motion, focus and links are fine. | Per the website subagent's report. | 30 | n |
| P2-16 | P2 | STATUS | The CI row says local `npm test` is red with 14 failures; today it is 391/391 green. | docs/STATUS.md:308 | Stale. | Update the row. | 2 | n |

**v0.1.5 false-green fixes, re-checked: all hold in 0.2.1.**
- Oracle error, 5xx and over-2 MB on the listener path give HARNESS (oracle.ts:298-307, :128-135).
- Every content type is scanned (oracle.ts:123-125).
- AUD-13 holds (probes.ts:271-275).
- In the Stop hook, an invalid boundary file, a duplicate id, HARNESS, an exception or an escalation each blocks (stop.ts:157-176, :200-257, :272-282).
- A crash exits 2 (commands.ts:605-612).
- The approval is keyed on the exact command, port and realpath (src/hooks/app-approval.ts:69-72).
- `budget --set` refuses any `CLAUDE*` variable (commands.ts:83-89).
- `npm run typecheck` is clean. `test:unit` passes 299/299 in 5 s. A full local `vitest run` passes 391/391 in 151 s.

**Privacy and hygiene: clean.**
- The tarball is 40 files, 100 kB. No secrets, real emails, `/Users/` paths or Test Manager links, in the tarball or anywhere in git history.
- The site's sample report is redacted.
- `npm audit`: 0 vulnerabilities.

## 5. Judge walkthrough log

All commands use `npx notyours@latest` (0.2.1 from npm) in empty folders under `/tmp`. Times are wall-clock.

| # | Step | Time | Credits | Result / notes |
|---|---|---|---|---|
| 1 | `npx --yes notyours@latest --version`, empty npm cache (hygiene subagent) | 85.9 s | 0 | `0.2.1`. Prints nothing while installing: a silent wait. |
| 2 | `npx notyours@latest doctor` (warm cache) | 12 s | 0 | 6 ✓, "Ready.", balance 8951. No email printed. |
| 3 | `npx notyours@latest demo --quick` in `/tmp/ny-audit-demo` | 394 s | 29.10 logged / 37.17 off the balance | **Invalid run, my error.** About 1 min in, I ran `pkill -f "node server.js"` to stop natural-app, and it also killed the demo's `node server.js` on :3077. Kane's recorded wait condition was "This site can't be reached", and no login session reached the demo database. notyours reported "Could not log alice in (stuck.ap_stuck). Check its email/password…", exit 2 (see P2-01). |
| 3a | What the demo printed before failing | n/a | n/a | The estimate up front ("~4 min, ~50–60 credits, 4 authoring runs"), the report path first, a start line per Kane run and a 30 s heartbeat (all good). Also "~30 credits" for the same work (P2-02), and a raw-HTML sample-report link (P1-14). |
| 3b | Re-run in a fresh folder | n/a | n/a | **Refused** by the session's permission classifier (a retry of authoring runs, against CLAUDE.md). Not attempted again. **The npm demo verdict is unverified in this audit.** Last measured LEAK_VISIBLE: STATUS "Fresh clone, v0.2.0" (tarball install). |
| 4 | natural-app copy (data removed); 3 accounts created with `curl` POST `/signup` | about 1 min | 0 | Gives `init --users` 0 sign-up runs and kept this audit inside the 6-run cap. |
| 5 | `npx notyours@latest init --users users.yaml` in a pseudo-terminal, all defaults accepted | **8 s** | 0 | Detected express, `npm start`, port 4000. Four prompts. Personas listed. 17 routes, 10 drafts (6 plan-gate, P2-03). Hooks installed. `.gitignore` gets secrets, profiles, runs, tests and evidence; `secrets.json` is mode 0600. The approval was recorded in the account config. |
| 6 | `npx notyours@latest` (bare status) | 3 s | 0 | Clear: "boundaries 0, drafts 10, Next: /notyours-map (in Claude Code)". It shows "✓ app" although nothing was listening (configuration only). |
| 7 | `npx notyours@latest run --dry-run` (drafts only) | 6 s | 0 | Exit 2, with a wrong "run doctor" hint (P2-05). |
| 8 | `npx notyours@latest setup claude` | 4 s | 0 | Hooks, launcher, `/notyours-map` and `/notyours-check` installed. `/notyours-map` tells the agent to use `npx github:…` (P1-02). |
| 9 | Hand-written `notes-id-cross-user` boundary, then `run --dry-run` | about 1 min + 3 s | 0 | "~30 Kane credits (authoring). Replays after `notyours lock` are free." STATUS measured 50.2 for this boundary (P1-11, P1-03). The target is `{{record_url}}`, so it can't be locked (P1-10). |
| 10 | Guard hook latency, 3 PreToolUse Read calls through `.notyours/bin/notyours-hook` | 0.20–0.22 s each | 0 | A Read of `.notyours/secrets.json` is denied with a clear reason. |
| 11 | `run` on natural-app | not run | n/a | Skipped to stay within the credit cap. Repo measurement: 4 m 44 s, 50.2 credits, HELD (STATUS "Onboarding"). |

Confusions a judge would hit, in order:
1. The site says "not on npm" while the README says `npx notyours`.
2. The README's top image is broken.
3. The demo's "no credits" link shows raw HTML.
4. Three different credit numbers (50–60, 30, 61.69).
5. After `init`, there is nothing to run without Claude Code or hand-written YAML.
6. A failure message that points at the wrong cause.

## 6. "Do NOT do" before Nov 26

- Don't rewrite git history to remove the author email (force-push is forbidden; it would break tags and the npm `gitHead`).
- Don't upgrade or re-pin kane-cli, or re-measure on 0.10.6. Every number in the docs is from 0.10.0.
- Don't refactor the oracle's per-target controls (P1-09) or the Stop deadline (P1-16) now. Log them under Known limitations; both touch the verdict path.
- Don't commit Kane recordings to make the demo "portable" (they carry account ids and typed passwords).
- Don't chase the 8 CI engine timeouts, and don't delete e2e.yml. Just drop its `schedule:`.
- Don't re-run the full demo or the loop repeatedly to refresh numbers (credits and flakiness). One recording for the README gif, if any.
- Don't add a dependency for gif or recording tooling (CLAUDE.md).
- Don't republish 0.2.1 or unpublish it. Any code change means 0.2.2, and then re-run the fresh-folder npm path (`doctor`, `demo --quick`) before announcing.
- Don't run `npm audit fix --force`, and don't rename CLI commands or flags.
- Don't turn the site's "0 false alarms" natural-app result into "found leaks" wording. It found none, and the page discloses that honestly.

## 7. Kane credits spent

| Run | Authoring runs | Logged credits | Balance |
|---|---|---|---|
| `demo --quick` from npm (both login recordings failed after the auditor killed the demo app) | 2 | 29.10 (alice 18.70, bob 10.40) | 8951 → 8913.83 (**37.17**, 28% above the logs) |
| Re-run of `demo --quick` | 0 (refused before start) | 0 | n/a |
| natural-app `init --users`, dry runs, `setup claude` | 0 | 0 | n/a |
| **Total** | **2 of the 6 allowed** | **29.10** | **37.17** |

Subagents (website, claims, correctness, package and repo hygiene, alternatives research) spent 0 Kane credits.
