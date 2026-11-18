I fixed the B3 leak on the server. `POST /api/export` now returns `403 {"error":"export requires Jotter Pro"}` to any user who isn't on the Pro plan. The check runs before any notes are loaded, so the error response contains no note data. Pro users still get both text and CSV exports, and those tests pass.

I haven't run a notyours replay myself. The stop hook will re-check the boundary, or you can run `npx notyours replay b3-export-plan-gate`.

As the hook asked, I didn't edit any tests, so two now fail because they expect the old behaviour:
- **`SEEDED BUG #3: free Bob … works anyway`** expects Bob's POST to return `200`. It now gets `403`.
- **`quotes commas, quotes and newlines…`** is one of the CSV tests I added earlier. It used a newly signed-up free user, so it also gets `403` now. The CSV quoting logic itself is unchanged.

The other failures were already there before my change: the bug #1 and #2 tests (left over from the earlier owner-check fix) and `test/boundaries.test.js`, which fails before any of its tests run.

This fix, together with the earlier one in commit `2e268e8`, takes away all three of the bugs the README describes as deliberate for the notyours demo. If Jotter still needs to be the leaky demo app, you may want to revert these fixes rather than keep them.

If you keep the fixes, I can update the two tests: change the bug #3 test to expect `403`, and have the CSV quoting test use a Pro account. Nothing is committed.
