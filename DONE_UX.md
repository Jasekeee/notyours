# DONE_UX: onboarding on feat/onboarding

Branch `feat/onboarding`, built on v0.1.5. CLAUDE.md freezes the code at v0.1.5 for the demo; this work was asked for
explicitly as a separate UX pass, so it stays on this branch and is not merged to `main`.

## What landed
1. **`notyours init` wizard** (`src/cli/wizard.ts`, `detect.ts`, `app-process.ts`, `personas.ts`)
   - Detects Express / Next.js / plain Node, the start script (`start`, else `dev`), and the port (script flag, then code, then default 3000).
   - Proposes `app.start`, `app.port` and `baseUrl`; asks unless `--yes`. Starts the app if nothing answers, stops it afterwards.
   - Creates personas (alice owner, bob viewer, guest; free_user only when the scan finds a plan gate) and **signs them up via Kane**
     (the known gap). Each sign-up prints its credit estimate first. `--users file` skips sign-up for existing accounts.
   - Refuses CAPTCHA, OAuth-only and SMS-only apps before writing anything, and says to use `--users`.
   - Writes the map drafts; offers the Claude Code hooks (`--no-hooks` to skip, `--yes` installs them).
   - Non-interactive with `--yes`; without a terminal and without `--yes` it takes the defaults and installs no hooks.
2. **`notyours` with no arguments** (`src/cli/status.ts`): what is configured, personas, boundaries (locked and drafts),
   the last run's verdicts, hooks, budget, what the coding agent can't touch, and the single next command.
3. **Output**: step lines with elapsed time and a credit estimate before each Kane step; a summary table
   (boundary, verdict, time, credits) after `run`/`replay`; every error ends with a `how to fix:` line; `--json` on the
   status, init, doctor and run/replay output (`src/cli/output.ts`).
4. **`notyours setup claude`** (`src/cli/hooks.ts`, `check-command.ts`): hooks, `/notyours-map` and the new `/notyours-check`
   (replays locked boundaries for 0 credits). `install-hooks` still works.
5. `run`, `lock --reauthor` and `replay` start the app from `app.start` when it is not answering.
6. Tests: `wizard.test.ts` (12), `detect.test.ts`, `status.test.ts`, `output.test.ts`, `setup.test.ts`, `with-app.test.ts`, and the
   argument-parsing tests in `cli.test.ts` updated for the new commands.

## Verification
- `npm run typecheck`: clean.
- `npm test`: 28 files, 379 tests, all passing (one earlier failure was a busy CDP port 9301 held by the wizard's own Chrome during the run).
- End to end on a fresh copy of natural-app: `init --yes` then one boundary, **HELD** in about 9 min of tool time, 82.2 Kane
  credits, 8 authoring runs. Details and timings in `docs/STATUS.md` (Onboarding section).

## Known limitations (not fixed, per the freeze)
- The map's plan-gate heuristic over-matches the word "plan": natural-app gets 10 drafts, several are false.
  That also triggers a third sign-up (free_user).
- The boundary YAML was written by hand in the trial; `/notyours-map` (Claude Code) is the intended path, not exercised here.
- Sign-up is one Kane run per persona, and the first `run` records one login per persona (another run each). A login
  recorded during sign-up would save those runs.
- `notyours status` as a subcommand is not defined; bare `notyours` is the status view.
- Sign-up success is judged by Kane's pass/fail, not by checking the account in the database.
