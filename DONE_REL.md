# DONE_REL: release readiness for 0.2.0 (feat/release)

Branch `feat/release`, worktree `../notyours-rel`, based on `main` at `597a823` (tag `v0.1.5`).
Nothing was published, no Kane run was started, and no release or repo setting was changed.

## What changed

| File | Change |
|---|---|
| `package.json` | Version 0.2.0. Keywords, a longer description, `bugs`, `homepage`, `repository`, `engines` (Node >=22) and `files` kept (dist, demo, minus test data). New `prepublishOnly`: typecheck and build. |
| `package-lock.json` | Root version 0.1.0 → 0.2.0 (was stale at 0.1.0 before this branch). |
| `.github/workflows/ci.yml` | Build, typecheck and tests on every push and pull request. Ubuntu, Node 22, npm cache. No kane-cli install and no secrets. |
| `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`, `config.yml` | Issue forms. Blank issues off. A contact link points security reports at the private advisory form. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Checklist: typecheck, tests, build, no secrets, no Kane runs in tests. |
| `CHANGELOG.md` | Keep a Changelog format. Entries for 0.1.0 to 0.1.5 from the tag ranges, and 0.2.0. |
| `SECURITY.md` | Private reporting through GitHub, supported versions, scope, and the documented limits. |
| `CONTRIBUTING.md` | Setup, checks, and the project's rules (no new deps, tests never spend credits, no secrets). |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1, unmodified apart from the enforcement channel. |

## Verified (measured in this worktree)

- `npm ci` finished with `found 0 vulnerabilities`.
- `npm run build`: exit 0.
- `npm run typecheck`: exit 0.
- `npm test`: 22 files, **346 tests passed**, 154 s, exit 0. Headless Chrome was present locally.
- `npm pack --dry-run`: 52 entries, 789,095 bytes unpacked, 237,324 bytes packed. The bin file starts with the
  `#!/usr/bin/env node` shebang, and `dist/` is in the tarball.
- Tarball scan (all 52 files, including `.map`): no `/Users/`, `/var/folders` or `/home/` paths, no secret-shaped
  values, and no TestMu or Test Manager identifiers. Emails are only `.test` and `.invalid` fixtures. The two
  `lambdatest` strings are the public Homebrew tap (`brew install lambdatest/kane/kane-cli`).
- `node dist/cli/index.js --version` prints `0.2.0`.
- The npm name `notyours` returned 404 from the registry, so it appears to be free. Re-check just before publishing.

## Not verified

- **The GitHub Actions workflow has not run on GitHub.** I can't run Actions here. The steps are the same commands
  as the local run, on `ubuntu-latest`. The first run is the real check. Chrome is assumed to be on the runner
  (`google-chrome` is part of the image); if the browser tests fail there, that is the first thing to look at.
- Private vulnerability reporting may not be enabled on the repo yet (see the commands below).
- The tarball has not been installed in a clean folder with `npx notyours`. It can't be until it is published.

## Decisions to review

1. **`dist/` is not committed to git.** It is gitignored and rebuilt by `prepare` on `npm ci` and `prepublishOnly`
   on publish, so the published tarball always has a fresh build. Committing build output for the `npx github:`
   path would add a few MB of churn to every release. Installs from GitHub still build on first run (`prepare`).
2. **No README edit.** The README isn't in this sprint's ownership. The badge line is below for you to paste.
3. **No email contact is invented.** Security and conduct reports go through GitHub's private advisory form, which
   needs enabling (command below). If you want an email address, add it to SECURITY.md and CODE_OF_CONDUCT.md.
4. **Version 0.2.0** is the bump requested. feat/onboarding and feat/site are not in this branch, so they are not in
   the 0.2.0 changelog yet. Add their entries when they merge, before the tag is cut.

## README badge line (paste into README.md)

```md
[![CI](https://github.com/Jasekeee/notyours/actions/workflows/ci.yml/badge.svg)](https://github.com/Jasekeee/notyours/actions/workflows/ci.yml)
```

## Commands to run yourself (not run by me)

```sh
# 0. Check the name is still free, and that you are logged in to npm
npm view notyours name || echo "name free"
npm whoami

# 1. Publish (from the merged release commit on main; prepublishOnly runs typecheck and build)
cd /Users/zhasulanmedetkhan/code/notyours && git switch main && git pull --ff-only
npm publish --access public            # add --otp=<code> if 2FA asks

# 2. Repository description, homepage and topics
gh repo edit Jasekeee/notyours \
  --description "Prove your users' data stays theirs: cross-user leak tests for your own app, driven by Kane CLI personas and a canary-token oracle" \
  --homepage "https://github.com/Jasekeee/notyours#readme" \
  --add-topic kane-cli --add-topic claude-code --add-topic security-testing \
  --add-topic access-control --add-topic idor --add-topic canary-token --add-topic end-to-end-testing

# 3. Turn on private vulnerability reporting (needed for SECURITY.md and the issue form link). Check the response.
gh api -X PUT repos/Jasekeee/notyours/private-vulnerability-reporting

# 4. Release v0.2.0 at the merged main commit (creates the tag). Notes are the 0.2.0 section of CHANGELOG.md,
#    read at run time, so they match the file after the onboarding and site work merges.
gh release create v0.2.0 --target main \
  --title "notyours 0.2.0" \
  --notes "$(awk '/^## \[0\.2\.0\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md)"
```

Run steps 1 and 4 only after `feat/release` is merged into `main`. Step 1 publishes what `main` contains.

## Sprint status

- Branch `feat/release`: this commit series. Not merged.
- Tags, `main` and the other branches were not changed.
- Re-checked 2026-11-19: `npm run build` exit 0; `npm pack` gives 37 entries (92 KB packed) with `dist/` and `demo/`; source maps are excluded (`!dist/**/*.map`); no
  `/Users/`, `/home/`, `/var/folders`, `LT_` tokens, `sk-` keys, `ghp_` tokens or private keys in the tarball.
  Hits on `user_id`, `org_id` and `testmuai` are SQL column names and source text only. The demo's
  `identities.json` holds fake fixture tokens (`NY-…JOTTERSEED…`) and `.test` emails, shipped on purpose.
  CHANGELOG entries match the commits in each tag range (v0.1.0 to v0.1.5, first commit 2026-11-18).
