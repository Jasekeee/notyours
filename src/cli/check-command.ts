// Copy of .claude/commands/notyours-check.md, installed into user projects by `notyours setup claude`.
// Keep in sync: the test in cli.test.ts fails if the two differ.
export const CHECK_COMMAND_MD = `---
description: Check the app's isolation boundaries (0 Kane credits): replay the locked ones and explain any leak
argument-hint: "[boundary id filter]"
---

You are checking whether this app's isolation boundaries still hold. Replays cost 0 Kane credits.

Filter (optional): $ARGUMENTS

## Steps

1. Run \`npx github:Jasekeee/notyours\` (no arguments). It prints what is configured, what is locked and the single next command.
2. If nothing is locked yet, say so and stop: the user proves boundaries with \`npx github:Jasekeee/notyours run\` (about 30 Kane credits each) and locks them with \`npx github:Jasekeee/notyours lock\`.
3. Otherwise run \`npx github:Jasekeee/notyours replay\` (add the filter ids if given). Read the verdicts: HELD, LEAK_VISIBLE, LEAK_PAYLOAD or HARNESS_BROKEN.
4. For each LEAK, read the boundary's \`surface\` files and the report (\`npx github:Jasekeee/notyours report\`). Say which check is missing (ownership, plan gate, auth) and fix the app code, not the boundary.
5. After a fix, run \`npx github:Jasekeee/notyours replay\` again and report the new verdicts in a table: boundary, verdict, credits.

## Rules

- Never edit locked boundaries, recordings, \`.notyours/runs\`, \`config.yaml\` or the budget. The guard hook blocks them.
- Do not run \`run\` or \`lock --reauthor\` without asking: they spend Kane credits.
- Do not read \`.notyours/secrets.json\` or the browser profiles.
`;
