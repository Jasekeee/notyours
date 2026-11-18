# DONE_D: feat/cli (agent D)

Kane credits spent: **0** (no Kane runs; only free `kane-cli whoami` / `balance` calls from `doctor`).
`npm run typecheck && npm test`: green (65 tests in 4 files).

## What landed

| Area | Files | Notes |
|---|---|---|
| CLI | `src/cli/` | `doctor`, `init`, `map`, `run [ids] [--dry-run]`, `lock [ids] [--reauthor]`, `replay [ids]`, `report [--open]`, `demo [--dir] [--no-open]`, `install-hooks [--cli]`, `hook <post-tool\|guard\|stop>`, global `-C/--cwd`. Handlers are injected into `buildProgram()` (`program.ts`); real ones are in `commands.ts`. |
| Host guard | `src/cli/hosts.ts`, `init.ts`, `owned.ts`, `commands.ts` | `init` refuses hosts outside allowHosts. A non-local host needs `--allow-host <h>` **and** `--i-own-this`; that confirmation is stored outside the repo (`~/.config/notyours/owned-hosts.json`, keyed by project realpath; `NOTYOURS_HOME` overrides), so a cloned `config.yaml` can't grant it. `run`, `lock --reauthor`, `replay`, the stop hook and `demo` check the base URL and every URL in the boundaries (including bare `domain/` mentions in objectives), and fail closed on unparseable URLs and templated hosts. |
| doctor | `src/cli/doctor.ts`, `system.ts` | Node ≥ 22 (upgrade hint), Chrome, `kane-cli whoami`, `kane-cli balance` vs creditFloor (warn), port 3077 free. The bin entry also refuses Node < 22 with the same hint before loading anything. |
| Credits | `commands.ts` | Authoring refuses below `creditFloor`. Estimates use ~30 per first Kane run (per agent B). Every Kane run's `credits_consumed` goes to `.notyours/runs/credits.jsonl`. |
| map | `src/map/` | Static scan of Express (incl. named handlers, `router.route().get()`) and Next.js `app/` (and `pages/`). Writes `_draft_*.yaml` (schema-valid, never over a real boundary) and `map.json` (route → files, drafts, identity ids/roles without secrets). |
| /notyours-map | `.claude/commands/notyours-map.md`, `src/map/command.ts` | The slash command for the user's agent. `install-hooks` installs it into user projects. A test keeps the TS copy equal to the .md file. |
| report | `src/report/` | `createReport(ctx?)` → `HtmlReport`: one self-contained `report.html` (inline CSS, base64 screenshots, no external resources) + `report.json`. Passwords are scrubbed from raw results before escaping. Preview: `npx tsx src/report/__fixtures__/preview.ts <outDir>`. |
| Hooks | `src/cli/hooks.ts` | guard / post-tool / stop, described in README. Guard paths are canonicalised (symlinks, `..`, case) and it blocks Grep/Glob/Bash globs or recursive reads of `.notyours/`. `install-hooks` also adds Claude Code `permissions.deny` rules as a second layer. Hooks fail open on internal errors (never break the agent's session). Stop never loops (`stop_hook_active`) and never authors (credits). |
| demo | `src/cli/demo.ts` | Copies `demo/` (incl. `demo/.notyours/`) to a temp dir (or `--dir`), which becomes the project root, and symlinks notyours' own `node_modules` into it. Starts the app with `PORT=3077`, waits for HTTP, replays locked boundaries, authors the rest (then locks them), writes and opens the report, and prints the elapsed time. `NOTYOURS_DEMO_DIR` overrides the demo location. |
| Safety | `src/cli/safe-fs.ts` | Every write under the project refuses symlinked path components. `secrets.json` is forced to 0600 even if it already existed. |
| README | `README.md` | Pitch, install, Node 22+, diagram, verdicts, controls, ratchet, hooks/guard, credits (~30 first run per Kane run / 0 replay), limits, the "Not a pentest tool" line, judges' quick start. |

## Needs the coordinator (outside my folders, so I did not change these)

1. **`package.json` `files` must include `"demo"`**, i.e. `"files": ["dist", "demo"]`. Without it,
   `npx notyours demo` on a clean machine prints "demo app is missing". Optionally add
   `".claude/commands"` too; the CLI already bundles the command text, so it isn't required.
2. **`test/contracts.test.ts`**: one line changed (commit `5aff8f0`). It asserted the mock's
   `out/report.md`; it now writes to a temp dir and expects `report.html`. This was required because
   `createReport()` is real now.
3. No contract changes requested (`CONTRACT_CHANGE.md` untouched).

## Integration contract for the other branches

**Engine (A):** please validate `{{stored}}` target values at navigation time (the stored URL's host must be in `cfg.allowHosts`); the CLI can only check literal URLs before the run. The CLI calls `createEngine().runBoundary(b, identities, cfg)` **one boundary at a time**
(each boundary uses all persona Chromes), with `process.cwd()` = project root. Screenshots may be
paths relative to the project root, absolute paths, or `data:image/...` URIs; the report embeds them
(png/jpg/webp/gif, ≤ 8 MB). `KaneRun.testUrl` (http/https) becomes a link in the report.

**Ratchet (C):** `lock(b, result)` receives the latest non-HARNESS result, LEAKs included (locking a leak
gives a free replay after the fix). `replay(identities)` should return every locked boundary; the CLI
filters by id. **Please persist `locked: true` into `.notyours/boundaries/<id>.yaml`**: the guard,
the stop hook and `demo` (replay vs author) all read `locked` from the YAML.

**Demo (B):** what `notyours demo` expects inside `demo/`:
- a `start` script in `demo/package.json`, or `server.js` / `server.mjs` / `index.js`; listen on
  `process.env.PORT` (3077), host 127.0.0.1;
- `demo/.notyours/config.yaml` (optional; default baseUrl `http://127.0.0.1:3077`);
- `demo/.notyours/users.yaml` (or `.yml` / `.json`), in the same format as `init --users`:
  `users: [{id, role, plan, email, password}]`. Mark fake passwords with `# notyours:allow-secret`
  for the pre-push hook. `secrets.json` is generated in the work dir and never copied;
- `demo/.notyours/boundaries/*.yaml` with surfaces relative to `demo/`;
- recordings in `demo/.testmuai/tests/` (copied; `.testmuai/evidence` is not);
- runtime imports only from notyours' own dependencies (express, sql.js, …); they are resolved
  through the symlinked `node_modules`.

## Verified by hand (mocks, 0 credits)

- `init` refusal and acceptance paths, `.gitignore` entries, 0600 secrets; `map` on an Express app;
  `run --dry-run`, `run`, `lock`, `report`; boundary with a foreign host refused.
- `install-hooks` merge (keeps user hooks, idempotent); guard / post-tool / stop over stdin.
- `npm run build` → `node dist/cli/index.js demo` against a fake demo app (`NOTYOURS_DEMO_DIR`):
  server up, init from users.yaml, authoring, report, server stopped. About 2 s with mocks.
- Report screenshot reviewed at 1440 px for the video: the headline is balanced, badges/controls/
  tokens read at a glance.

## Known gaps

- `replay` prints "Nothing to replay" until the real ratchet lands (the mock ratchet is in-memory per process).
- `map` doesn't resolve Express mount prefixes (`app.use('/api', router)`); `map.json` says so and
  the slash command asks the agent to fix paths.
- Hooks default to `npx notyours …`, which adds npx startup time to every tool call. A local
  install with `--cli "node ./node_modules/notyours/dist/cli/index.js"` is faster.
