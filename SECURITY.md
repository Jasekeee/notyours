# Security policy

## Supported versions

Only the latest release receives security fixes. Right now that is **0.2.1** (0.2.x).
Older tags are kept for history but are not patched.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub's private vulnerability reporting:
go to the repository's **Security** tab, choose **Report a vulnerability**, and describe the problem.
Include:

- the notyours version (`npx github:Jasekeee/notyours --version`) and the Node and kane-cli versions;
- the smallest steps to reproduce, using a local app and test accounts only;
- what you expected and what happened.

Remove real emails, passwords, tokens, account IDs and Kane share links from anything you send.
notyours already redacts these in its own output, but please check yours.

We aim to acknowledge a report within 7 days and to agree a fix and disclosure date with you.

## Scope

In scope: notyours code, its CLI, its Claude Code hooks, its oracle verdicts, and the files it writes
(`.notyours/`, reports, recordings handling).

Known limits that are documented rather than bugs (see `docs/STATUS.md`):

- The guard for coding agents is a guardrail for a cooperating agent, not a sandbox. It decides by matching Bash
  command text, so a determined agent with shell access can find spellings it does not anticipate.
- notyours only tests apps on hosts you have allowed. Non-local hosts need an explicit host approval.
- Kane recordings hold TestMu account IDs and are kept local (`.notyours/tests/` is gitignored).

Out of scope: vulnerabilities in your own application under test, in Kane CLI itself (report those to TestMu AI),
and in Claude Code.
