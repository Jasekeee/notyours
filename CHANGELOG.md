# Changelog

All notable changes to notyours. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/). Entries are taken from the git history between the
release tags (`git log v0.1.x..v0.1.y`). Run it with `npx notyours`, or from GitHub with
`npx github:Jasekeee/notyours`.

## [0.2.1] - 2026-11-20

### Security
- The `app.start` approval moved out of the project. It was an unkeyed hash in `.notyours/app-approved.json`, so
  anything that could write inside the project could forge it. It is now stored in the account's config folder
  (`<home>/.config/notyours/app-approvals.json`, mode 0600), keyed by the project's real path, the exact start
  command and the port. The home comes from the account database, so `HOME` and `XDG_CONFIG_HOME` can't move it.
  A file inside the project is ignored, and the guard refuses an agent's writes to the approvals folder.
  An approval given under 0.2.0 is not carried over: run `notyours init` in a terminal once to approve again.

### Changed
- CI is split. `ci.yml` (the README badge) runs typecheck, build and the non-browser tests (`npm run test:unit`).
  `e2e.yml` runs the five browser test files one at a time (`npm run test:browser`), by hand and nightly: on GitHub's
  ubuntu-latest runner 8 engine tests time out (docs/STATUS.md, "CI"). `ci-debug.yml` is a manual diagnostic run.

### Fixed
- Test runs no longer leave headless Chromes behind. The engine keeps track of every Chrome it starts
  (`killLiveChromes()`), and each browser test file kills what it started in `afterAll`, even when the file aborts.
- Browser tests pick free debugging ports instead of fixed ones, so parallel test files don't collide.

## [0.2.0]

Craft sprint: an install-and-go first run (`notyours init`), a README and static site written for a developer
installing it, the app-start approval that the Stop hook now shares, and release packaging (npm metadata, CI, the
community files a public project needs).

### Added
- `notyours init` wizard: detects Express or Next.js, proposes the app's start command and port, creates the test
  users and writes the boundary drafts. `--yes`, `--users`, `--url`, `--start` and `--port` cover CI and existing
  accounts. Apps with a CAPTCHA, OAuth-only or SMS sign-in are refused, with the `--users` way to continue.
- `notyours setup claude` (hooks, `/notyours-map`, `/notyours-check` in one step), a bare `notyours` status command,
  and `--json` output.
- A product README, `docs/WHY.md`, a static site (`site/`) with a redacted sample report, a social preview image,
  and a GitHub Pages workflow.
- npm package metadata: `keywords`, `homepage`, `bugs`, `repository`, `engines` (Node 22+) and a `files` list that
  ships `dist/`, the demo app and the license.
- A `prepublishOnly` guard (typecheck and build) so the published tarball always contains a fresh `dist/`.
- GitHub Actions CI (`.github/workflows/ci.yml`): build, typecheck and tests on every push and pull request. CI runs
  mock-driven tests only and never starts a Kane run.
- `SECURITY.md` (how to report a vulnerability and what is in scope), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), and issue and pull request templates.

### Changed
- `app.start` runs only after a person approves the exact start command and port on this machine. The wizard in a
  terminal records the approval; an agent's run can't set or approve it.
- The Stop hook restarts the app with `app.start` only when that approval exists. Otherwise it reports YELLOW with the
  command that approves it, and blocks the stop (the same escalation as a failed restart).
- `notyours demo` approves its own bundled start command, so it needs no manual step.
- The demo copy carries its own `package.json` (ES module), so `notyours demo` runs from a folder whose
  `package.json` is CommonJS. (A pre-existing gap: in such a folder the demo's `server.js` failed on its imports.)
- Version bumped from 0.1.5 to 0.2.0 in `package.json` and `package-lock.json`.

## [0.1.5] - 2026-11-19

### Fixed
- The Stop hook fails closed on invalid or duplicate boundaries and on crashes, instead of passing.
- `init` adds Kane recordings to `.gitignore`.

## [0.1.4] - 2026-11-19

Audit fixes.

### Fixed
- Budget bypass: the authoring budget can no longer be raised from a coding agent's shell.
- The oracle never reports HELD on errored, 5xx or unreadable leak evidence.
- Script responses are scanned too (JSONP-style data endpoints).
- Report: no Test Manager links or local session paths in `report.html` or `report.json`.
- Stop hook: fail-closed behaviour with escalation after the attempt limit, and progress lines during a run.
- The demo runs in its own folder, and `doctor` pins the Kane CLI version it was tested with.
- Docs: Kane CLI 0.10.0 install, measured credit figures, and a scripted loop without Claude Code
  (`scripts/judge-loop.sh`).

## [0.1.3] - 2026-11-19

Fix-day fixes from the natural-app experiments.

### Fixed
- Stop hook never judges a stale app server: it restarts the app (`app.start`) or reports that it needs one.
- Personas that are still signed in skip the login replay.
- File downloads (`Content-Disposition: attachment`) are fetched and judged as text.
- The oracle's own tabs bypass the app's Content Security Policy, so its `fetch()` calls are not blocked.

### Added
- Internal working documents and three natural-app experiments on an app notyours did not write.

## [0.1.2] - 2026-11-19

### Removed
- The old direct-command hook installer. Hooks go through the fail-closed launcher only.

## [0.1.1] - 2026-11-19

### Fixed
- Hooks fail closed when the notyours CLI is missing or crashes.

## [0.1.0] - 2026-11-19

First tagged release. The history starts on 2026-11-18.

### Added
- Engine: one Chrome per persona, a kane-cli runner with a credit floor, and a canary-token oracle with four probe
  kinds (cross-user, guest, plan-gate, sweep) and positive controls.
- Ratchet: `lock` records proven boundaries as Kane tests; `replay` re-checks them with no authoring runs.
- Claude Code hooks: post-tool marking, a `.notyours` guard, and a Stop hook that replays changed boundaries.
- Map: a static route scan that drafts boundaries, and the `/notyours-map` command.
- CLI (`init`, `map`, `run`, `lock`, `replay`, `report`, `install-hooks`, `budget`, `doctor`, `demo`) and an HTML and
  JSON report.
- Demo app with three labelled, seeded authorization bugs and boundaries B1 to B4.
- Daily budget on authoring Kane runs, with `NOTYOURS_ALLOW_AGENT_AUTHORING` for CI.
