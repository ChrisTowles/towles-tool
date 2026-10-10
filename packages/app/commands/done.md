---
description: I've confirmed this task works — land its PR and delete the task
argument-hint: [task id] [note for the PR]
---

I've checked the result and this task is complete. Finish it so nothing is left
behind: a task that shows done on the board but still has its worktree and
terminal pane is the failure this command exists to prevent.

1. **Find the task.** Use the id in the arguments if given. Otherwise match this
   session's worktree (`git rev-parse --show-toplevel`) against `task_list`.
   A task whose PR already merged is closed and missing from `task_list`, so
   if there's no match ask me for the id rather than guessing.
2. **Rewrite the PR description** (`gh pr edit --body`) to describe what
   finally shipped and that I verified it. Drop caveats that no longer apply
   and keep the repo's attribution footer. If the PR is already merged, still
   rewrite it.
3. **Merge it** if it's open, the same way this repo's recent PRs landed
   (merge commit or squash). If checks fail or it conflicts, stop and tell me.
4. **Check nothing is stranded.** After `git fetch`, the worktree must be
   clean and `git log origin/<default>..HEAD` must be empty, unless every
   commit it lists is in the merged PR (squash merges rewrite them).
5. **`task_summary`**: a few lines on what shipped, since the card outlives
   the worktree.
6. **`task_delete`** with `outcome: "done"`, as the final call. It removes this
   session's own pane, so put everything you need to tell me before it. If it
   refuses, report the reasons and stop; never pass `force` unless I say so.

$ARGUMENTS
