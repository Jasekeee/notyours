# notyours

**Prove your users' data stays theirs.** notyours signs in as Alice, Bob, a guest and a free user,
has Alice create a record that contains a unique canary token, then has Bob go looking for it.
If Alice's token ever reaches Bob's screen or Bob's browser, that's a leak, with the URL, the
snippet and a screenshot to prove it. Your coding agent gets the leak back as a failing check and
fixes the code, and the fixed boundary becomes a free replayable test.

> Not a pentest tool — isolation tests for your own app.

## The 60-second pitch

Most data leaks between users aren't clever exploits. They're a missing `where owner_id = ?`, a
list endpoint that returns everyone's rows, or a Pro page that only hides its button. Unit tests
rarely catch them because they never run as two real users at once.

notyours does exactly that, in real browsers:

- **Kane CLI** drives one Chrome per persona and does what a user would do (sign in, create a note,
  open a link).
- **A canary-token oracle** decides. A token looks like `NY-ALICE-K7Q2MZX4P3RA`, so a match can't be
  a coincidence and nothing depends on an AI judging the page.
- **The ratchet** turns every proven boundary into a recorded Kane test. Replays cost no authoring
  (a passing replay is 0 credits; a replay Kane marks failed costs a few credits of triage) and take
  about 40–50 s per boundary including the oracle's own checks, so they run every time your agent stops.

## Install

Requires Node 22+. notyours isn't on npm; run it straight from GitHub. The first `npx` run downloads and builds it
(about 1–2 min with an empty npm cache, and it prints almost nothing meanwhile). If npx asks `Ok to proceed?`, answer `y`.

```sh
npx github:Jasekeee/notyours demo
```

That single command runs the whole thing against a bundled demo app. In your own project:

```sh
npx github:Jasekeee/notyours doctor   # Node 22+, Chrome, kane-cli login + credits, port 3077
```

