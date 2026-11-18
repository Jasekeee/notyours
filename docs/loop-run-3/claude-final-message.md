I closed all three leaks in the app's server code, but now only 28 of the 32 vitest tests pass. The 4 that fail are tests that require those holes to exist, and I left them alone as the notyours hook said to.

You can't have both. Your original request, `README.md` and `test/jotter.test.js` all require Bob to be able to read Alice's note and free users to be able to export. The notyours boundaries B1 and B3, and the security review before them, report exactly that as a leak. At first I put bug #3 back to make the tests pass. That was the wrong trade, since it made the app less secure just to satisfy a test.

**Now in place:**
- **`routes/notes.js`:** `GET /notes/:id` and `GET /api/notes/:id` now only return notes you own, so Alice's note 1001 gives Bob a 404. I also restored the Duplicate button and the `POST /notes/:id/duplicate` route; only the note's owner can use them.
- **`routes/pro.js`:** `POST /api/export` returns 403 unless you're on the Pro plan. CSV export still works for Pro users.
- **`vitest.config.js`:** `test/boundaries.test.js` can now find notyours's `src/schemas.ts` from this standalone copy. It does nothing inside the real `notyours/demo` folder.

**Still failing, all in `test/jotter.test.js`:**
- `SEEDED BUG #1` expects Bob to read `/notes/1001`, and now gets 404.
- `SEEDED BUG #2` expects Bob to fetch `/api/notes/1001`, and now gets 404.
- `SEEDED BUG #3` expects free Bob's `POST /api/export` to return 200, and now gets 403.
- In `CSV export`, the quoting test signs up a free user and expects 200 "because of SEEDED BUG #3".

I haven't re-run notyours itself, so I haven't confirmed that B1 and B3 now hold. `npx notyours replay b1-notes-cross-user` and `npx notyours replay b3-export-plan-gate` would check. The README still lists the three seeded bugs as present.

You need to choose one:
- **Keep the fixes (my recommendation):** I change those 4 tests to expect 404 and 403, and update the README and the B1/B3 expected results. That needs your go-ahead, since the hook said not to edit tests.
- **Keep the deliberately vulnerable demo:** I put the bugs back, and B1 and B3 will keep reporting leaks.

Nothing is committed.
