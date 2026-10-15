---
description: I've confirmed this works — open and merge its PR, then delete the task
argument-hint: [note for the PR]
---

I've checked the result and this work is finished. This is `/tt:prm` plus
removing the task from towles-tool. Report any `STOP:` line, refusal or
error verbatim and stop: don't work around it, don't hunt for a task id, and
never fall back to `task_delete`.

1. **Land it:** invoke the `tt:prm` skill and follow it to the end. That
   covers committing, opening and merging the PR, with an admin merge if
   protection blocks. A PR that had already merged counts as landed. The
   one stop to carry on past is "has no PR" when `state` showed nothing
   uncommitted and no commits ahead: there was no work to land, and
   `task_done` judges the rest. If the `tt` plugin isn't installed, tell me
   and stop.
2. **Finish the task:** call the `task_done` MCP tool with `dir` set to
   `git rev-parse --show-toplevel` and `summary` set to a few lines on what
   shipped (PR number, merge commit, anything still open). Say everything
   you need to tell me before this call: on success it removes this
   session's own pane.
3. If `task_done` says no task is bound to this checkout, the work is landed
   and there's nothing to delete. Tell me that, and that's the end.

$ARGUMENTS
