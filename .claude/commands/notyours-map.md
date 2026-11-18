---
description: Turn notyours route drafts into real isolation boundaries (you write them, Kane proves them)
argument-hint: "[route or draft id filter]"
---

You are turning the drafts from `notyours map` into real notyours boundaries for this app.
A boundary says "this identity must NOT see that identity's data". notyours proves it with
Kane CLI browser personas and a canary token: the owner plants a unique token like
`NY-ALICE-K7Q2MZX4P3RA` in a record, the viewer visits the targets, and if the token shows up on
the viewer's screen or in any network response, it is a leak. You write the boundaries. Kane proves them.

Filter (optional): $ARGUMENTS

## Steps

1. If `.notyours/map.json` is missing or older than the code, run `npx notyours map`.
2. Read `.notyours/map.json` (routes, the files behind them, and the identity ids/roles you may use)
   and every `.notyours/boundaries/_draft_*.yaml`. Read `.notyours/config.yaml` for `baseUrl`.
3. For each draft, read the route's code and what it calls (handler, auth middleware, data query).
   Decide whether it really serves one user's data, or really gates a Pro feature.
   If not, delete the draft and say why in one line.
4. Fill in the draft:
   - `create.objective`: plain-English steps for Kane (a browser agent) acting as `owner`.
     Start from a full URL (`baseUrl` + path), describe the clicks and fields in the real UI
     (not API calls), put the literal `{{token}}` in a visible text field (title, name, memo),
     and say which values to store, e.g. "store the new note's URL as 'note_url'".
   - `create.store`: the variable names the objective stores.
   - `targets.ui`: pages the `viewer` opens, using stored values (`{{note_url}}`).
   - `targets.api`: the JSON endpoints those pages call, with stored ids
     (`http://localhost:3000/api/notes/{{note_id}}`). These catch tokens that reach the
     browser but never render (verdict `LEAK_PAYLOAD`).
   - `surface`: globs of the code that enforces this boundary (route handler, ownership check,
     query). They are handed back to you when the boundary leaks.
   - plan-gate only: `proAction.objective`: the Pro-only action a free user attempts.
   - Keep `expect: denied`. Never add `locked`: only `notyours lock` sets it.
5. Save each one as `.notyours/boundaries/<id>.yaml` (drop the `_draft_` prefix) and delete the draft.
   Add a `guest` variant (`kind: guest`, `viewer` = the guest identity) for routes that should
   require login.
6. Check your work with `npx notyours run --dry-run`. It validates every boundary and prints the
   plan and the credit estimate without starting Kane.
7. Stop and tell the user what you wrote and the command to prove it: `npx notyours run <ids>`.
   Do not run it yourself: each new boundary costs about 16 Kane credits to author
   (replays of locked boundaries are free).

## Example

```yaml
id: notes-cross-user
kind: cross-user
owner: alice
viewer: bob
create:
  objective: >-
    Go to http://localhost:3000/notes/new, type '{{token}}' as the note title, click Save,
    then store the current page URL as 'note_url' and the note id from that URL as 'note_id'
  store: [note_url, note_id]
targets:
  ui: ['{{note_url}}']
  api: ['http://localhost:3000/api/notes/{{note_id}}', 'http://localhost:3000/api/notes']
expect: denied
surface: ['src/routes/notes.ts', 'src/middleware/auth.ts']
```

## Rules

- Only write files under `.notyours/boundaries/`. Do not change app code in this command.
- Do not read `.notyours/secrets.json` (identity passwords) and do not ask for passwords.
  Use identity ids from `.notyours/map.json`.
- Only use the `baseUrl` host from `.notyours/config.yaml`. Never point Kane at a site the user doesn't own.
- Locked boundaries and `.testmuai/tests/` recordings are read-only (the notyours guard hook blocks edits).
