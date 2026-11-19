# notyours: rules for every agent

## Rules
- **Code frozen at v0.1.5. Only fix bugs that break the demo recording; everything else goes to Known limitations.**
- Node >=22, TypeScript, ESM (`.js` extensions in relative imports). Never use sudo.
- **No new dependencies.** Everything is installed. If you truly need one, write it up in CONTRACT_CHANGE.md and stop.
- **Frozen contracts:** `src/types.ts` and `src/schemas.ts` must not be edited. Propose changes in CONTRACT_CHANGE.md.
- Before ANY commit, run `git status` and `git diff --cached --name-only` and read the list. Never commit
  `.testmuai/evidence`, `*.evidence`, `*.har`, `.notyours/secrets.json`, `.notyours/profiles`, `.notyours/runs`, `.env`.
  Never `git add -A && git commit` in one step.
- Secrets only in `.env` / `.notyours/secrets.json` (gitignored). Never print TestMu credentials or identity passwords
  (use `redactIdentity()` from `src/shared/redact.ts`).
- Commit small and often. Never force-push. Push only if the pre-push hook passes; never use `--no-verify`.
- Kane credits: ~16 per authoring run, 0 per `testmd run` replay. Prefer replays. Never loop or retry authoring runs.
  Log every run's `credits_consumed`. Never test against example.com/.org; use local fixtures.
- Run `npm run typecheck && npm test` before committing.

## Spike facts (source of truth: spike/RESULTS.md)
- Variables file format: `{"name":{"value":"..."}}`.
- Parallel Kane runs on separate Chromes via `--cdp-endpoint` work. Live puppeteer-core capture alongside Kane works.
- `--analyzer-only` judges mostly from `<title>`: NEVER use it for verdicts. The canary-token oracle decides.
- `kane-cli run ... --name X` writes `.testmuai/tests/X_test.md`. `testmd run` replay costs 0 credits and takes <1s.
- Replay ignores changed variables and goes to the recorded URL. Retarget with `--override-start-url`, or use fixed seed URLs.
  `testmd run` + `--cdp-endpoint` works.
- kane-cli writes evidence packs (zips with the account email and share links) to `.testmuai/evidence/` wherever it runs.

## Overrides of the kane-cli skill
The installed kane-cli skill is useful for flags and NDJSON parsing, but this project overrides it:
- **puppeteer-core is allowed and required** for live DOM/network capture next to Kane (the skill says not to use it).
- Kane drives the personas; puppeteer only observes (never clicks or navigates in a Kane-controlled page).
- Don't use the assurance/generate/cover flows or Test Manager uploads unless the task asks for them.

## Layout
- `src/schemas.ts` (zod), `src/types.ts` (inferred types + Engine/Ratchet/Report interfaces): frozen.
- `src/<module>/mock.ts` holds fixed-data mocks; `src/<module>/index.ts` `createX()` returns the mock until the real one lands.
- `src/mocks/fixtures.ts`: shared fake identities/boundary/config/results. `src/shared/`: `makeToken`, `findTokens`, `redactIdentity`.
- Branches: feat/engine (src/engine), feat/demo (demo/), feat/ratchet (src/ratchet), feat/cli (src/cli).
  Stay in your own folder. Ask before editing anything else (src/report, src/hooks, src/map, shared files).

## Known issues
- `npm audit`: 0 vulnerabilities (checked 2026-11-19; earlier there were 7 high findings from one picomatch ReDoS
  advisory, reached only through dev tools). Never run `npm audit fix --force` (it downgrades majors).
- TypeScript 7 (native) has no JS API, so tsup builds without `.d.ts`; `npm run typecheck` is the type gate.
