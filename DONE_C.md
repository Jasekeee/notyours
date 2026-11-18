# DONE_C: feat/ratchet (ratchet + Claude Code hooks)

## Delivered (all under `src/ratchet/` and `src/hooks/`)
- **`lock(b, result)`** (`src/ratchet/lock.ts`) works only on HELD results with both positive controls true. It records two
  tests with `kane-cli run "<objective>" --name <boundary>_<identity> --cdp-endpoint http://127.0.0.1:<cdpPort> --agent`:
  - owner: the boundary's own `create.objective`, with `{{token}}` and the stored values resolved
  - viewer: the targets (`"POST <url>"` targets become "call POST …"); for plan-gate, the `proAction` objective

  It then moves `<name>_test.md` **and its `output-<name>/` recordings** from `.testmuai/tests/` into `.notyours/tests/`.
  Without the recordings, a replay re-authors from scratch and spends credits. Finally it sets `locked: true` in the
  boundary's YAML/JSON file, keeping comments. Every `{{name}}` is resolved before recording, so replays go to fixed
  URLs (replay ignores changed variables).
  - Guards: refuses below `creditFloor` and refuses when the balance can't be read (`kane-cli balance`). Caps authoring at
    **8 runs** per project (agent B measured ~30 credits per run), counted from `.notyours/runs/credits.jsonl`, where every run's `credits_consumed` is logged.
  - Runs are sequential, so a failed owner recording does not spend the viewer's credits. Locking again is a no-op
    unless `reauthor: true`. `.env*` files are stripped from adopted recordings (kane's code export writes an
    `.env.example` with `LT_USERNAME`/`LT_ACCESS_KEY` slots, and the pre-push scan exempts `.env.example`).
- **`replay(ids)`** / `replayIds(ids, boundaryIds)` (`src/ratchet/replay.ts`): for each locked boundary, replays owner and
  viewer in parallel, each on its own Chrome, with
  `testmd run <file> --cdp-endpoint … --agent --no-adaptive-heal`. Without `--no-adaptive-heal`, kane-cli **re-authors
  failing steps by default** (3 heal attempts, then a full re-author), which would silently spend credits. Then the
  engine oracle judges. A failed Kane step returns `HARNESS_BROKEN` without calling the oracle.
  `classify()`: RED = `LEAK_*`, YELLOW = `HARNESS_BROKEN`, GREEN = `HELD`.
- **`createRatchet(opts?)`:** returns the real ratchet with `{ projectDir }` and the mock without arguments. That keeps the
  mock-wired CLI stub (`replay` calls `lock(mockBoundary…)`) from ever starting a paid authoring run.
