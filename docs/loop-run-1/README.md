# Loop run 1: "add a 'duplicate note' button on the note page"

`claude -p "In this Jotter app, add a 'duplicate note' button on the note page." --permission-mode acceptEdits`
in `/tmp/ny-loop` (fresh copy of demo/, bugs #1–#3 present, B1–B4 locked, hooks from `install-hooks --cli node …/dist/cli/index.js`).
`--permission-mode acceptEdits` was added because headless `-p` mode can't answer edit-permission prompts.

**Result: as expected.**
1. Claude edits `routes/notes.js`, and post-tool marks B1, B2 and B4 dirty.
2. **Stop 1** replays them and **exits 2** (228 s) with [the leak report](stop-hook-report.txt): Bob sees Alice's note 1001.
3. Claude fixes **#1 and #2** (owner checks on `/notes/:id` and `/api/notes/:id`) and checks the fix as Bob against the live server.
4. **Stop 2** replays and **exits 0** (156 s): all three boundaries HELD, dirty and attempts cleared.

477 s total, 22 turns, $0.62 of Claude usage, 5.99 Kane credits, 0 authoring runs. The guard never had to block.
Files: `transcript.jsonl` (Claude stream-json, scrubbed), `hooks.jsonl` (every hook call), `code.diff`, `claude-final-message.md`.

`attempt-1-hook-bug/` is the first try. The Stop hook exited 0 without reporting the leak: wiping the guest profile was
refused because Claude Code passes the real path (`/private/tmp/…`), and that error threw away B1's finished RED result.
Fixed in 0bccdf6 (real-path containment; each boundary's replay is isolated), then rerun.
