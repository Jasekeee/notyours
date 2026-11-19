# Changelog

All notable changes to notyours. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/). Entries are taken from the git history between the
release tags (`git log v0.1.x..v0.1.y`). Until 0.2.0 is published to npm, install from GitHub:
`npx github:Jasekeee/notyours`.

## [0.2.0]

Release packaging: npm metadata, a prebuilt `dist/` in the package, CI on every push and pull request, and the
community files a public project needs.

### Added
- npm package metadata: `keywords`, `homepage`, `bugs`, `repository`, `engines` (Node 22+) and a `files` list that
  ships `dist/`, the demo app and the license.
- A `prepublishOnly` guard (typecheck and build) so the published tarball always contains a fresh `dist/`.
- GitHub Actions CI (`.github/workflows/ci.yml`): build, typecheck and tests on every push and pull request. CI runs
  mock-driven tests only and never starts a Kane run.
- `SECURITY.md` (how to report a vulnerability and what is in scope), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), and issue and pull request templates.

### Changed
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
- Submission documents and three natural-app experiments on an app notyours did not write.

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
