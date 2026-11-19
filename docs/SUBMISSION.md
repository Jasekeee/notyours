# notyours: submission kit (KaneCLI Online Hackathon)

Everything needed to submit: judge simulation, video plan, posts, form answers, final checklist.
Facts about notyours come from this repo (README, docs/STATUS.md, docs/loop-run-*, docs/natural-app/*). External facts are listed with
their sources in [Sources to check](#sources-to-check-before-posting).

> **Deadline check.** kaneclihack.sh (fetched 2026-11-19) says the deadline is **26 November, 11:59 PM IST**
> ("Extended from 19 Nov. No pushes after this."). Confirm on the site which date applies before relying on the
> extension.

---

## 1. Judge simulation (2026-11-19, kane-cli 0.10.0, macOS, empty npm cache)

Followed the README exactly: fresh `git clone` into a temp dir, then the README commands from an empty folder, with an
**empty npm cache** (as on a judge's machine).

| Step | Time | Result |
|---|---|---|
| `git clone https://github.com/Jasekeee/notyours.git` | 3 s | ok |
| `npx github:Jasekeee/notyours doctor` (first use: download + install + build) | **90 s** | all green: Node, Chrome, kane-cli 0.10.0 (tested 0.10.0–0.10.6), login, credits, port 3077 |
| `npx github:Jasekeee/notyours demo` (full, B1–B4) | **10 min 49 s** | B1 **LEAK** (visible), B2 **HELD**, B3 **LEAK** (in payload), B4 **HELD**; report written. **163.4 credits** |

**What a judge would trip over, and what was done:**

| # | Finding | Fix (docs only) |
|---|---|---|
| 1 | The README said npx builds notyours "~30 s" on first use; it took **90 s** with an empty npm cache. Nothing prints during that time except npm notices. | README now says "about 1–2 min on first use, nothing prints while npm installs". |
| 2 | Quick start (a) links `docs/sample-report/report.html`. On GitHub that opens as **HTML source**, not as a page. | README (a) now gives a one-line download-and-open command. |
| 3 | npx asks "Ok to proceed? (y)" the first time in an interactive terminal. | README mentions it (answer `y`). |
| 4 | The full demo is longer than 2 minutes by design (Kane authors 4 boundaries + 2 logins). | Already stated up front, and `demo` prints the estimate before it starts. The 0-credit path is (a). |
| 5 | The README said "~120 credits" for the full demo; this run used **163.4**. Locking B2 re-recorded two runs (16.6 credits) instead of reusing the probe's recordings, and authoring runs cost 14–37 credits each. | README (c) now says "~10–11 min, ~120–165 credits". `demo`'s own printed estimate (~120) is code and was left as is. |

No code was broken in the simulation.

---

## 2. Demo video (target 4:20; the rules ask for about 3 to 5 minutes)

### Before recording (not filmed, ~25 min)

```sh
mkdir -p ~/ny-video && cd ~/ny-video
npx github:Jasekeee/notyours doctor                     # all green

# Kane in visible Chromes, so you can film Alice's and Bob's browsers (shot 4). ~11 min, ~165 credits.
NOTYOURS_HEADFUL=1 npx github:Jasekeee/notyours demo --dir ~/ny-video/jotter
#   expect: B1 LEAK, B2 HELD, B3 LEAK, B4 HELD; the report opens in your browser (shots 3 and 5)
#   film the screen during this run: the Chrome windows are the "Kane is the hands" footage

cd ~/ny-video/jotter
cp routes/notes.js ~/ny-video/notes.buggy.js            # keep the buggy version for the regression shot
node server.js &                                        # Jotter on :3077 (the Stop hook restarts it via app.start)
npx github:Jasekeee/notyours install-hooks              # guard + post-tool + Stop hooks, fail-closed launcher
```

**Session A (not filmed, ~10 min): let the agent fix and lock everything.**

```sh
claude "Run npx github:Jasekeee/notyours run, fix every leak it reports in the server code (not the tests), \
rerun until all boundaries hold, then npx github:Jasekeee/notyours lock."
```

Expect: Claude fixes the owner checks in `routes/notes.js` and the plan check in `routes/pro.js`, `run` shows all
four HELD, and `lock` locks B1 and B3. Now all four boundaries are locked.

**Session B (FILMED, ~8 min real time, becomes the cold open + shot 6): the regression.**

```sh
cp ~/ny-video/notes.buggy.js routes/notes.js             # a careless edit puts the bug back (a shell edit, no editor)
claude "Add a 'duplicate note' button on the note page."
```

What appears: Claude edits `routes/notes.js`. When it tries to stop, the Stop hook first restarts Jotter (the demo's
`app.start`), so it judges the code on disk, not an old server process. Then it replays the locked boundaries and
**blocks** with:

```
notyours: LEAK in boundary b1-notes-cross-user (cross-user), attempt 1/3
  bob saw alice's data
  URL: http://127.0.0.1:3077/notes/1001
  Leak: VISIBLE (rendered on the page)
  Token: NY-ALICE-… in page text (untrusted): "Passport no. NY-ALICE-…"
  ...
Fix server-side; do not edit tests.
```

Claude adds the owner check back, stops again, and the replay passes (all boundaries HELD). In loop run 1 this took
two Stop passes (228 s and 156 s) and 5.99 Kane credits (docs/loop-run-1). Film all of it; speed it up in editing.
If Claude happens to fix the bug before its first stop, show the block with
`npx github:Jasekeee/notyours replay b1-notes-cross-user` (exit 1, LEAK) instead, then let Claude fix it.

**Session C (FILMED, ~2 min): anti-cheat.** In `~/ny-video/jotter`:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"rm .notyours/dirty.json"}}' \
  | npx github:Jasekeee/notyours hook guard | jq -r .hookSpecificOutput.permissionDecisionReason
#   notyours guard: in Bash, .notyours/, .testmuai/ and .claude/settings are read-only (...)
echo '{"tool_name":"Edit","tool_input":{"file_path":"'"$PWD"'/.notyours/boundaries/b1-cross-user.yaml"}}' \
  | npx github:Jasekeee/notyours hook guard | jq -r .hookSpecificOutput.permissionDecision
#   deny  (B1 is locked now)
CLAUDECODE=1 npx github:Jasekeee/notyours budget --set 999 < /dev/null
#   ✗ notyours budget --set raises the Kane credit budget, which is a person's decision, so it won't run from a coding agent. ...
```

**Session E (FILMED, ~1 min): the natural-app experiments.** No commands to run. Film these files in the browser
(GitHub) or the editor: `docs/natural-app/SUMMARY.md` (the table) and `docs/natural-app/EXPERIMENT3.md` (the Stop-hook
table with "restarted the app (app.start)" and the three HELD verdicts).

**Session D (FILMED, ~1 min): the white-box map and the try-it command.**

```sh
npx github:Jasekeee/notyours map
#   Scanned 17 routes → .notyours/map.json
#     draft   notes-id-cross-user  GET /notes/:id
#     draft   pro-export-plan-gate  GET /pro/export   (5 drafts in total)
cd ~ && npx github:Jasekeee/notyours demo --quick        # film the first 10 s (the estimate it prints), then stop with Ctrl+C
```

### Shot list and voiceover (~130 words per minute, about 4:15 spoken; the rules allow 3 to 5 minutes)

| Time | Shot (what's on screen) | Voiceover |
|---|---|---|
| **0:00–0:30** | **Cold open, Session B sped up.** Claude Code adding a button. The Stop hook blocks: "bob saw alice's data", with the URL and the token. Cut to the report screenshot of Bob's browser showing Alice's passport note. Claude edits `routes/notes.js`. Second stop: all boundaries HELD, green. | My AI agent just added a button to a notes app. It also put back a bug: Bob can open Alice's private note. notyours caught it before the agent could finish. Real browsers, a real leak, with proof. The agent read the evidence, fixed the access check, and the replay came back green. I didn't touch the code. The whole loop took a few minutes. |
| **0:30–0:56** | Title card "notyours: prove your users' data stays theirs". Then the OWASP and CVE facts as plain text on screen (see Sources). | This is the most common way web apps leak data. Broken access control is number one on the OWASP Top Ten. In 2025, a researcher found 170 apps built on one AI app builder that exposed user data like emails and phone numbers. Unit tests rarely catch it, because they never run as two users at once. |
| **0:56–1:38** | The full-demo report (Session 0): headline "Bob saw Alice's data", then the B1 card. Zoom in on the highlighted token, then on the two positive controls. | notyours runs as two people at once. Alice creates a note with a random canary token in it. Bob then opens the pages where Alice's data could show up. If Alice's token ever reaches Bob's screen, or even just his network traffic, that is a leak. No AI judges the page; the token is there or it isn't. Two positive controls make sure an empty result means something. Alice must see her own token, and Bob must see his. If either check fails, the result is "harness broken", never "safe". |
| **1:38–2:05** | `npx github:Jasekeee/notyours map` output (Session D). Then the headful Chrome footage from Session 0: two Chrome windows, Kane typing as Alice and as Bob. | It works from both sides. A white-box map reads your routes and drafts the boundaries to test. Your coding agent turns those drafts into real tests. Then Kane CLI is the black box. It drives a separate Chrome for each persona and does what a real user would do. It signs in, creates a note, opens a link. |
| **2:05–2:32** | Report card B3 (plan-gate): "LEAK in payload". Show the Pro page is hidden for Bob, but the export data reached his browser. Show `// SEEDED BUG #3` in `routes/pro.js`. | Here is the freeloader bug. Bob is on the free plan. The Pro export button is hidden from him, so the page looks fine. But the export API never checks his plan. The Pro-only export still reached Bob's browser, and notyours flags that as a leak in the payload. The demo bugs are seeded and labelled on purpose. |
| **2:32–3:04** | Session B again, slower: `install-hooks` output, the Stop hook block, and then the green replay. Overlay: "Stop replay: about 1 to 4 minutes, sped up". | Every boundary that holds gets locked into a recorded Kane test. That is the ratchet. From then on, every time the coding agent stops, notyours replays the boundaries whose code changed. It catches edits made with an editor, and edits made from the shell too. If a fix regresses, the agent can't finish. It gets the evidence back and has to fix the app code, not the test. |
| **3:04–3:31** | Session C: the three denials, one after another. | And it can't cheat. The guard blocks the agent from deleting the check or editing a locked test. It can't raise its own Kane budget either. That is a person's decision. In one test I told the agent to make the tests pass by any means. It never touched the oracle. It fixed the server code instead. |
| **3:31–4:00** | Session E: `docs/natural-app/SUMMARY.md` (the table), then EXPERIMENT3's Stop-hook table. | Then I tested it on an app it didn't write. A fresh Claude Code session built a notes app with no security hints. Twice I asked an agent to add a page cache, the classic way to leak pages between users. Neither model leaked, and notyours raised no false alarm. It did find four gaps in notyours itself, and I fixed them all. |
| **4:00–4:12** | Session D: `npx github:Jasekeee/notyours demo --quick` printing its estimate. | You can try it with one command. The quick demo takes about four minutes and shows one real leak. You need Node, Chrome and Kane CLI. |
| **4:12–4:19** | Closing card: "notyours · github.com/Jasekeee/notyours · built with Claude Code and Kane CLI · #KaneCLIHackDay". | notyours. Built with Claude Code and Kane CLI. The link is below. |

### Recording on macOS

1. **Clean screen.** Turn on Do Not Disturb (Control Center → Focus → Do Not Disturb). Quit Slack, Mail and messengers.
   Hide desktop icons (`defaults write com.apple.finder CreateDesktop false; killall Finder`, and
   `defaults write com.apple.finder CreateDesktop true; killall Finder` to undo). Hide the Dock (⌥⌘D).
2. **Resolution.** Record at 1920×1080: System Settings → Displays → pick the scaled option closest to 1920×1080
   (on a Retina laptop "More Space" or "1680×1050" also works; YouTube handles it). Record full screen.
3. **Terminal.** Font size 18–20 pt (⌘+ in Terminal or iTerm), a dark theme, window about 120×32. Short prompt:
   `export PS1='$ '` (zsh: `PROMPT='$ '`). Run `clear` before each take.
4. **Browser.** Use a separate Chrome profile with no bookmarks bar, zoom 125% for the report.
5. **Record.** Press ⌘⇧5 → "Record Entire Screen" → Options: microphone **None** (record the voiceover separately),
   enable "Show Mouse Clicks" → Record. Stop it from the menu-bar button. Files land on the Desktop as `.mov`.
6. **Edit** in iMovie (free). Import the clips and cut them to the shot list. Speed up the long Kane parts
   (select clip → speedometer → Fast, 4× to 20×) and add a small "sped up" label. Record the voiceover with iMovie's
   voiceover tool (microphone icon under the viewer), one shot at a time, reading the table above. Export:
   File → Share → File → 1080p, High quality.

### Upload to YouTube

1. youtube.com → Create → Upload video → the exported file.
2. **Title:** `notyours: catching data leaks in AI-built apps with Kane CLI and Claude Code`
3. **Description:**

   ```
   notyours proves your users' data stays theirs. Kane CLI signs in as Alice and Bob in real browsers. If Alice's
   canary token ever reaches Bob's screen or network traffic, that's a leak. Proven boundaries become replayable
   Kane tests, and a Claude Code Stop hook replays them every time the agent finishes, so regressions bounce back
   to the agent with the evidence.

   Code: https://github.com/Jasekeee/notyours
   Try it: npx github:Jasekeee/notyours demo --quick
   Kane CLI: https://www.testmuai.com/kane-cli/
   Built for the KaneCLI Online Hackathon by TestMu AI. #KaneCLIHackDay

   0:00 A leak, caught and fixed by the agent
   0:30 The problem
   0:56 Canary tokens and positive controls
   1:38 White-box map, Kane as the black box
   2:05 The freeloader bug
   2:32 The ratchet and the Stop hook
   3:04 Anti-cheat
   3:31 Tested on an app it didn't write
   4:00 Try it
   ```

   Chapters need the first timestamp at 0:00, at least three timestamps, and chapters of at least 10 s
   ([YouTube help](https://support.google.com/youtube/answer/9884579)). Adjust the times to the final cut.
4. **Visibility:** **Public** (it's also your launch post, and judges can open it without an account). Unlisted works
   too if you prefer, but then the X/LinkedIn posts are the only way in.
5. "Made for kids": No. Add the video link to the form and the posts.

---

## 3. Posts (no em dashes; check every external fact against the sources below)

### X thread (4 posts; post 1 carries the video)

**1/4** (attach the video)
```
AI coding agents ship features fast. They also ship the bug where Bob opens Alice's private note by changing a number in the URL.

I built notyours: Kane CLI signs in as Alice and Bob in real browsers and checks if Alice's data ever reaches Bob.

#KaneCLIHackDay
```

**2/4**
```
This isn't rare. Broken access control is #1 on the OWASP Top 10 (2025).

In 2025 a researcher scanned 1,645 apps built with Lovable and found 170 that let anyone read data like emails and phone numbers (CVE-2025-48757).
```

**3/4**
```
How it works: Alice creates a note with a random canary token. Bob goes looking for it.

If the token shows up on Bob's screen or in his network traffic, it's a leak. No AI judging the page.

Two positive controls make sure "found nothing" means safe, not broken.
```

**4/4**
```
Proven boundaries become Kane tests that replay each time Claude Code stops. A regression blocks the agent until it fixes the app.

On an app a fresh agent built: 0 leaks, 0 false alarms, 4 notyours gaps fixed.

@testmuai Kane CLI hackathon: github.com/Jasekeee/notyours
```

### LinkedIn post (tag TestMu AI by typing "@TestMu AI" and picking the company page)

```
Most data leaks in web apps aren't clever hacks. They're a missing ownership check: change a number in the URL and you're
reading someone else's record. Broken access control is the #1 risk in the OWASP Top 10 (2025). In 2025 a researcher
also found 170 apps built with Lovable that exposed user data such as emails and phone numbers (CVE-2025-48757).

AI coding agents make this easy to ship and hard to notice. Unit tests rarely catch it because they never run as two
users at once.

So for the KaneCLI hackathon by @TestMu AI, I built notyours. Kane CLI drives a real Chrome for each persona (Alice, Bob,
a guest, a free user). Alice's data carries a random canary token. If that token ever reaches Bob's screen or his
network traffic, notyours reports a leak with the URL and the evidence. Two positive controls make sure an empty
result really means the data was protected.

The part I like most is the loop. Every boundary that holds is locked as a recorded Kane test. A Claude Code hook
replays them each time the agent finishes. If an edit brings a leak back, the agent can't stop until it fixes the
server code, and it can't edit the tests to cheat.

I also tested it on an app it didn't write: a notes app that a fresh Claude Code session built with no security
hints. Over three experiments, two of them asking an agent (Sonnet, then Haiku) to add a page cache, notyours found no
leaks and raised no false alarms. It did expose four gaps in notyours itself. One was a Stop hook that replayed an old
server process; another was export files the browser downloads instead of showing. I fixed all four. The write-ups
are in the repo, including what still doesn't work.

It's open source. Try the demo with one command:
npx github:Jasekeee/notyours demo --quick

Code and the demo video: https://github.com/Jasekeee/notyours
#KaneCLIHackDay
```

### Sources to check before posting

| Claim | Source |
|---|---|
| Broken access control is #1 in the OWASP Top 10 2025 ("Maintaining its position at #1"); "100% of the applications tested were found to have some form of broken access control" | https://top10.owasp.org/2025/A01_2025-Broken_Access_Control/ |
| 170 of 1,645 analyzed Lovable projects (303 endpoints) exposed data incl. emails, names, phone numbers, payment details and API keys; statement dated 29 May 2025; CVE-2025-48757 | https://mattpalmer.io/posts/statement-on-CVE-2025-48757/ (NVD: https://nvd.nist.gov/vuln/detail/CVE-2025-48757) |
| (Optional, not used in the posts) Veracode, 30 Jul 2025: "In 45 percent of all test cases, LLMs introduced vulnerabilities classified within the OWASP Top 10" (80 tasks, 100+ LLMs; a benchmark, not a share of production code) | https://www.veracode.com/press-release/ai-generated-code-poses-major-security-risks-in-nearly-half-of-all-development-tasks-veracode-research-reveals/ |
| TestMu AI's X handle is @testmuai; LinkedIn page linkedin.com/company/testmu-ai (from the structured data on the Kane CLI page) | https://www.testmuai.com/kane-cli/ → check https://x.com/testmuai and https://www.linkedin.com/company/testmu-ai/ open |
| The hackathon hashtag is #KaneCLIHackDay; organizer TestMu AI; at least two public posts are required | https://kaneclihack.sh |
| Kane CLI is "an end-to-end testing agent for developers and their coding agents" | https://www.testmuai.com/kane-cli/ |
| Everything about notyours (personas, canary tokens, positive controls, ratchet, Stop hook, guard) | this repo: README.md, docs/STATUS.md, docs/loop-run-1..3 |
| Natural-app experiments: 3 experiments, 0 leaks, 0 false alarms; 4 notyours gaps fixed (stale server, file downloads, the app's CSP blocking the oracle's fetch, signed-in login replays); models Sonnet 5.5 and Haiku 5.5 | docs/natural-app/SUMMARY.md, RESULT.md, EXPERIMENT2.md, EXPERIMENT3.md, PROVENANCE.md |

---

## 4. Form answers (kaneclihack.sh/o/submit)

The form loads after login, so the field names below follow the site's list of what to submit. Match them to the
form.

- **Team:** Solo.
- **Credits claimed:** Yes. Check that the TestMu AI account that holds the credits uses the same email as your
  hackathon registration ("Use the same email on both").
- **GitHub URL:** https://github.com/Jasekeee/notyours (public, MIT, first commit 2026-11-18, release tag `v0.1.2`)
- **Demo video:** `https://youtu.be/<VIDEO_ID>` (placeholder)
- **Live URL (optional):** none. notyours is a CLI that tests your own app on localhost. Fallbacks for judges:
  the sample report (`docs/sample-report/report.html`), three recorded agent loops (`docs/loop-run-1..3`), and three
  experiments on an app notyours didn't write (`docs/natural-app/SUMMARY.md`).
- **Install command:** `npx github:Jasekeee/notyours demo --quick` (needs Node 22+, Chrome, and a logged-in kane-cli;
  check first with `npx github:Jasekeee/notyours doctor`)
- **Lane: Workflow ("Workflows with a spine": Kane runs on save, on push, or on a schedule).** Why: the core of
  notyours is a loop that runs Kane automatically on every coding-agent stop (the Claude Code Stop hook), replays locked
  boundaries as a CI-style gate (`replay` exits 1 on a leak), and feeds the result back to the agent. That fits
  "Kane runs on save" closest. Runner-up: Web + Mobile ("Apps that prove themselves"), since it verifies an app in a
  real browser. The judging bars "Kane CLI caught or proved something" and "Your agent and Kane CLI talked to each
  other" are what the Workflow framing shows best.
- **About your app (what you built, which agent, what Kane does):**

  > notyours proves that your users' data stays theirs. It signs in as several personas (Alice, Bob, a guest and a
  > free-plan user) and has each of them use your own app in a real browser. Alice's data carries a random canary
  > token. If that token ever reaches Bob's screen or his network traffic, that's a leak, reported with the URL, the
  > snippet and a screenshot; two positive controls make sure "nothing found" really means held. I built it with
  > Claude Code (Opus), using parallel agents in git worktrees for the engine, the demo app, the ratchet and the CLI.
  > Kane CLI plays three roles: it is the product's hands (one Chrome per persona: sign up, log in, create data, open
  > each other's pages), it re-proves every fix (proven boundaries are locked as recorded Kane tests and replayed),
  > and it verified the build itself (real runs found bugs the mocks missed). The loop is closed: a Claude Code Stop
  > hook replays the locked boundaries whose code changed every time the agent finishes. A leak blocks the agent with
  > the evidence until it fixes the server code, while a guard stops it from editing the tests, the recordings or its
  > own Kane budget. On the bundled demo app Kane catches a cross-user leak and a "freeloader" bug (a free user gets
  > the Pro export through the API), and in recorded runs Claude Code fixed both and the replays came back green.
  > I also tested it on an app it didn't write: a notes app built by a fresh Claude Code session with no security
  > hints. In three experiments, two of which asked an agent (Sonnet 5.5, then Haiku 5.5) to add a page cache, it found
  > no leaks and raised no false alarms. Those runs exposed four gaps in notyours itself, all now fixed: a Stop hook
  > that judged a stale server process (it now restarts the app first), export files Chrome downloads instead of
  > showing, an app's strict CSP blocking the oracle's fetch(), and failed login replays for personas that were still
  > signed in.

---

## 5. Final checklist

- [x] Repo is public: https://github.com/Jasekeee/notyours (checked 2026-11-19, logged out: HTTP 200)
- [x] LICENSE: MIT (`LICENSE`, detected by GitHub)
- [x] Repo started on or after 12 Nov: first commit 2026-11-18
- [x] README top section: one-line pitch, the 60-second pitch, Install, Judges' quick start (a)–(d)
- [x] Tags on GitHub: `v0.1.0` (b138214), `v0.1.1` (bb86620), `v0.1.2` (5567494); https://github.com/Jasekeee/notyours/tree/v0.1.2 opens
- [ ] `main` has the fix-day fixes (stale server, downloads, CSP, signed-in logins) after `v0.1.2`, and the README's
      `npx github:Jasekeee/notyours` runs `main`. Optional: tag `main` as `v0.1.3` before submitting, so the tag matches.
- [x] These links open logged out (HTTP 200): repo, LICENSE, the v0.1.2 tag, the raw sample report, docs/loop-run-1
- [ ] Open them once yourself in an incognito window (and the YouTube link once it exists)
- [ ] Optional: add a repo description and topics (GitHub → About → ⚙), e.g. "Prove your users' data stays theirs:
      cross-user leak tests for your own app with Kane CLI and Claude Code"; topics `kane-cli`, `claude-code`,
      `security-testing`, `access-control`
- [ ] TestMu AI account email = the email on the hackathon form (`kane-cli whoami` shows the account; compare it
      yourself; it's not printed here)
- [ ] Video: Public or Unlisted, 3–5 min, link in the form and in the posts
- [ ] Two public posts are live (X thread + LinkedIn), with #KaneCLIHackDay; add their links to the form if it asks
- [ ] No pushes after the deadline (the site says so)
