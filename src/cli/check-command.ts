// Copy of .claude/commands/notyours-check.md, installed into user projects by `notyours setup claude`.
// Keep in sync: the test in cli.test.ts fails if the two differ.
export const CHECK_COMMAND_MD = `---
description: Check the app's isolation boundaries (no authoring runs): replay the locked ones and explain any leak
argument-hint: "[boundary id filter]"
---

You are checking whether this app's isolation boundaries still hold. Replays need no authoring runs: about 0–1 Kane credit and ~40–50 s per boundary on kane-cli 0.10.0.

Filter (optional): $ARGUMENTS

## Steps

1. Run \`npx notyours\` (no arguments). It prints what is configured, what is locked and the single next command.
2. If nothing is locked yet, say so and stop: the user proves boundaries with \`npx notyours run\` (about 30 Kane credits each) and locks them with \`npx notyours lock\`.
3. Otherwise run \`npx notyours replay\` (add the filter ids if given). Read the verdicts: HELD, LEAK_VISIBLE, LEAK_PAYLOAD or HARNESS_BROKEN.
4. For each LEAK, read the boundary's \`surface\` files and the report (\`npx notyours report\`). Say which check is missing (ownership, plan gate, auth) and fix the app code, not the boundary.
5. After a fix, run \`npx notyours replay\` again and report the new verdicts in a table: boundary, verdict, credits.

## Rules

- Never edit locked boundaries, recordings, \`.notyours/runs\`, \`config.yaml\` or the budget. The guard hook blocks them.
- Do not run \`run\` or \`lock --reauthor\` without asking: they spend Kane credits.
- Do not read \`.notyours/secrets.json\` or the browser profiles.
`;
