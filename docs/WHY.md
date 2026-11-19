# Why notyours

## The problem

Apps that hold data for many users have one recurring failure: user A can see user B's data. The usual causes
are small. A query is missing `where owner_id = ?`. A list endpoint returns every row. A paid page hides its
button but still serves the data. OWASP ranks Broken Access Control first in its
[Top 10:2025](https://owasp.org/Top10/2025/A01_2025-Broken_Access_Control/).

These bugs survive ordinary testing. Unit tests run one user at a time and check the function that was
written, not what another user's browser can reach. An end-to-end test that signs in as one user rarely signs in
as a second one and tries to look at the first one's records.

## What notyours does

notyours runs your app on localhost and acts as several people at once:

- **Alice** (owner) creates a record. Every record carries a unique canary token, such as `NY-ALICE-K7Q2MZX4P3RA`.
- **Bob** (another user), a guest and a free-plan user go looking for it, each in their own real Chrome.
- If Alice's token reaches Bob's screen or Bob's network traffic, that is a **leak**. The report gives the URL,
  the matching text and a screenshot.

Kane CLI drives the browsers. A canary-token oracle decides the verdict, so no AI judges the page. A proven
boundary ("Bob can't read Alice's note") becomes a recorded Kane test. From then on, a replay of that test costs no
authoring runs, and a coding agent that changes the guarded code gets the replay result back before it stops.

## What we measured

All numbers are from [docs/STATUS.md](STATUS.md) and [docs/E2E.md](E2E.md), on kane-cli 0.10.0.

| Measurement | Result |
|---|---|
| Full demo on a fresh folder (authoring, 4 boundaries) | 9 m 44 s, 113.34 Kane credits, 11 authoring runs |
| Quick demo (B1 only) on an empty folder | 4 m 48 s, 61.69 credits |
| Replay of 4 locked boundaries on the fixed demo app | 170 s, 3.4 credits, all GREEN |
| Stop hook, 1–4 changed boundaries | 70–535 s (median about 130 s) |

The demo app is Jotter, a small notes app with three seeded bugs. Its results: B1 (Bob reads Alice's note) LEAK,
B2 (guest) HELD, B3 (free user gets the Pro export) LEAK, B4 (Bob sweeps the list) HELD.

## How it was built

notyours was built with Claude Code (Claude Opus 5.5), in four git worktrees, one per area: the engine, the demo,
the ratchet (lock and replay) and the CLI. A later integration pass merged them and ran the whole flow against
real Kane. Real runs found bugs that the mocks had hidden, and those fixes are listed in STATUS.md.

## What it is not

notyours is not a penetration test and does not search for unknown vulnerabilities. It checks the isolation
boundaries you write, against your own app, with accounts you control. See the README for what it doesn't catch.
