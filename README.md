# notyours

**Prove your users' data stays theirs.** notyours runs your app on localhost, signs in as several users, and checks
that one user's data never reaches another user's browser.

![notyours demo (recording to come)](assets/demo.gif)

<!-- assets/demo.gif is not recorded yet. Replace this line and the placeholder above when it exists. -->

> Isolation tests for your own app. Not a penetration test.

## Quickstart

You need Node 22+, Google Chrome, and [kane-cli](https://www.testmuai.com/kane-cli/) **0.10.0**, logged in.
notyours isn't on npm yet, so run it from GitHub:

```sh
brew install lambdatest/kane/kane-cli        # macOS: installs 0.10.0
npm i -g @testmuai/kane-cli@0.10.0           # anywhere else; pin it, plain install gets 0.10.6
kane-cli login
npx github:Jasekeee/notyours doctor          # checks Node, Chrome, kane-cli version and login, credits, port 3077
npx github:Jasekeee/notyours demo --quick    # one real leak in the bundled demo app, about 5 minutes
```

Then point it at your own app. It needs your app's URL and a file of test accounts:

```sh
npx github:Jasekeee/notyours init --url http://localhost:3000 --users users.yaml
npx github:Jasekeee/notyours map             # static scan of Express / Next.js routes -> draft boundaries
```

Finish the drafts (by hand, or with `/notyours-map` in Claude Code), then:

```sh
npx github:Jasekeee/notyours run --dry-run   # validates boundaries and prints the credit estimate; starts nothing
npx github:Jasekeee/notyours run             # proves them with Kane (costs credits)
npx github:Jasekeee/notyours lock            # records proven boundaries; later checks are replays
npx github:Jasekeee/notyours replay          # re-checks locked boundaries; no authoring
```

`users.yaml` lists your test accounts. Use test accounts, never real users' passwords. Passwords can come from the
environment and are stored only in `.notyours/secrets.json` (gitignored, mode 0600, never printed):

```yaml
users:
  - { id: alice, role: owner, plan: pro, email: alice@test.local, passwordEnv: ALICE_PASSWORD }
  - { id: bob, role: viewer, plan: free, email: bob@test.local, passwordEnv: BOB_PASSWORD }
  - { id: guest, role: guest }
  - { id: free_user, role: free, plan: free, email: free@test.local, passwordEnv: FREE_PASSWORD }
```

**Measured, not promised.** The times below come from [docs/STATUS.md](docs/STATUS.md) and [docs/E2E.md](docs/E2E.md),
on kane-cli 0.10.0. The demo prints its estimate before it starts.

## Why

OWASP ranks Broken Access Control first in its
[Top 10:2021](https://owasp.org/Top10/2021/A00_2021_Introduction/index.html). The usual causes are small: a query
without `where owner_id = ?`, a list endpoint that returns every row, a paid page that hides its button but still
serves the data.

Unit tests rarely catch these, because they run one user at a time. notyours signs in as several users at once, in
separate real Chrome browsers, and checks what each one can actually see. More in [docs/WHY.md](docs/WHY.md).

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

- **Kane CLI** drives one Chrome per persona. It signs up or logs in, creates data, and opens pages, as a user would.
- **The canary-token oracle** decides. Each owner's record carries a token such as `NY-ALICE-K7Q2MZX4P3RA`. The
  oracle watches the DOM and network in every persona's browser and looks for that token. Nothing is judged by an AI.
- **The ratchet** turns each proven boundary into a recorded Kane test. Replays re-check it without authoring.

A boundary says "this identity must not see that identity's data":

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

This example proves a fresh note each run. To **lock** a boundary (replay it on every stop), give it fixed URLs instead,
such as `/notes/1001` and a `viewerOwn` page, as the demo's boundaries do. On kane-cli 0.10.0 a replay doesn't return
the values a run stored (`{{note_url}}`), so a locked boundary built on them replays as HARNESS.

## Verdicts

| Verdict | Meaning |
|---|---|
| **LEAK** (visible) | The owner's token appeared in the viewer's rendered page. |
| **LEAK** (in payload) | The owner's token reached the viewer's browser in a network response, even though the page didn't show it. Still a leak: anyone can open DevTools. |
| **HELD** | The viewer never received the owner's token, and both positive controls passed. |
| **HARNESS** | A positive control failed, so the probe proves nothing. This is never counted as a pass. |

The token decides. Kane's own pass/fail and page-title judgements are never used as a verdict.
`run` and `replay` exit 1 when anything leaked or couldn't be judged, so they work as a CI gate.

**Positive controls.** A probe that "found nothing" only counts if it could have found something. Every probe checks
that the owner sees their own token, and that the viewer sees their own token. If either fails, the verdict is
HARNESS, not HELD.

## What it catches (measured on the demo)

The bundled demo app, Jotter, has three seeded bugs. Its results on kane-cli 0.10.0 (docs/E2E.md, run 1):

| Boundary | Expected | Verdict |
|---|---|---|
| B1: Bob opens Alice's note | leak (seeded bug) | **LEAK_VISIBLE** |
| B2: guest opens notes | held | **HELD** |
| B3: free user gets the Pro export | leak (seeded bug) | **LEAK_PAYLOAD** |
| B4: Bob sweeps the note list | held | **HELD** |

The loop is also measured: a regression makes `replay` exit 1 with LEAK, and the fix makes it exit 0 with GREEN
(docs/STATUS.md, "Judge path"). That loop was measured on the demo app. Runs against a second app, with its results,
are in [docs/natural-app/](docs/natural-app/).

## What it doesn't catch

- **Anything you didn't write a boundary for.** It checks the boundaries you declare, not your whole app.
- **Logins other than email + password.** No CAPTCHA, OAuth-only sign-in, SMS or authenticator codes.
- **Text only.** The oracle reads DOM text and network bodies. A token inside an image or PDF is out of scope.
- **Hosts other than localhost by default.** Other hosts need `--allow-host` and a typed confirmation.
- **Code the boundary's `surface` doesn't list.** A replay runs only when a listed file changes. A regression in
  shared middleware you didn't list isn't replayed until one of the listed files changes.
- **Route discovery is a heuristic.** `map` is a static scan. Express router mount prefixes aren't resolved.
- **Database rules.** It sees what your running app returns to a browser. It does not read your database policies.
- **Stuck steps.** Some Kane steps get stuck, for example a guest visit at a login redirect. That boundary can't be locked.

Full list with measurements: [Known limitations](docs/STATUS.md#known-limitations).

## Compared with other approaches

No head-to-head benchmark has been run. These are trade-offs from how each approach works.

- **Penetration-testing agents and scanners** explore your app and look for many kinds of flaw. They find problems
  nobody wrote a test for. notyours only checks boundaries you declare, but each check has a fixed verdict rule
  (the token either reaches the viewer or it doesn't), so the same boundary gives the same answer on each replay.
- **Row-level-security and database policy scanners** read the rules in your database. notyours tests what the running
  app returns. It can catch an application route that bypasses the policy. It does not verify the policies.
- **Hand-written role tests** are cheap to run and need no browser, no Kane account and no credits. They are only as
  good as the cases someone thought to write. notyours runs real browsers as real users, and locks what it proves.
  Its costs are Kane credits and the kane-cli setup. Keep your own role tests too.

## FAQ

**Does it need an AI API key?** No. Kane drives the browsers, and the verdict comes from the canary token.

**What does it cost?** Kane credits from your TestMu AI account. Measured: the quick demo used 61.69 credits (4 m 48 s).
A replay of four locked boundaries used 3.4 credits (170 s). The demo prints its estimate before it starts, and
`run --dry-run` prints one without starting Kane. `.notyours/credits.log` records every Kane run. A per-project daily cap on authoring runs (default 20) is enforced by the CLI.

**Does my data leave my machine?** Kane runs are tied to your TestMu AI account. Test Manager links are written to
`.notyours/runs/` and evidence packs to `.testmuai/evidence/`. These hold your account email and share links, and
`init` keeps them out of git. Do not publish them.

**Which frameworks does it understand?** The route scan reads Express and Next.js code. Any app that runs on a URL can
still be tested, but you write its boundaries by hand.

**Can it run in CI?** Yes. `run` and `replay` exit 1 on a leak or a check that couldn't be judged. Replays cost no
authoring runs, but each replay still uses Kane and its credits (see below).

**Can my coding agent cheat?** The guard hook blocks an agent's edits to locked boundaries, recordings, run results,
budget and config. It's a guardrail for a cooperating agent, not a sandbox. See the hooks section.

**Why `npx github:Jasekeee/notyours`?** notyours isn't published to npm yet.

## Claude Code hooks and the read-only guard

```sh
npx github:Jasekeee/notyours install-hooks   # --cli "<command>" to choose the CLI yourself
```

This merges three hooks and a few `permissions.deny` rules into `.claude/settings.json`, keeping your own settings,
and installs the `/notyours-map` command.

- **guard** (PreToolUse) makes the oracle read-only for the agent: locked boundaries, Kane recordings (`.testmuai/`),
  run results, `config.yaml`, secrets and browser profiles. It can still read them and can write new or unlocked
  boundaries.
- **post-tool** (PostToolUse): when the agent edits a file in a boundary's `surface`, that boundary is marked for re-checking.
- **stop** (Stop): before the agent finishes, changed locked boundaries are replayed. A leak blocks the stop and hands
  the agent the evidence. A check that couldn't run blocks too. After 3 failed attempts the boundary is escalated to
  you (`ESCALATION.md`); `notyours release` lifts it and is refused from a coding agent.

The hooks **fail closed**: each runs `.notyours/bin/notyours-hook`, which finds the CLI. If it can't, the hook blocks
with "notyours guard unavailable". `doctor` checks that every installed hook resolves.

- **It never judges an old server.** With `app: { start: "node server.js", port: 3000 }` in `.notyours/config.yaml` it
  restarts your app before replaying. Without it, if the server is older than your code, it stops and asks for a restart.
- **Personas that are still signed in skip the login replay.** A Stop pass can cost about 0 credits.

## Credit costs

| Action | Kane credits |
|---|---|
| First run of a boundary (authoring) | about 5–30 per Kane run on the demo (varies about 2× for the same task) |
| Each persona's first login on a machine | one authoring run, then replayed |
| `replay` and the Stop hook | about 0–1 per boundary when it passes (kane-cli 0.10.0); a few credits when Kane marks a replay failed |
| `doctor`, `map`, `report`, `run --dry-run` | 0 |

On kane-cli 0.10.6 replays cost more and runs take longer. See [docs/KANE_COMPAT.md](docs/KANE_COMPAT.md).

notyours refuses to start authoring runs when your balance is below `creditFloor` (default 300, in
`.notyours/config.yaml`). The account balance can drop a little more than the logs show (measured: 61 vs 48.8 for the
quick demo).

```sh
npx github:Jasekeee/notyours budget          # today's authoring runs vs the cap
npx github:Jasekeee/notyours budget --set 40 # raise it (a person only; refused from a coding agent)
```

## Roadmap

Not built yet:

- Per-target positive controls (today one control covers all of a boundary's targets).
- Whole-text DOM matching (the DOM is scanned per text node, so a token split across elements isn't seen).
- Replays that re-derive stored values (locked boundaries need fixed URLs today).
- Replaying boundaries when shared files change, not only when listed `surface` files change.
- Evaluating kane-cli 0.10.6 as the default, and a `doctor --replay-selftest` for the 0.10.0 quirks.
- Recordings that replay without the account ids of the machine that recorded them, so a demo can replay instead of author.

## Known limitations

The full list, with measurements, is in [docs/STATUS.md](docs/STATUS.md#known-limitations). The most important:

- **The guard is a guardrail, not a sandbox.** It matches text, so a determined agent with shell access can find spellings it doesn't anticipate.
- **Replays aren't instant.** A one-boundary Stop takes about 55 s on kane-cli 0.10.0, mostly Kane and Chrome time.
- **Reports are for you, not for publishing as-is.** `report.json` lists local screenshot paths, and `results.json` holds Test Manager links.

## Development

```sh
npm install
npm run typecheck && npm test
npm run dev -- doctor              # run the CLI from source
NOTYOURS_DEMO_DIR=./demo npm run dev -- demo --no-open
```

Secrets live only in `.env` / `.notyours/secrets.json` (both gitignored). After cloning, enable the repo's
secret-blocking pre-push hook:

```sh
git config core.hooksPath .githooks
```

## License

MIT
