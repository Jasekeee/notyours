# DONE_B: feat/demo (Jotter)

## Delivered (all under `demo/`)
- **Jotter app** on Express 5 + server-rendered HTML + sql.js, serving `127.0.0.1:3077` only. `node demo/server.js --seed` resets
  the database. It has pages `/signup /login /logout /notes /notes/new /notes/:id /account /pro/export` and API routes
  `GET /api/notes/:id` and `POST /api/export`. Sessions are cookie sessions stored in SQLite, so no new dependencies.
- **Fixed seed:** alice@jotter.test (Pro) owns note 1001 `Passport no. <alice token>`. bob@jotter.test (free) owns note
  1002 `<bob token>`, and his `/account` bio contains `<bob token>` too. Tokens come from `identities.json`
  (`$NOTYOURS_DIR`, then `demo/.notyours`, then `./.notyours`), with defaults `NY-ALICE-JOTTERSEED2A` and `NY-BOB-JOTTERSEED2B`.
  Passwords come from `JOTTER_ALICE_PW` / `JOTTER_BOB_PW`; the dev defaults are marked `notyours:allow-secret`.
- **Seeded bugs**, each labelled `// SEEDED BUG #n`:
  - #1: `routes/notes.js` `/notes/:id`
  - #2: `routes/notes.js` `/api/notes/:id`
  - #3: `routes/pro.js` `POST /api/export` has no plan check
  
  Guests are correct: pages redirect to `/login` and APIs return 401.
- **Boundaries** in `demo/.notyours/boundaries/`: B1 cross-user, B2 guest, B3 plan-gate, B4 sweep, plus `config.yaml`
  (baseUrl `http://127.0.0.1:3077`). Expected results on the seeded app: B1 LEAK, B2 HELD, B3 LEAK (API), B4 HELD.
- **Tests:** `npx vitest run --root demo` runs 23 tests. They use real HTTP and no Kane. They cover bugs #1–#3 present,
  guests blocked, positive controls, happy paths, and the boundary files parsing with `BoundarySchema.strict()`.
- **Docs:** `demo/README.md` (says plainly that the bugs are seeded on purpose, plus reset steps and seed credentials) and
  `demo/KANE_RUNS.md`.

## Kane usage
2 authoring runs out of the 4 allowed, both passed, **59.60 credits** in total (33.59 for signup + create note, 26.01 for
login + logout). No retries and no replays. Each run cost about 2× the CLAUDE.md estimate of ~16 credits.

## Needs a decision from others
1. **`npm test` does not run the demo tests.** The root `vitest.config.ts` only collects `test/**` and `src/**`, and it
   and `package.json` are shared files. Fix: add `'demo/test/**/*.test.js'` to `include`, or a `test:demo` script. Until
   then, run `npx vitest run --root demo`.
2. **Engine (feat/engine), B3 plan-gate:**
   - `targets.api` holds `"POST http://127.0.0.1:3077/api/export"`. The schema has no HTTP method field, so I used a
     `METHOD URL` convention. A plain GET to that URL returns 404 and would read as HELD by mistake.
   - Proof of the leak is that the response body contains the **viewer's own** token (Bob's note 1002), not the owner's.
     The engine's plan-gate verdict needs to treat that as a leak.
3. **`create.objective` with fixed seed data:** the schema requires one. Mine only confirms the seeded note 1001 as Alice
   and stores `note_url`; it doesn't create anything, which keeps replay URLs stable. In B3, `create` checks that Alice
   sees the export button.
4. **`surface` paths** are relative to `demo/` (the folder that holds `.notyours/`). If the engine resolves them from
   the repo root, they need a `demo/` prefix.

## Not done / notes
- No contract changes and no files edited outside `demo/`, apart from this file.
- `demo/data/` (the SQLite file) is gitignored through `demo/.gitignore`.
