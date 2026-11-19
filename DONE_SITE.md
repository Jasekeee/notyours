# DONE_SITE: feat/site (craft sprint)

Branch `feat/site`, worktree `../notyours-site`, from `main` at 597a823. No Kane runs, no credits spent.

## What changed

| Item | Where | Status |
|---|---|---|
| README rewritten as a product README | `README.md` | Done. Quickstart uses the `github:` fallback (see open items). |
| Product narrative (was ABOUT.md) | `docs/WHY.md` (renamed from `docs/ABOUT.md`) | Done |
| Static product page | `site/index.html` | Done. One file, no external scripts or fonts. Phone width checked at 390 px: no horizontal scroll. |
| Sample report embedded | `site/sample-report/report.html` (copy of `docs/sample-report/report.html`) | Done. Checked: no emails, no share links, no account ids, no scripts. Only local `127.0.0.1` URLs. |
| Pages deploy workflow | `.github/workflows/pages.yml` | Written. **Not enabled.** See open items. |
| Social preview 1280×640 | `assets/social-preview.png`, source `assets/social-preview/card.html`, renderer `assets/social-preview/render.mjs` | Done. Rendered with local Chrome through the repo's `puppeteer-core`. Verified 1280×640. |
| SUBMISSION moved out of the repo | `~/notyours-private/SUBMISSION.md` (outside any repo, untracked) | Done. `docs/SUBMISSION.md` removed from the tree. |
| Hackathon wording removed | `README.md`, `docs/WHY.md`, `docs/E2E.md`, `docs/KANE_COMPAT.md`, `site/` | Done in my scope. See the remaining mentions below. |
| Placeholder for the demo GIF | `README.md` (`assets/demo.gif`) | Placeholder only. The file does not exist yet. |

## Numbers in the README and site, and where they come from

| Number | Source |
|---|---|
| Quick demo 4 m 48 s, 61.69 credits | `docs/STATUS.md`, "Judge path after the audit fixes" |
| Full demo 9 m 44 s, 113.34 credits, 11 authoring runs | `docs/E2E.md`, run 1 |
| Replay of 4 locked boundaries: 170 s, 3.4 credits, GREEN | `docs/E2E.md`, replay table |
| Stop hook 70–535 s, median about 130 s | `docs/STATUS.md`, "Timings" |
| Verdicts B1 LEAK_VISIBLE, B2 HELD, B3 LEAK_PAYLOAD, B4 HELD | `docs/E2E.md`, run 1 |
| Sample report: 2 leaks, 2 held | `docs/sample-report/report.html` (checked) |
| OWASP: Broken Access Control is #1 in Top 10:2025 | https://owasp.org/Top10/2025/A01_2025-Broken_Access_Control/ (verified by the owner; not opened by the agent) |

Removed: the README's full-demo figure "10 min 49 s, 163 credits". No measurement doc records it, so it is gone.
The comparison section names no competitor facts. It describes trade-offs, and says that no benchmark was run.

## Checks

- `npm ci` in the worktree: 0 vulnerabilities.
- `npm run typecheck` and `npm test`: see the result line at the end of this file.
- `git diff --cached --name-only` read before commit; nothing in the forbidden list was staged.

## Open items (need you)

1. **Enable GitHub Pages.** The workflow runs on pushes to `main` that touch `site/`, or by hand. It will fail until
   Settings > Pages > Source is set to GitHub Actions. I did not enable it.
2. **Git history still has the removed files.** Removing `docs/SUBMISSION.md` from the tree does not remove it from
   history, and neither does the ABOUT.md rename. Removing it from history means rewriting history and force-pushing,
   which CLAUDE.md forbids. Tell me if you want that done as a separate, approved step.
3. **Hackathon mentions outside my scope:**
   - `src/cli/demo.ts:33` comments on `docs/SUBMISSION.md` (dangling now). Belongs to feat/onboarding (src/cli).
   - `docs/STATUS.md:179` mentions "submission drafts". Belongs to the STATUS owner. The "Judge path" headings there
     use "judge" as a verb about verdicts, and "judges" in a few places. Not hackathon wording, but worth a rename.
   - `scripts/judge-loop.sh:2` says "for judges". Not my folder.
4. **The README quickstart** uses `npx github:Jasekeee/notyours init`, because `notyours` is not on npm. When the
   onboarding wizard lands and the package is published, switch the quickstart to `npx notyours init`. Do not claim the
   30-second quickstart until it has been timed.
5. **The social image URL** in `site/index.html` (`og:image`) points at `main`. It resolves only after this branch merges.
6. **The demo GIF** (`assets/demo.gif`) is not recorded. The README shows a placeholder line.

## Commit

See the git log on `feat/site` for the commit hash. Co-authored line per the attribution rule.
