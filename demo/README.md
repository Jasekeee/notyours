# Jotter: the notyours demo app

Jotter is a small notes app that notyours tests in the demo video.

**These bugs are seeded and labelled on purpose.** Jotter contains three authorization mistakes of
the kind coding agents often ship, so notyours has something real to find. Each one is marked in the
code with a `// SEEDED BUG #n` comment and pinned by a test. Everything else is meant to be correct,
including guest access. Don't copy this code into a real app, and don't expose it to a network. The
server only listens on `127.0.0.1`.

## Run it

```bash
node demo/server.js --seed      # reset the database to the fixed seed, then serve http://127.0.0.1:3077
node demo/server.js             # keep existing data (seeds automatically if the database is empty)
node demo/server.js --seed-only # reset and exit
```

Options: `--port <n>` (default 3077, or `$PORT`) and `--db <file>` (default `demo/data/jotter.sqlite`,
gitignored). The stack is Express 5, server-rendered HTML and sql.js (SQLite in WASM, no native modules).

## Seed

Re-seeding always produces the same users, note ids and URLs, so cached (0-credit) Kane replays
keep working.

| User | Plan | Password (dev default) | Seeded data |
|---|---|---|---|
| `alice@jotter.test` | Pro | `alice-jotter-dev`, or `$JOTTER_ALICE_PW` | note **1001** "Travel documents": `Passport no. <alice token>` |
| `bob@jotter.test` | Free | `bob-jotter-dev`, or `$JOTTER_BOB_PW` | note **1002** "Reminder": `<bob token>`; his `/account` bio also shows `<bob token>` |

New sign-ups are free users, and their notes start at id 1003.

**Canary tokens** are read from the first `identities.json` that exists: `$NOTYOURS_DIR/identities.json`,
then `demo/.notyours/identities.json`, then `./.notyours/identities.json`. The file may be an
`Identity[]` array or an object keyed by id. Only `token` is read, and invalid tokens are ignored.
Without a file the fixed defaults are `NY-ALICE-JOTTERSEED2A` and `NY-BOB-JOTTERSEED2B`. Passwords
come only from the environment variables above, set when you seed. Re-seed after changing tokens or
passwords.

## Pages and API

| Route | What it does |
|---|---|
| `/signup`, `/login`, `/logout` | Account basics (`/logout` takes GET or POST) |
| `/notes` | Your own notes (correctly scoped) |
| `/notes/new` | Write a note |
| `/notes/:id` | View a note (**SEEDED BUG #1**) |
| `/account` | Plan and profile bio, with bio editing (correctly scoped) |
| `/pro/export` | Export page: Pro users see an "Export my notes" button, free users see an upsell |
| `GET /api/notes/:id` | Note as JSON (**SEEDED BUG #2**) |
| `POST /api/export` | Your notes as `jotter-export.txt` (**SEEDED BUG #3**) |

## The seeded bugs

| # | Where | Mistake | What a correct app does |
|---|---|---|---|
| 1 | `routes/notes.js`, `GET /notes/:id` | Loads the note by id only, so any logged-in user can read anyone's note. | Adds `AND owner_id = <me>` and returns 404 |
| 2 | `routes/notes.js`, `GET /api/notes/:id` | Returns the full record, including owner email and body, for any id. | Same owner check |
| 3 | `routes/pro.js`, `POST /api/export` | The Pro gate is only a hidden button. The endpoint checks login, never the plan. | Returns 403 unless `plan = 'pro'` |

**What stays correct (the controls):** guests get a redirect to `/login` from every page and a
`401` from every API route. `/notes` and `/account` only show your own data. So the guest boundary
holds, which shows that notyours doesn't cry wolf.

## notyours boundaries (`demo/.notyours/`)

`config.yaml` sets `baseUrl: http://127.0.0.1:3077`. Paths in `surface` are relative to `demo/`.

| File | Kind | Viewer → target | Expected on this app |
|---|---|---|---|
| `b1-cross-user.yaml` | cross-user | Bob → `/notes/1001`, `/api/notes/1001` | **LEAK** (bugs #1, #2) |
| `b2-guest.yaml` | guest | logged out → same URLs | **HELD** |
| `b3-plan-gate.yaml` | plan-gate | free Bob → `/pro/export`; `POST /api/export` | **LEAK** via the API (bug #3); the UI path holds |
| `b4-sweep.yaml` | sweep | Bob → his own `/notes`, `/account` | **HELD** (Bob's token present, Alice's absent) |

In B3, `targets.api` is written as `"POST <url>"` because the export endpoint only accepts POST.

## Tests

```bash
npx vitest run --root demo
```

These are real HTTP requests against an in-memory database, with no Kane. They check that bugs #1–#3
are present, guests are blocked, positive controls work (owners see their own tokens), the happy
paths work, and every boundary file parses with `BoundarySchema.strict()`.
