# DONE_C: feat/ratchet (ratchet + Claude Code hooks)

**Status: the core is complete.** lock, replay, the post-tool / guard / stop hooks, and `installHooks` with an
overridable `cliCommand` are all built and tested on mocks. `npm run typecheck && npm test` passes (136 tests).
Kane: **0 authoring runs, 0 credits**. Agent B's demo is still not on `main` (only `demo/.gitkeep`), so per the brief
nothing ran against real Kane. Security hardening has stopped at this point, as asked (see Known gaps).

## What works

| Piece | Where | What it does |
|---|---|---|
| `lock(b, result)` | `src/ratchet/lock.ts` | Only accepts a HELD result with both controls true. Records one Kane test per identity, each on its own Chrome (`kane-cli run … --name <boundary>_<identity> --cdp-endpoint …`): the owner runs the resolved `create.objective`, the viewer runs the targets (or `proAction` for plan-gate). Moves `<name>_test.md` and its `output-<name>/` recordings into `.notyours/tests/`, then sets `locked: true` in the boundary file. |
| Lock budget guards | same | Refuses below `creditFloor` or when the balance can't be read. Caps authoring at **8 runs** per project and logs every run's `credits_consumed` to `.notyours/runs/credits.jsonl`. Runs are sequential, so a failed owner recording saves the viewer's credits. Locking again is a no-op unless `reauthor: true`. |
| `replay(ids)` / `replayIds(ids, boundaryIds)` | `src/ratchet/replay.ts` | Replays owner and viewer in parallel with `testmd run … --cdp-endpoint … --agent --no-adaptive-heal`. That last flag matters: by default kane-cli re-authors failing steps, which costs credits. Then the engine oracle judges. RED = `LEAK_*`, YELLOW = `HARNESS_BROKEN` (including a failed Kane step), GREEN = `HELD`. |
| `createRatchet(opts?)` | `src/ratchet/index.ts` | Real ratchet with `{ projectDir }`, mock without arguments. This keeps the mock CLI stub from starting a paid run. |
| post-tool hook | `src/hooks/post-tool.ts` | PostToolUse `Edit\|Write\|MultiEdit`. Matches the edited file against `surface` globs and `map.json` in every app folder that contains it (the folder holding `.notyours/`, e.g. `demo/`; globs are relative to it). Writes `{files, globs, ts}` to `dirty.json`. Always exits 0, takes about 140 ms, and never calls Kane. |
| guard hook | `src/hooks/guard.ts` | PreToolUse `Edit\|Write\|MultiEdit\|Bash`. Exits 2 with *"notyours: tests and boundaries are read-only for the agent. Fix the app's server-side authorization instead."* on any write to `.notyours/` or on `notyours lock`. Read-only Bash (`cat`, `ls`, `grep` …) is still allowed. |
| stop hook | `src/hooks/stop.ts` | Empty `dirty.json` → exit 0. Otherwise replays the dirty locked boundaries. RED → `attempts++`, then exit 2 with a report of at most 40 lines ending in "Fix server-side; do not edit tests.". After 3 REDs it writes `ESCALATION.md` in the app folder and exits 0 with a message for the human. GREEN clears dirty and attempts. YELLOW → exit 0 and a human message ("harness needs re-recording: notyours lock --reauthor <id>"). |
| `installHooks(projectDir, cliCommand = 'npx notyours')` | `src/hooks/install.ts` | Merges into `.claude/settings.json` and keeps every other hook. Re-running replaces only our handlers. `cliCommand` can be overridden, e.g. `node /abs/path/dist/cli/index.js`. Timeouts are in **seconds** (Claude Code docs: default 600, no stated maximum): Stop = 900, the other two = 10. |

**`stop_hook_active`:** every block increments `attempts`, so a RED boundary blocks at most 2 times in a row before it
escalates. That's under Claude Code's limit of 8 continuations. An early exit on `stop_hook_active` alone would let
the agent skip the check by trying to stop twice.

## How to test

```sh
npm run typecheck && npm test        # 136 tests
```

