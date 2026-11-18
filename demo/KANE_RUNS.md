# Kane runs against Jotter (feat/demo)

Budget: at most 4 happy-path authoring runs (6 total for agent B). **Used: 2 runs, 59.60 credits.**
kane-cli 0.10.0, headless, one-off (no `--name`), launched from a scratch folder outside the repo so
evidence packs never land here. Each run ran once, with no retries. Balance before: 11121.83.

| # | Date | Objective (abridged) | Result | credits_consumed | Duration |
|---|---|---|---|---|---|
| 1 | 2026-11-18 | Sign up as Dana (random email), verify "My notes", create note "Happy path" / "Buy oat milk", verify the note page, store its URL | passed (`note_url` = `/notes/1003`) | 33.59 | 113.8 s |
| 2 | 2026-11-18 | Log in as `bob@jotter.test` (password passed as a secret variable), verify "My notes" lists "Reminder", log out, verify "Log in to Jotter" | passed | 26.01 | 70.4 s |

Notes:
- Both runs cost more than the ~16 credits per authoring run estimated in CLAUDE.md (they have 13–19 steps).
  Keep objectives short, or author once and replay with `testmd run`.
- Run 1 created a user and note 1003 in the local database. `node demo/server.js --seed` removes them.
- In run 2, Kane recorded the password field as `{{secrets.user.bob_pw}}`; the value isn't in the step log.