- **Hooks** (`src/hooks/`), each a pure `(input) → { exitCode, stdout, stderr }`:
  - `post-tool` finds the **app folder** for the edited file: the nearest ancestor holding `.notyours/`, no higher than
    the project dir (e.g. `demo/`). It matches the app-relative path against each boundary's `surface` plus that
    folder's `.notyours/map.json`, records `{ files, globs, ts }` per id in that folder's `dirty.json`, and always exits 0. It has its own glob matcher (`**`, `*`, `?`, `{a,b}`,
    `[…]`), so no new dependency.
  - `guard` blocks Edit/Write/MultiEdit on `.notyours/` and Bash commands that could write there, with exit 2 and the
    exact message. Paths are resolved the way the kernel does (`physicalPath`: `..` after a symlink, dangling links,
    loops fail closed), case-insensitively. Bash checks handle shell quoting, dot-globs and `xargs` chains. It also blocks `notyours lock`. Read-only Bash (`cat/ls/head/tail/grep/jq/find` without `-delete`/`-exec`, no
    redirects) stays allowed, so the agent can still read evidence under `.notyours/runs`.
  - `stop` looks for app folders under the project (up to 3 levels deep, skipping dot and vendor dirs). If none has
    anything in `dirty.json`, it exits 0 right away. Otherwise it replays each folder's dirty locked boundaries with that
    folder as the ratchet's project dir:
    - GREEN clears dirty and attempts.
    - YELLOW keeps the boundary dirty and sends the human a `systemMessage` with "harness needs re-recording: notyours lock --reauthor <id>".
    - RED increments `attempts.json`. Below `maxAttempts` it exits 2 with a report of at most 40 lines: id + kind,
      "bob saw alice's data", URL, VISIBLE/PAYLOAD, token + quoted snippet, screenshot, suspected files with the globs
      they matched (shown relative to the project, e.g. `demo/routes/notes.js`), `npx notyours replay <id>`, and last line "Fix server-side; do not edit tests.". At `maxAttempts`
      it writes `ESCALATION.md` (project root), exits 0 and tells the human.
    - Identity passwords are scrubbed from snippets.
  - `installHooks(projectDir, cliCommand = 'npx notyours')` merges into `.claude/settings.json`. It keeps every other key
    and hook, replaces only handlers ending in ` hook <name>` (so re-running with a new `cliCommand` doesn't duplicate),
    and refuses to touch invalid JSON.
- **Tests:** 131 passing (`npm run typecheck && npm test`).
  - JSON stdin fixtures for every hook in `src/hooks/fixtures/`, plus real-process runs of `src/hooks/bin.ts`.
  - Glob table, guard bypass table, and lock/replay with a fake `KaneClient`.
  - A fake `kane-cli` binary asserts `--no-adaptive-heal`/`--cdp-endpoint`.
  - Stop hook through the real ratchet with an engine returning **RED then GREEN**, the 3-attempt escalation, YELLOW,
    and the B1/B3 boundary shapes from the demo.

## Claude Code hook docs (https://code.claude.com/docs/en/hooks, read 2026-11-18)
- The field is **`timeout`, in seconds**: "Seconds before canceling … Defaults: 600 for `command`". The docs state **no
  general maximum**; only SessionEnd is capped (60 s). I set Stop to **900 s**, and post-tool/guard to 10 s.
- Stop input has `stop_hook_active` ("true when Claude Code is already continuing as a result of a stop hook"). Claude Code
  caps stop-hook continuations at 8 in a row (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Stop has no matcher support.
- Exit 2 on Stop: "Claude receives the stderr message as the explanation for why it should continue". `systemMessage` in
  JSON on exit 0 is "shown to the user". `file_path` for Edit/Write is always absolute. `CLAUDE_PROJECT_DIR` is set.
  MultiEdit no longer appears in the docs; keeping it in the matcher is harmless.
- **How the hook uses `stop_hook_active`:** every block increments `attempts`. A RED boundary therefore blocks at most
  `maxAttempts-1` (2) times in a row, then escalates and lets Claude stop, which stays under the 8-continuation cap. An
  early exit on `stop_hook_active` alone would let the agent skip the check by trying to stop twice.

## Kane usage
**0 authoring runs, 0 credits.** Agent B's demo is not on `main` yet (`git fetch` at the end: `main` has only
`demo/.gitkeep`; it's finished on `feat/demo`), so per the brief everything runs on mocks. One free `kane-cli balance`
call was made to learn its output format.

## Needs a decision from others
1. **CLI (feat/cli):**
   - Call `registerHookCommands(program)` from `src/hooks/index.ts` so `notyours hook <post-tool|guard|stop>` exists.
     Until then, `tsx src/hooks/bin.ts <name>` works for local testing.
   - Build the ratchet with `createRatchet({ projectDir })`.
   - Add `replay <id>` (it's the repro command in the report) and `lock --reauthor <id>` (`reauthor: true`).
2. **Engine (feat/engine): CC-1 in CONTRACT_CHANGE.md.** The frozen Engine only has `runBoundary()`, which re-runs the
   create objective and costs credits on every Stop. The ratchet uses `engine.judge(b, ids, cfg, replays)` if the engine
   has it. Otherwise it calls `runBoundary({ ...b, locked: true })`, and **the real engine must treat `locked: true` as
   judge-only**. Without one of the two, the Stop hook spends credits.
3. **Latency:** a built hook process takes about 120 ms, but `npx` adds 200–400 ms, so `npx notyours hook post-tool` can
   exceed 300 ms. For speed, pass `cliCommand` as `node <project>/node_modules/notyours/dist/cli/index.js`.
4. **Project layout assumptions (please confirm):**
   - Per agent B, the app folder is the one holding `.notyours/`, and surface globs are relative to it. The hooks find
     it from `CLAUDE_PROJECT_DIR` (else the stdin `cwd`), so Claude Code can run at the repo root or inside `demo/`.
     The CLI should construct the ratchet and run `replay <id>` with that app folder as `projectDir`.
   - Boundaries are read from `.notyours/boundaries.yaml` and/or `.notyours/boundaries/*.{yaml,yml,json}`.
   - Identities come from `.notyours/identities.json` merged with `.notyours/secrets.json`.
   - `map.json` may be `{id: string[]}` or `{id: {files|surface|globs}}`, optionally under `boundaries` (src/map
     hasn't defined it yet).
5. **`.gitignore` (shared file):** consider ignoring `**/.notyours/dirty.json` and `**/.notyours/attempts.json` (runtime
   state). `.notyours/tests/output-*/` must be **committed** for replays to work on another machine. It holds Kane
   org/user/test ids (not secrets). Decide whether that's acceptable for this repo.

## Known gaps
- **Bash edits don't mark boundaries dirty.** PostToolUse with `Edit|Write|MultiEdit` doesn't fire for `sed -i` and
  similar commands. A fix would be a Bash PostToolUse that diffs `git status` against a snapshot. I didn't do it because
  it changes the hook design in the brief.
- The guard is a speed bump, not a sandbox: shell variables or an interpreter can still reach `.notyours/`. The backstop is
  that changes to `.notyours/` show up in git diffs.
- `dirty.json` is written read-modify-write with an atomic rename. Two edits finishing at the same moment could drop one
  id; the next edit or Stop recovers it.
- `ESCALATION.md` goes to the app folder (e.g. `demo/ESCALATION.md`). Once escalated, a boundary stays escalated until `attempts.json` is reset or a
  replay goes GREEN.
