# Contributing to notyours

Thanks for helping. notyours is small on purpose: it proves that one user's data does not reach another user, and it
must stay trustworthy. Read this before you open a pull request.

## Set up

Requirements: Node 22 or newer, and Google Chrome (the tests drive a headless Chrome).

```sh
git clone https://github.com/Jasekeee/notyours.git
cd notyours
npm ci                       # also builds dist/ through the prepare script
git config core.hooksPath .githooks   # enables the secret-blocking pre-push hook
npm run typecheck && npm test
```

Kane CLI is **not** needed to contribute. The test suite uses a fake `kane-cli` and a local fixture app.

Browser tests run locally and in the E2E workflow. `npm test` runs everything and needs Google Chrome. CI on every push
runs typecheck, build and `npm run test:unit` (no browser). The five browser test files (`npm run test:browser`,
serial) run in `.github/workflows/e2e.yml`, by hand or nightly. Run `npm run test:browser` yourself when you
touch `src/engine/`, `src/cli/` or anything that drives Chrome.

## What to check before a pull request

1. `npm run typecheck` passes.
2. `npm test` passes. Every new behaviour has a test. Bugs get a regression test that fails before the fix.
3. `npm run build` passes.
4. `git status` and `git diff --cached --name-only` list only the files you meant to change.

## Rules that are not negotiable

- **No new runtime dependencies** without an issue first. Explain why the existing dependencies can't do it.
- **Tests never spend Kane credits.** Do not add a test that starts a real Kane run. Live Kane runs belong in manual
  checks, documented in the pull request.
- **Never commit secrets or run evidence.** Do not commit `.env`, `.notyours/secrets.json`, `.notyours/profiles`,
  `.notyours/runs`, `.testmuai/evidence`, `*.evidence`, or `*.har`. The pre-push hook blocks many of these, but check
  the list yourself.
- **No real emails, passwords, tokens or account IDs** in code, tests, fixtures or docs. Use the `.test` fixture domains
  and the existing fixture tokens.
- **Keep the oracle honest.** A verdict must come from the canary-token oracle, never from Kane's own pass or fail, and
  an inconclusive probe must never be reported as HELD.
- **Keep the guard strict.** Loosening a guard rule for agents needs a written reason and a test that shows the new
  allowance is narrow.

## Commits and pull requests

- Keep commits small and focused. The message format used in this repository is `type(scope): summary`, for example
  `fix(oracle): ...` or `docs: ...`.
- Do not force-push a branch that others use, and do not rewrite tags.
- Fill in the pull request template. Say what you verified and how.

## Reporting bugs and security issues

- Bugs and feature ideas: open an issue using the templates.
- Security problems: do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
