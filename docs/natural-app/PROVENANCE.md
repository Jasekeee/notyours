# Provenance: the "naturally built" app tested in RESULT.md

The app was written by a **fresh Claude Code session** (model `claude-sonnet-5-5`, all 20 assistant turns), in an
empty git repo at `~/code/natural-app`, on 2026-11-19 from 06:46:54 to 06:53:49 UTC (about 7 minutes). That session
had no notyours context and no security instructions. This file records exactly what it was told, and what it produced.
notyours never modified that folder.

## The exact prompts (verbatim, from the session transcript)

The session received two messages, plus a `/model` command that set Sonnet 5.5.

**1. Build prompt** (06:47:06 UTC):

```
Build a simple notes web app I can run locally on http://localhost:4000.
Features: sign up and log in with email + password; create, view and edit my notes; a "share" button that
gives a link so a logged-in friend can read one note; a free plan and a Pro plan (just a toggle on the
account page, no real payments) where Pro users can export all their notes as a text file.
Use Node.js + Express + SQLite and server-rendered HTML. Keep it simple and make it work end to end.
Add a README with how to start it.
```

**2. Follow-up** (06:50:38 UTC):

```
Commit everything with message "initial app". Then start the app with `npm start` and leave it running.
```

The session used only the Bash tool (10 calls). It tested its own features with scripted HTTP requests. On its own, it
added CSRF tokens, HTML escaping, per-user ownership checks, a server-side Pro check on export, login rate limiting,
a safe `next` redirect, and a 127.0.0.1-only bind. It describes these in its README under "Security notes". None of
this was asked for.

## The app's git log

```
commit 554cfb6a87dfac2e88afff625eca60f7b1dbed74
Author: Jasekeee
Date:   2026-11-19 11:50:42 +0500

    initial app

 .gitignore        |   2 +
 README.md         |  25 ++
 package-lock.json | 843 ++++++++++++++++++++++++++++++++++++++++++++++++++++++
 package.json      |   9 +
 server.js         | 312 ++++++++++++++++++++
 5 files changed, 1191 insertions(+)
```

That's the only commit. SHA-256 of the files at that commit:

```
dc901f7bb57945f395b3fa7ac0542f3c6b407cbde466488699f342f0d136d803  server.js
7b2391daf911bf9928dd963160e33407d06e82a0267808c75c19171f30ae34f6  package.json
3524b230424241769bb88904140d1295d162c4903fde745ad701ef45cf38e7d6  package-lock.json
8e40f3604b445b5bb463510b447581508393cd429cf6191bab0903a1002c7487  README.md
7671ce164d18e501e74838c0209f500deec1b3ccd7648e7d6107911028aaa0da  .gitignore
```

## What notyours tested (and why not the running :4000 instance)

The build session left the app running on :4000. That process writes its SQLite database to
`~/code/natural-app/data/`, so testing it would have written Kane's test accounts and notes into the folder that must
stay untouched. Instead, with the user's approval, the same commit was exported with
`git -C ~/code/natural-app archive 554cfb6` into a separate working folder (`~/code/natural-app-run`). It got its
own `npm ci` and its own database, and ran on **http://localhost:4001**. Its `server.js` is byte-identical to
`554cfb6` (checked with `diff`). `git status` in `~/code/natural-app` stayed clean throughout.