You also need Google Chrome and an authenticated [kane-cli](https://www.testmuai.com/kane-cli/)
(`kane-cli login`). No Claude API key is needed.

## Judges' quick start

You need Node 22+, Google Chrome, and an authenticated [kane-cli](https://www.testmuai.com/kane-cli/)
(`kane-cli login`). `npx github:Jasekeee/notyours doctor` checks all of it, including the kane-cli version, and tells you how
to fix anything that isn't ready.

**(a) No credits: the sample report.** A redacted result of the full demo: 2 leaks, 2 held. It has no screenshots,
emails, account ids or links. GitHub shows `.html` files as source, so download it and open it in your browser:

```sh
curl -sLO https://raw.githubusercontent.com/Jasekeee/notyours/main/docs/sample-report/report.html && open report.html   # Linux: xdg-open
```

**(b) One real leak: `npx github:Jasekeee/notyours demo --quick`.** B1 only: Bob opens Alice's note.
~4 min, ~45 Kane credits (4 authoring runs: both personas' first login, then B1). Expect `LEAK_VISIBLE` with both
positive controls passing.

**(c) The full demo: `npx github:Jasekeee/notyours demo`.** B1–B4. ~10–11 min, ~120–165 Kane credits (measured
2026-11-19 on a clean machine setup: 10 min 49 s, 163 credits). Expect B1 LEAK, B2 HELD, B3 LEAK (a
free user gets the Pro export through the API), B4 HELD.

Both modes print the expected time and credits before they start. Times are measured on kane-cli 0.10.0. On
**0.10.6, expect about 2.5× longer**, with replays that cost a few credits ([docs/KANE_COMPAT.md](docs/KANE_COMPAT.md)).

**(d) The loop with Claude Code.** Make a demo copy, install the hooks, and let Claude Code drive notyours:

```sh
npx github:Jasekeee/notyours demo --dir ~/jotter-loop --no-open   # a copy of the demo app, proved once
cd ~/jotter-loop && npx github:Jasekeee/notyours install-hooks     # guard + post-tool + Stop replay hooks
node server.js &                                  # keep the app running on :3077
claude "Run npx github:Jasekeee/notyours run, fix every leak it reports in the server code (not the tests), \
        rerun until all boundaries hold, then npx github:Jasekeee/notyours lock. Then add a 'duplicate note' button."
```

Once the boundaries are locked, every edit Claude makes to their code is replayed when it stops. A leak blocks the
stop with the evidence, Claude fixes the access check, and the next replay is GREEN. Recorded runs are in
[docs/loop-run-1/](docs/loop-run-1/)–[3](docs/loop-run-3/). Authoring runs are capped per project per day (20 by
default); see below.

**Honest notes**
- **Jotter's bugs are seeded on purpose.** Each is labelled `// SEEDED BUG #n` in `demo/routes/`. Jotter's own
  tests, which assert those bugs, stay in this repo and are never copied into a demo.
- **Why the demo authors instead of replaying:** Kane recordings only replay with the TestMu account ids of the
  machine that recorded them, so notyours never commits them (`.notyours/tests/` is gitignored; recorded logins also
  hold the typed password). Every fresh demo records its personas' logins and boundaries once. Rerun with
  `--dir <folder>` to replay them.
- **The report** opens with a headline like **"Bob saw Alice's data"**, then one card per boundary: the verdict,
  who tried what, the positive controls, where the token showed up (highlighted), screenshots of hit pages, and
  the credits each one used.

## How it works

```
  map       static scan of Express / Next.js routes  ─▶  draft boundaries
     │
  agent     /notyours-map: your coding agent reads the code, writes real boundaries
     │
  run       Kane as Alice ─▶ creates a record containing NY-ALICE-…
            Kane as Bob   ─▶ visits the targets      ◀── live DOM + network capture
     │
  oracle    did NY-ALICE-… reach Bob?  ─▶  LEAK · HELD · HARNESS
     │
  lock      record it; every later check is a 0-credit replay
     │
  report    report.html + report.json  ─▶  leaks go back to your coding agent
```

```sh
npx github:Jasekeee/notyours init --url http://localhost:3000 --users users.yaml
npx github:Jasekeee/notyours map                  # writes .notyours/boundaries/_draft_*.yaml and .notyours/map.json
# in Claude Code: /notyours-map   # the agent turns drafts into real boundaries
npx github:Jasekeee/notyours run --dry-run        # validate + credit estimate, starts nothing
npx github:Jasekeee/notyours run                  # prove them with Kane (authoring)
npx github:Jasekeee/notyours lock                 # record them
npx github:Jasekeee/notyours replay               # no authoring; ~40–50 s per boundary
npx github:Jasekeee/notyours report --open
```

`users.yaml` lists your test accounts. Passwords can come from the environment and are stored only
in `.notyours/secrets.json` (gitignored, mode 0600, never printed):

```yaml
users:
  - { id: alice, role: owner, plan: pro, email: alice@test.local, passwordEnv: ALICE_PASSWORD }
  - { id: bob, role: viewer, plan: free, email: bob@test.local, passwordEnv: BOB_PASSWORD }
  - { id: guest, role: guest }
  - { id: free_user, role: free, plan: free, email: free@test.local, passwordEnv: FREE_PASSWORD }
```

A boundary (`.notyours/boundaries/notes-cross-user.yaml`):

```yaml
id: notes-cross-user
kind: cross-user            # cross-user | guest | plan-gate | sweep
owner: alice                # plants the token
viewer: bob                 # must not see it
create:
  objective: Go to http://localhost:3000/notes/new, type '{{token}}' as the title, save, store the URL as 'note_url'
  store: [note_url]
targets:
  ui: ['{{note_url}}']
  api: ['http://localhost:3000/api/notes']
expect: denied
surface: ['src/routes/notes.ts']   # code handed to your agent if this leaks
```

## Verdict rules

| Verdict | Meaning |
|---|---|
| **LEAK** (visible) | The owner's token appeared in the viewer's rendered page. |
| **LEAK** (in payload) | The owner's token reached the viewer's browser in a network response, even though the page didn't show it. Still a leak: anyone can open DevTools. |
| **HELD** | The viewer never received the owner's token, and both positive controls passed. |
| **HARNESS** | A positive control failed, so the probe proves nothing. This is never counted as a pass. |

The token decides. Kane's own pass/fail and page-title judgements are never used as a verdict.
`run` and `replay` exit 1 when anything leaked or couldn't be judged, so they work as a CI gate.

## Positive controls

A probe that "found nothing" only counts if it could have found something. Every probe checks:

- **The owner sees their own token.** This proves the record was created and the token is visible
  where we look.
- **The viewer sees their own token.** This proves the viewer is signed in and the capture works in
  their browser.

If either fails, the verdict is HARNESS (yellow), not HELD (green).

## The ratchet

`notyours lock` turns a proven boundary into a recorded Kane test (it reuses the proving run's own
recordings, so locking itself costs nothing). From then on, `notyours replay` re-checks it without
authoring: the recorded runs replay and the oracle judges, even when a replay diverges because the app
changed. Measured on the demo: ~3 min and ~3–7 credits for all four boundaries (docs/E2E.md). Locked boundaries only move one way: once a boundary
holds, a later leak is a regression your agent has to fix in the app code, not in the test.
Use `lock --reauthor` to re-record when the UI changes enough that a replay no longer applies.

## Claude Code hooks and the read-only guard

```sh
npx github:Jasekeee/notyours install-hooks   # --cli "<command>" to choose the CLI yourself
```

This merges three hooks and a few `permissions.deny` rules (for the secrets and the oracle) into
`.claude/settings.json`, keeping your own settings, and installs the `/notyours-map` command.

The hooks **fail closed**. Each one runs `.notyours/bin/notyours-hook`, a small launcher that finds the CLI
(the project's `node_modules`, the CLI you installed from, PATH, then `npx github:`). If it can't find or start one,
the hook blocks (exit 2) with "notyours guard unavailable — run `npx github:Jasekeee/notyours install-hooks` (or
doctor)". The Stop hook still lets a second stop in a row through, so a session can't get stuck. `doctor` checks
that every installed hook resolves. The hooks:

- **guard** (PreToolUse) makes the oracle read-only for the agent. It can't edit locked boundaries,
  Kane recordings (`.testmuai/`), run results or `config.yaml`. It can't read
  `.notyours/secrets.json` or the browser profiles. It can't approve a new host for itself
  (`--allow-host` / `--i-own-this` are the human's call). It can still read all of them, and it can
  write new or unlocked boundaries.
- **post-tool** (PostToolUse): when the agent edits a file in a boundary's `surface`, that boundary
  is marked for re-checking.
- **stop** (Stop): before the agent finishes, changed locked boundaries are replayed (no authoring).
  A leak blocks the stop and hands the agent the evidence and the code to fix. The hook
  itself never authors; unlocked boundaries are proved with `notyours run` (the agent may run it, within the
  daily budget below).

The guard is a guardrail for a cooperating agent, not a sandbox. It also keeps the hook config
(`.claude/settings*.json`) read-only, and in Bash it only allows read-only commands (ls, cat, grep,
jq, git diff, notyours replay/report) on those folders, without `$`, backticks, `~`, `../` or globs
on dot-paths. Use test accounts, never real users'
passwords, for your identities.

## Credit costs

| Action | Kane credits |
|---|---|
| First run of a boundary (authoring) | ~5–30 per Kane run (measured on the demo; varies 2× for the same task) |
| Each persona's first login on a machine | one authoring run (~10–17), then replayed for 0 |
| `replay`, the stop hook | 0 for a replay that passes; a few credits when Kane marks a replay failed (its triage) |
| `doctor`, `map`, `report`, `run --dry-run` | 0 |

notyours refuses to start authoring runs when your balance is below `creditFloor` (default 300,
in `.notyours/config.yaml`), and logs every Kane run's `credits_consumed` (`.notyours/credits.log`,
`.notyours/runs/credits.jsonl`).

### Coding agents and the daily budget

Your coding agent **may** drive notyours end to end: `notyours run`, `lock`, `demo`, `init` and
`install-hooks` work from Claude Code. That's the point: the agent and Kane interact. Credits are bounded by
a **per-project daily cap on authoring Kane runs** (default **20**, in `.notyours/budget.json`). Replays
don't count. When the cap is reached, the command prints what happened and how to continue, and exits
non-zero.

```sh
npx github:Jasekeee/notyours budget          # today's authoring runs vs the cap
npx github:Jasekeee/notyours budget --set 40 # raise it (a person only)
```

`budget --set` refuses to run from a coding agent's shell (Claude Code sets `CLAUDECODE=1` and gives the
agent no TTY), so an agent can't raise its own cap. CI can opt in with `NOTYOURS_ALLOW_AGENT_AUTHORING=1`.
The guard never lets the agent set that variable, or edit `budget.json` or the credit logs it is counted from.

## Known limitations

The full list, with measurements, is in [docs/STATUS.md](docs/STATUS.md). In short:


- **Logins:** email + password forms only. No CAPTCHA, no OAuth-only sign-in, no SMS or
  authenticator codes.
- **Text only:** the oracle reads DOM text and network bodies. Tokens inside images and PDFs are
  out of scope.
- **Localhost first:** `localhost` and `127.0.0.1` are allowed by default. Any other host must be
  added with `--allow-host <host>` *and* confirmed with `--i-own-this`, which asks you to type the
  host name in a terminal. That confirmation is stored on your machine (`~/.config/notyours/`), not
  in the repo, so neither a cloned `config.yaml` nor a coding agent can grant it. Boundaries that point anywhere else are refused.
- `map` is a static heuristic. It drafts, your coding agent decides, and Kane proves. Express
  router mount prefixes aren't resolved.
- **Replays aren't instant.** A 1-boundary Stop takes ~55 s on kane-cli 0.10.0 (Kane and Chrome time). On 0.10.6,
  replays are slower and cost a few credits.
- **The guard is a guardrail, not a sandbox.** It blocks a cooperating agent's edits to `.notyours/` and the hook
  config. Credits are protected by the daily budget, which the CLI enforces itself.

## Development

```sh
npm install
npm run typecheck && npm test
npm run dev -- doctor              # run the CLI from source
NOTYOURS_DEMO_DIR=./demo npm run dev -- demo --no-open
```

Secrets live only in `.env` / `.notyours/secrets.json` (both gitignored). After cloning, enable the
repo's secret-blocking pre-push hook:

```sh
git config core.hooksPath .githooks
```

## License

MIT
