# notyours vs. a naturally built app: result (2026-11-19)

**Summary.** notyours found **no leaks** in this app. A fresh Claude Code session built it from a neutral prompt, with
no security instructions (see [PROVENANCE.md](PROVENANCE.md)). Kane proved all four boundaries **HELD**, with both
positive controls passing. The export needed a second run, after a notyours fix (below):
- Bob can't open Alice's note, its edit form, or a share link she revoked.
- A logged-out guest can't read a shared note.
- Bob's own pages never show Alice's data.
- Free Bob doesn't get the Pro export. In the first run this came back **HARNESS (unproven)**: the export is a file
  download (`Content-Disposition: attachment`), and the oracle couldn't read a download's body. After the fix-day
  change, which fetches downloads in the persona's browser, the same boundary re-ran **HELD**.

The builder wrote the ownership checks and the server-side Pro check on its own, unprompted. So in this case, a careful agent shipped no
cross-user leak. This doesn't prove the app has no access bugs. It means these four boundaries held.

## Setup

- **App under test:** commit `554cfb6` of `~/code/natural-app`, exported with `git archive` into a separate working
  folder. It has its own database and runs on **http://localhost:4001**. The original folder was never modified, and
  the build session's own server on :4000 was left alone (why: [PROVENANCE.md](PROVENANCE.md)).
