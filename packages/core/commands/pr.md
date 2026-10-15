---
description: Open a PR for this work, or update the one that's open
argument-hint: [note for the PR]
---

Open a pull request for the work in this checkout. The mechanics are
`${CLAUDE_PLUGIN_ROOT}/scripts/pr.sh`; your part is the words and choosing
which files belong. Run every step through it, and if it prints `STOP:`,
tell me that line and its `FIX:` line and stop. Don't work around it.

1. `bash ${CLAUDE_PLUGIN_ROOT}/scripts/pr.sh state`.
2. If `on-default: yes`, name a branch after the work (`feat/…`, `fix/…`)
   and run `pr.sh branch <name>`. Uncommitted changes come along.
3. Commit the uncommitted files that belong to this work with `git add
   <files>` and `git commit`. Leave out anything unrelated to it, such as a
   settings file you didn't touch for this. Skip if nothing is uncommitted.
4. Write the PR body to a file in your scratchpad: what changed and why,
   how it was verified, and the repo's attribution footer. Then run
   `pr.sh open --title "<title>" --body-file <file>`. It pushes, targets a
   stacked parent branch when there is one, and creates or updates the PR.
5. Tell me the PR URL and any files it lists as left uncommitted.

$ARGUMENTS