Tests cover stdin fixtures for every hook (`src/hooks/fixtures/`), glob matching, lock/replay with a fake Kane client, a
fake `kane-cli` binary (checks `--no-adaptive-heal` and `--cdp-endpoint`), and the stop hook through the real ratchet
with an engine returning **RED then GREEN**. They also cover 3 REDs → `ESCALATION.md`, YELLOW, the guard blocking
Edit/Write/Bash on `.notyours/`, `installHooks` merging, and B's demo boundary shapes.

Manual run of the hooks (until the CLI wires `notyours hook <name>`, `src/hooks/bin.ts` is the entry point):

```sh
D=$(mktemp -d); mkdir -p $D/.notyours/boundaries
printf 'baseUrl: http://127.0.0.1:3077\n' > $D/.notyours/config.yaml
git show feat/demo:demo/.notyours/boundaries/b1-cross-user.yaml > $D/.notyours/boundaries/b1.yaml

# post-tool: exit 0, dirty.json gets b1-notes-cross-user / routes/notes.js
echo "{\"cwd\":\"$D\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$D/routes/notes.js\"}}" | npx tsx src/hooks/bin.ts post-tool
cat $D/.notyours/dirty.json

# guard: exit 2 with the read-only message
echo "{\"cwd\":\"$D\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"rm .notyours/dirty.json\"}}" | npx tsx src/hooks/bin.ts guard; echo $?

# stop: b1 isn't locked, so exit 0 with a systemMessage for the human
echo "{\"cwd\":\"$D\",\"hook_event_name\":\"Stop\",\"stop_hook_active\":false}" | npx tsx src/hooks/bin.ts stop

# installHooks with an overridden cliCommand
npx tsx -e "import('./src/hooks/index.ts').then((m) => console.log(m.installHooks(process.argv.at(-1), 'node /abs/path/dist/cli/index.js')))" "$D"
cat $D/.claude/settings.json
```

## Known gaps

**Needs other agents**
1. **CLI (agent D):** wire `registerHookCommands(program)` (from `src/hooks/index.ts`) so `notyours hook <name>` exists.
   Build the ratchet with `createRatchet({ projectDir: <app folder, e.g. demo/> })`. Add `replay <id>` (the repro command
   in the report) and `lock --reauthor <id>`.
2. **Engine (agent A), CC-1 in CONTRACT_CHANGE.md:** the frozen `Engine` has no judge-only method. The ratchet uses
   `engine.judge()` if it exists, otherwise `runBoundary({...b, locked: true})`. **The real engine must treat
   `locked: true` as "judge, don't author"**, or every Stop hook spends credits.

**Not done**
3. **No real Kane run yet:** waiting for the demo to reach `main`. The NDJSON parsing follows the kane-cli 0.10.0 skill
   docs and the spike output, not a real `testmd run` of a locked notyours test.
4. **Bash edits don't mark boundaries dirty** (e.g. `sed -i`). PostToolUse with `Edit|Write|MultiEdit` doesn't fire for Bash.

**Limits**
5. **Guard:** a speed bump, not a sandbox. Shell variables or an interpreter can still reach `.notyours/`. Hardening
   stopped here by request; the backstop is that `.notyours/` changes show up in git.
6. **Latency:** `npx` adds 200–400 ms per hook. For speed, use `cliCommand: 'node <path>/dist/cli/index.js'`.
7. **`dirty.json`:** read-modify-write, so two edits finishing at the same moment could drop an id. The next edit recovers it.
8. **Escalation:** once escalated, a boundary stays that way until `attempts.json` is reset or a replay goes GREEN.

**Assumptions**
9. File layout:
   - boundaries in `.notyours/boundaries.yaml` and/or `.notyours/boundaries/*.yaml` (B's layout)
   - identities in `.notyours/identities.json` merged with `secrets.json`
   - `map.json` as `{id: string[]}` or `{id: {files}}` (src/map hasn't defined it)
10. **`.gitignore`:** a shared file, so I didn't edit it. Suggest ignoring `.notyours/dirty.json` and
    `.notyours/attempts.json`. `.notyours/tests/output-*/` must be committed for replays to work elsewhere; it holds
    Kane org/user/test ids, which are not secrets.