- **Personas:** `notyours init --url http://localhost:4001 --users <temp file>`, then **Kane signed up Alice and Bob
  itself** through the app's `/signup` form. This used notyours' engine `signup()`, in throwaway Chrome profiles.
  One more Kane run switched Alice to Pro on `/account`. Passwords were random, stored only in `.notyours/secrets.json`,
  and never printed. (`init` alone doesn't sign anyone up; it needs a users file.)
- **Boundaries:** `notyours map` scanned 17 routes and drafted 10. Acting as the coding agent (following
  `.claude/commands/notyours-map.md`), I read `server.js` and wrote 4 boundaries ([boundaries/](boundaries/)). The
  drafts were dropped for these reasons:
  - `POST /signup` and `POST /login` don't serve anyone's data.
  - `GET /s/:token` as a plan gate isn't a Pro feature.
  - `GET /`, `GET /account` and `GET /notes/:id/edit` were folded into the sweep and cross-user boundaries.
  - `POST /account/plan` is the self-serve plan toggle the prompt asked for ("just a toggle, no real payments"), so
    it isn't a bypass.

  The app has **no JSON routes**, so every `targets.api` covers plain GET pages.

## Verdicts (`notyours run`, one pass, 13 min 36 s)

| Boundary | Verdict | Controls (owner / viewer) | What Kane did | Enforcing code (server.js) |
|---|---|---|---|---|
| `notes-cross-user` | **HELD** | ✓ / ✓ | Alice created a note with her token, shared it, stored the link, then stopped sharing. Bob did the same with his own note. Bob then opened Alice's note page, `/notes/6/edit` and her revoked link `/s/JKNDPo…` | `getOwnNote()` filters `WHERE id = ? AND user_id = ?` (194–197), used by `/notes/:id` (231) and `/notes/:id/edit` (245). `/notes/:id/unshare` sets `share_token = NULL` (273–278), so `/s/:token` (281) 404s |
| `share-link-guest` | **HELD** | ✓ / n/a (guest) | Alice created and shared a note (link kept live). A guest opened the share link and the note page. Alice's own control on the live link shows it renders for a logged-in user | `/s/:token` uses `requireLogin` (281, 136–139) |
| `bob-sweep` | **HELD** | ✓ / ✓ | Bob's `/`, `/account`, `/notes/new` and `/export.txt` never carried Alice's token | `GET /` lists `WHERE user_id = ?` (215–220); `/account` renders `req.user` only (288–295) |
| `export-plan-gate` | first run **HARNESS (unproven)**; re-run after the fix **HELD** | ✗ / ✓ → ✓ / ✓ | Alice (Pro) and Bob (free) each created a note and both tried "Export all". Kane reported `blocker.paywall` for Bob. The oracle couldn't read the export body, so Alice's own-token control failed and nothing was proven | `/export.txt` returns 403 unless `req.user.plan === 'pro'` (302–303) |

No boundary leaked, so there's no code line to point to. The "Enforcing code" column shows the lines that make each
one hold.

**Re-run after the fix (2026-11-19, same boundary file, `notyours run export-plan-gate`).** Result: **HELD**, both
controls true, 0 hits. It took 5 authoring runs: Alice and Bob each created a note, both tried "Export all" (Bob was
`blocker.paywall`), and Bob made his recording visit (also `blocker.paywall`). 220 s; 63.6 credits logged, 74.32 off
the balance. The personas were logged out first, so the run replayed their recorded logins and recorded none. What
made it work: the oracle now fetches a download in the persona's tab, and it bypasses the app's strict CSP
(`default-src 'none'`, which also blocked that `fetch()`). See docs/STATUS.md "Fixed on fix day". The app's
`server.js` at that moment carried experiment 2's uncommitted cache change, but `/export.txt` was identical to
`554cfb6`.

**Why the export was HARNESS the first time.** `GET /export.txt` answers with `Content-Disposition: attachment`. Measured in a headless
Chrome with a Pro session: `page.goto()` throws `net::ERR_ABORTED`, and Chrome won't hand over the response body
("Could not load response body for this request"). notyours reads GET targets via `page.goto`, so no visit to this URL
can see a token. (Fixed since: see the re-run above.)

**Manual HTTP checks.** These used curl with two throwaway accounts on the same copy, not Kane:

| Check | Result |
|---|---|
| free user `GET /export.txt` | **403** (gate holds) |
| Pro user `GET /export.txt` | 200, attachment with the user's own notes |
| another logged-in user ("friend") on an active share link | **200, note visible** (the intended feature works) |
| guest on that active link | 302 → `/login` |
| the friend on the same link after "Stop sharing" | 404 |
| the friend on the owner's `/notes/:id` | 404 |

## Evidence

Local, not committed: the full report has Test Manager links and local session paths.

- Report: `~/code/natural-app-run/.notyours/runs/2026-11-19T07-17-25-602Z/report.html` (+ `results.json`, `report.json`)
- Committed here: [results.redacted.json](results.redacted.json) (verdicts, controls, every Kane run's identity, status,
  reason, credits and duration) and the 4 [boundaries](boundaries/)

## Cost and time

| Part | Authoring runs | Credits (sum of `credits_consumed`) | Kane balance change | Time |
|---|---|---|---|---|
| Sign-ups (Alice, Bob) + Alice → Pro | 3 | 34.64 | 42.99 | 2 min 18 s |
| `notyours run` (2 login recordings + 13 probe runs) | 15 | 259.49 | 298.89 | 13 min 36 s |
| **Total** | **18 of the 25 allowed** | **294.13** | **341.88** | **~16 min of Kane time** |

`run --dry-run` estimated ~120 credits; the real cost was about twice that. Two things drove it: the share-link
objectives are long (create, share, store the link, stop sharing), and a plan-gate probe costs 5 runs. Bob's two
paywalled export attempts "failed" in Kane, and each failure triggers paid triage (7.8 and 10.4 credits).

## Honest notes

- **What this experiment covers:** whether one persona's data reaches another persona, on these four boundaries. It
  doesn't cover CSRF, XSS, rate limits or session handling. The app has code for all of these; it wasn't tested.
- **Not counted as leaks** because the prompt asks for them:
  - Any user can switch themselves to Pro.
  - Any logged-in user who has a share link can read that note.
  - The shared-note page shows the owner's email to whoever opens the link ("Shared by …").
- One sample, one run, kane-cli 0.10.0. The builder was `claude-sonnet-5-5`.
