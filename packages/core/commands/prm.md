---
description: Open a PR for this work and merge it, as an admin if protection blocks
argument-hint: [note for the PR]
---

Open and merge a pull request for the work in this checkout. Running this
command is my permission for an admin merge: `pr.sh merge` retries once with
`--admin` when branch protection refuses, though checks still have to pass.
If any step prints `STOP:`, tell me that line and its `FIX:` line and stop.

1. Follow `/tt:pr`'s steps: `bash ${CLAUDE_PLUGIN_ROOT}/scripts/pr.sh state`,
   then `pr.sh branch` if on the default branch, commit what belongs, write
   the body file and run `pr.sh open`. If `state` shows nothing
   uncommitted and either no commits ahead or a PR that already merged,
   there's nothing to land: skip to step 3, which reports a merged PR or
   stops with "no PR" for you to pass on.
2. Rewrite the body file to describe what finally shipped (keep the
   attribution footer).
3. `bash ${CLAUDE_PLUGIN_ROOT}/scripts/pr.sh merge --body-file <file>` with a
   10-minute Bash timeout: it waits for checks. If the Bash call times out,
   run the same command again; it picks up where it was.
4. Tell me the PR number, the merge commit, and the script's `local:` or
   `note:` lines.

$ARGUMENTS
