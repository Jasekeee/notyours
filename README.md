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
- **The ratchet** turns every proven boundary into a recorded Kane test. Replays cost 0 credits and
  take about a second, so they run every time your agent stops.

## Install

Requires Node 22+.

```sh
npx notyours demo
```

That single command runs the whole thing against a bundled demo app. In your own project:

```sh
npm i -D notyours
npx notyours doctor        # Node 22+, Chrome, kane-cli login + credits, port 3077
```

You also need Google Chrome and an authenticated [kane-cli](https://www.testmuai.com/kane-cli/)
(`kane-cli login`). No Claude API key is needed.

## Judges' quick start

```sh
npx notyours doctor   # everything green? (it tells you how to fix anything that isn't)
npx notyours demo     # starts the demo app on :3077, probes it, opens the report
```

The report opens with a headline like **"Bob saw Alice's data: 2 leaks"**, then one card per
boundary: the verdict, who tried what, the positive controls, where the token showed up (with the
token highlighted), screenshots, links to the Kane test runs, and the credits each one used.
Demo boundaries that ship with a recording replay for 0 credits. Any boundary without one is
authored once (about 30 credits per Kane run), then locked. Rerun with `--dir <folder>` to reuse
that folder's recordings.

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
npx notyours init --url http://localhost:3000 --users users.yaml
npx notyours map                  # writes .notyours/boundaries/_draft_*.yaml and .notyours/map.json
# in Claude Code: /notyours-map   # the agent turns drafts into real boundaries
npx notyours run --dry-run        # validate + credit estimate, starts nothing
npx notyours run                  # prove them with Kane (authoring)
npx notyours lock                 # record them
npx notyours replay               # 0 credits, about a second each
npx notyours report --open
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

`notyours lock` turns a proven boundary into a recorded Kane test. From then on, `notyours replay`
re-checks it for 0 credits in about a second. Locked boundaries only move one way: once a boundary
holds, a later leak is a regression your agent has to fix in the app code, not in the test.
Use `lock --reauthor` to re-record when the UI changes enough that a replay no longer applies.

## Claude Code hooks and the read-only guard

```sh
npx notyours install-hooks          # or --cli "node ./node_modules/notyours/dist/cli/index.js"
```

This merges three hooks and a few `permissions.deny` rules (for the secrets and the oracle) into
`.claude/settings.json`, keeping your own settings, and installs the `/notyours-map` command:

- **guard** (PreToolUse) makes the oracle read-only for the agent. It can't edit locked boundaries,
  Kane recordings (`.testmuai/`), run results or `config.yaml`. It can't read
  `.notyours/secrets.json` or the browser profiles. It can't approve a new host for itself
  (`--allow-host` / `--i-own-this` are the human's call). It can still read all of them, and it can
  write new or unlocked boundaries.
- **post-tool** (PostToolUse): when the agent edits a file in a boundary's `surface`, that boundary
  is marked for re-checking.
- **stop** (Stop): before the agent finishes, changed locked boundaries are replayed for 0 credits.
  A leak blocks the stop and hands the agent the evidence and the code to fix. Unlocked
  boundaries are never re-authored automatically; the agent is told to ask you first.

The guard is a guardrail for a cooperating agent, not a sandbox. It also keeps the hook config
(`.claude/settings*.json`) read-only, and in Bash it only allows read-only commands (ls, cat, grep,
jq, git diff, notyours replay/report) on those folders, without `$`, backticks, `~` or `../`. Use test accounts, never real users'
passwords, for your identities.

## Credit costs

| Action | Kane credits |
|---|---|
| First run of a boundary (authoring) | about 30 per Kane run (varies about 2× for the same task) |
| `replay`, the stop hook, demo replays | 0 |
| `doctor`, `map`, `report`, `run --dry-run` | 0 |

notyours refuses to start authoring runs when your balance is below `creditFloor` (default 300,
in `.notyours/config.yaml`), and logs every Kane run's `credits_consumed` to
`.notyours/runs/credits.jsonl`.

## Limits

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
